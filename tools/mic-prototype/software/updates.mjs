import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, stat, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';

const MAX_ASSET_BYTES = 2 * 1024 ** 3;
const MAX_ARCHIVE_BYTES = 16 * 1024 ** 3;
const MAX_TOTAL_BYTES = 32 * 1024 ** 3;
const GITHUB_HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const COMPONENT_TARGETS = new Map([['python', 'runtime/python'], ['whisper-large-v3', 'models/large-v3'], ['speaker-campp', 'models/speaker'], ['codex-cli', 'runtime/codex']]);
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && !value.includes('..');
const safeRepository = value => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !value.includes('..');
const sha = value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
const digestOf = value => typeof value === 'string' && /^sha256:[a-fA-F0-9]{64}$/.test(value) ? value.slice(7).toLowerCase() : null;
const integerBytes = (value, limit = MAX_ASSET_BYTES) => Number.isSafeInteger(value) && value > 0 && value <= limit;
const safeRelative = value => typeof value === 'string' && value.length <= 240 && value.split('/').every(part =>
  /^[A-Za-z0-9_.+-]{1,160}$/.test(part) && part !== '.' && part !== '..' && !part.endsWith('.')
  && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) && !/[\\:]/.test(value);

export function safeUpdateError(error) {
  return /^[a-z][a-z0-9_]{0,99}$/.test(error?.safeCode ?? '') ? error.safeCode : 'software_update_failed';
}

export function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) fail('update_version_invalid');
  return value.split('.').map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export function validateReleaseConfig(value) {
  if (!value || value.schemaVersion !== 1 || !safeRepository(value.repository) || value.channel !== 'stable'
    || !safeName(value.appAsset) || !safeName(value.componentsManifestAsset)) fail('update_release_config_invalid');
  parseVersion(value.version);
  if (value.componentsReleaseTag !== undefined) {
    if (typeof value.componentsReleaseTag !== 'string') fail('update_release_config_invalid');
    parseVersion(value.componentsReleaseTag.replace(/^v/, ''));
  }
  if (value.appAsset !== `BilibiliSubtitle-${value.version}-win-x64.zip` || !/^components-[A-Za-z0-9._-]+\.json$/.test(value.componentsManifestAsset)) fail('update_release_config_invalid');
  return { schemaVersion: 1, version: value.version, repository: value.repository, channel: 'stable',
    appAsset: value.appAsset, componentsManifestAsset: value.componentsManifestAsset,
    componentsReleaseTag: value.componentsReleaseTag ?? `v${value.version}` };
}

function checkUrl(value, { testsOnly } = {}) {
  let url;
  try { url = new URL(value); } catch { fail('update_url_rejected'); }
  const testLoopback = testsOnly?.allowLoopback === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !(testLoopback || url.protocol === 'https:' && !url.port && GITHUB_HOSTS.has(url.hostname))) fail('update_url_rejected');
  return url.href;
}

async function withResponse(url, options, consume) {
  const fetchImpl = options.fetchImpl ?? fetch, controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) fail('update_timeout_invalid');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    let current = checkUrl(url, options);
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: options.accept ?? 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'BilibiliSubtitle-Updater/1',
          ...(new URL(current).hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}) } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (response.body) await response.body.cancel();
        if (!location || redirects >= 4) fail('update_redirect_rejected');
        current = checkUrl(new URL(location, current).href, options);
        continue;
      }
      if (response.status === 403 || response.status === 429) fail('github_rate_limited');
      if (response.status === 404) fail('github_release_not_found');
      if (response.status !== 200) fail('update_http_failed');
      return await consume(response);
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') fail('update_request_timeout');
    if (error?.safeCode) throw error;
    fail('update_network_failed');
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

async function readResponse(response, maxBytes, expectedBytes = null) {
  const header = response.headers.get('content-length');
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > maxBytes || expectedBytes !== null && Number(header) !== expectedBytes)) fail('update_download_size_invalid');
  const chunks = []; let bytes = 0;
  if (!response.body) fail('update_download_empty');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes || expectedBytes !== null && bytes > expectedBytes) fail('update_download_size_invalid');
    chunks.push(chunk);
  }
  if (expectedBytes !== null && bytes !== expectedBytes) fail('update_download_size_invalid');
  return Buffer.concat(chunks, bytes);
}

async function readJson(url, options, maxBytes = 2 * 1024 ** 2) {
  return withResponse(url, { ...options, accept: 'application/vnd.github+json' }, async response => {
    const bytes = await readResponse(response, maxBytes);
    try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('update_json_invalid'); }
  });
}

function validateAsset(value, config, tagName) {
  if (!value || !safeName(value.name) || value.state !== 'uploaded' || !integerBytes(value.size) || !digestOf(value.digest)) fail('update_asset_invalid');
  const url = checkUrl(value.browser_download_url);
  const expectedPath = `/${config.repository}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(value.name)}`;
  if (new URL(url).hostname !== 'github.com' || new URL(url).pathname !== expectedPath || new URL(url).search) fail('update_asset_url_invalid');
  return { name: value.name, bytes: value.size, sha256: digestOf(value.digest), url };
}

export function validateRelease(value, config, { requireApp = true } = {}) {
  if (!value || value.draft !== false || value.prerelease !== false || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)
    || value.assets.length > 200) fail('update_release_invalid');
  const version = value.tag_name.startsWith('v') ? value.tag_name.slice(1) : value.tag_name;
  parseVersion(version);
  const assets = new Map();
  for (const asset of value.assets) {
    // A release may contain unrelated assets, but selected assets are always validated strictly.
    if (typeof asset?.name !== 'string') fail('update_release_invalid');
    if (assets.has(asset.name)) fail('update_asset_duplicate');
    assets.set(asset.name, asset);
  }
  const appName = `BilibiliSubtitle-${version}-win-x64.zip`;
  if (requireApp && !assets.has(appName)) fail('update_app_asset_missing');
  const app = assets.has(appName) ? validateAsset(assets.get(appName), config, value.tag_name) : null;
  const componentsManifest = assets.has(config.componentsManifestAsset)
    ? validateAsset(assets.get(config.componentsManifestAsset), config, value.tag_name) : null;
  return { version, tagName: value.tag_name, repository: config.repository, app, componentsManifest,
    releaseUrl: `https://github.com/${config.repository}/releases/tag/${encodeURIComponent(value.tag_name)}`,
    updateAvailable: compareVersions(version, config.version) > 0, assets,
    notes: typeof value.body === 'string' ? value.body.slice(0, 12000) : '' };
}

export async function checkForUpdate(config, options = {}) {
  const validated = validateReleaseConfig(config);
  const value = await readJson(`https://api.github.com/repos/${validated.repository}/releases/latest`, options);
  return validateRelease(value, validated);
}

export async function getComponentsRelease(config, options = {}) {
  const validated = validateReleaseConfig(config);
  const value = await readJson(`https://api.github.com/repos/${validated.repository}/releases/tags/${encodeURIComponent(validated.componentsReleaseTag)}`, options);
  if (value?.tag_name !== validated.componentsReleaseTag) fail('update_components_release_mismatch');
  return validateRelease(value, validated, { requireApp: false });
}

async function rejectLink(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('update_data_directory_invalid');
}

async function createAttempt(dataRoot) {
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot) || /[\u0000-\u001f]/.test(dataRoot)) fail('update_data_directory_invalid');
  const root = resolve(dataRoot);
  await mkdir(root, { recursive: true });
  await rejectLink(root);
  const updates = join(root, 'updates');
  await mkdir(updates, { recursive: true });
  await rejectLink(updates);
  const directory = join(updates, randomUUID());
  await mkdir(directory);
  return directory;
}

async function writeChunk(file, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
    if (bytesWritten < 1) fail('update_write_failed');
    offset += bytesWritten;
  }
}

async function downloadAsset(asset, destination, options, onProgress) {
  const partial = `${destination}.part`, hash = createHash('sha256');
  let bytes = 0, handle;
  try {
    handle = await open(partial, 'wx', 0o600);
    await withResponse(asset.url, { ...options, timeoutMs: options.downloadTimeoutMs ?? 1800000 }, async response => {
      const header = response.headers.get('content-length');
      if (header !== null && (!/^\d+$/.test(header) || Number(header) !== asset.bytes)) fail('update_download_size_invalid');
      if (!response.body) fail('update_download_empty');
      let lastProgress = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > asset.bytes || bytes > MAX_ASSET_BYTES) fail('update_download_size_invalid');
        hash.update(chunk); await writeChunk(handle, chunk);
        if (bytes === asset.bytes || Date.now() - lastProgress >= 250) {
          onProgress?.({ asset: asset.name, bytes, totalBytes: asset.bytes }); lastProgress = Date.now();
        }
      }
    });
    if (bytes !== asset.bytes) fail('update_download_size_invalid');
    if (hash.digest('hex') !== asset.sha256) fail('update_download_sha256_mismatch');
    await handle.sync(); await handle.close(); handle = null;
    await rename(partial, destination);
    return { zipPath: destination, bytes, sha256: asset.sha256 };
  } finally { if (handle) await handle.close(); }
}

async function writePlan(directory, plan) {
  const planPath = join(directory, 'plan.json');
  const file = await open(planPath, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(plan, null, 2) + '\n', 'utf8'); await file.sync(); } finally { await file.close(); }
  return planPath;
}

export async function downloadApp(config, release, { dataRoot, onProgress, ...options } = {}) {
  if (release.repository !== config.repository || compareVersions(release.version, config.version) <= 0) fail('update_no_new_version');
  const directory = await createAttempt(dataRoot);
  const file = await downloadAsset(release.app, join(directory, 'app.zip'), options, onProgress);
  const plan = { schemaVersion: 1, kind: 'app', version: release.version, repository: config.repository, ...file };
  return { planPath: await writePlan(directory, plan), ...plan };
}

export function validateComponentsManifest(value, config, release) {
  if (!value || value.schemaVersion !== 1 || value.repository !== config.repository || value.releaseVersion !== release.version
    || !Array.isArray(value.components) || value.components.length < 1 || value.components.length > COMPONENT_TARGETS.size) fail('update_components_manifest_invalid');
  const ids = new Set(); let totalBytes = 0;
  const components = value.components.map(component => {
    if (!component || !COMPONENT_TARGETS.has(component.id) || ids.has(component.id) || component.target !== COMPONENT_TARGETS.get(component.id)
      || !safeName(component.version) || !['zip', 'split-zip'].includes(component.format)
      || !integerBytes(component.archiveBytes, MAX_ARCHIVE_BYTES) || !sha(component.archiveSha256)
      || !integerBytes(component.expandedBytes, MAX_TOTAL_BYTES)
      || !Array.isArray(component.requiredFiles) || component.requiredFiles.length < 1 || component.requiredFiles.length > 500
      || component.requiredFiles.some(path => !safeRelative(path)) || new Set(component.requiredFiles.map(path => path.toLowerCase())).size !== component.requiredFiles.length) fail('update_components_manifest_invalid');
    ids.add(component.id);
    let parts;
    if (component.format === 'zip') {
      if (!safeName(component.fileName) || !component.fileName.endsWith('.zip') || !integerBytes(component.bytes) || !sha(component.sha256)
        || component.archiveBytes !== component.bytes || component.archiveSha256.toLowerCase() !== component.sha256.toLowerCase()) fail('update_components_manifest_invalid');
      parts = [{ name: component.fileName, bytes: component.bytes, sha256: component.sha256.toLowerCase() }];
    } else {
      if (!Array.isArray(component.parts) || component.parts.length < 2 || component.parts.length > 64) fail('update_components_manifest_invalid');
      parts = component.parts.map(part => {
        if (!part || !safeName(part.name) || !integerBytes(part.bytes) || !sha(part.sha256)) fail('update_components_manifest_invalid');
        return { name: part.name, bytes: part.bytes, sha256: part.sha256.toLowerCase() };
      });
      if (new Set(parts.map(part => part.name.toLowerCase())).size !== parts.length || parts.reduce((sum, part) => sum + part.bytes, 0) !== component.archiveBytes) fail('update_components_manifest_invalid');
    }
    totalBytes += component.archiveBytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail('update_components_manifest_invalid');
    for (const part of parts) {
      const asset = release.assets.get(part.name);
      if (!asset) fail('update_component_asset_missing');
      const validated = validateAsset(asset, config, release.tagName);
      if (validated.bytes !== part.bytes || validated.sha256 !== part.sha256) fail('update_component_asset_mismatch');
    }
    // Project known fields only; untrusted manifest properties never reach the installer plan.
    return { id: component.id, version: component.version, format: component.format, target: component.target,
      archiveBytes: component.archiveBytes, archiveSha256: component.archiveSha256.toLowerCase(), expandedBytes: component.expandedBytes,
      requiredFiles: [...component.requiredFiles], ...(component.format === 'zip'
        ? { fileName: component.fileName, bytes: component.bytes, sha256: component.sha256.toLowerCase() }
        : { parts }) };
  });
  return components;
}

async function concatenateParts(parts, destination, expectedBytes, expectedSha) {
  const output = await open(`${destination}.part`, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0;
  try {
    for (const path of parts) {
      const input = await open(path, 'r');
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          bytes += chunk.length;
          if (bytes > expectedBytes) fail('update_download_size_invalid');
          hash.update(chunk); await writeChunk(output, chunk);
        }
      } finally { await input.close(); }
    }
    if (bytes !== expectedBytes) fail('update_download_size_invalid');
    if (hash.digest('hex') !== expectedSha) fail('update_download_sha256_mismatch');
    await output.sync();
  } finally { await output.close(); }
  await rename(`${destination}.part`, destination);
}

export async function downloadComponents(config, release, { dataRoot, onProgress, ...options } = {}) {
  if (!release.componentsManifest || release.repository !== config.repository) fail('update_components_manifest_missing');
  const asset = release.componentsManifest;
  if (asset.bytes > 1024 ** 2) fail('update_components_manifest_invalid');
  const raw = await withResponse(asset.url, options, response => readResponse(response, 1024 ** 2, asset.bytes));
  if (createHash('sha256').update(raw).digest('hex') !== asset.sha256) fail('update_download_sha256_mismatch');
  let value;
  try { value = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('update_json_invalid'); }
  const components = validateComponentsManifest(value, config, release), directory = await createAttempt(dataRoot), prepared = [];
  for (const component of components) {
    const folder = join(directory, component.id); await mkdir(folder);
    const parts = component.format === 'zip' ? [{ name: component.fileName }] : component.parts;
    const paths = [];
    for (let index = 0; index < parts.length; index++) {
      const validated = validateAsset(release.assets.get(parts[index].name), config, release.tagName), path = join(folder, `part-${index}.bin`);
      await downloadAsset(validated, path, options, progress => onProgress?.({ component: component.id, ...progress })); paths.push(path);
    }
    const zipPath = join(folder, 'component.zip');
    if (paths.length === 1) await rename(paths[0], zipPath);
    else await concatenateParts(paths, zipPath, component.archiveBytes, component.archiveSha256);
    prepared.push({ ...component, zipPath });
  }
  const plan = { schemaVersion: 1, kind: 'components', version: release.version, repository: config.repository, components: prepared };
  return { planPath: await writePlan(directory, plan), ...plan };
}

export async function runUpdateCommand({ packageRoot, dataRoot, command }, { emit = () => {}, ...options } = {}) {
  if (!['check', 'download-app', 'download-components'].includes(command) || typeof packageRoot !== 'string' || !isAbsolute(packageRoot)
    || /[\u0000-\u001f]/.test(packageRoot)) fail('update_arguments_invalid');
  const configPath = join(resolve(packageRoot), 'software-release.json'), info = await stat(configPath).catch(() => null);
  if (!info?.isFile() || info.size > 16384) fail('update_release_config_missing');
  let raw;
  try { raw = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); } catch { fail('update_release_config_invalid'); }
  const config = validateReleaseConfig(raw);
  emit({ event: 'progress', command, phase: 'checking' });
  const release = command === 'download-components' ? await getComponentsRelease(config, options) : await checkForUpdate(config, options);
  const summary = { currentVersion: config.version, latestVersion: release.version, updateAvailable: release.updateAvailable,
    repository: config.repository, componentsAvailable: release.componentsManifest !== null, releaseUrl: release.releaseUrl, notes: release.notes };
  let result = summary;
  if (command !== 'check') {
    const settings = { ...options, dataRoot, onProgress: progress => emit({ event: 'progress', command, phase: 'downloading', ...progress }) };
    result = command === 'download-app' ? await downloadApp(config, release, settings) : await downloadComponents(config, release, settings);
  }
  const complete = { event: 'complete', command, ...result };
  emit(complete); return complete;
}
