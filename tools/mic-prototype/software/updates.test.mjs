import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkForUpdate, compareVersions, downloadApp, downloadComponents, getComponentsRelease, parseVersion,
  runUpdateCommand, safeUpdateError, validateComponentsManifest, validateRelease, validateReleaseConfig } from './updates.mjs';
import { parseUpdateArguments } from './update-cli.mjs';

const repository = 'humerus-sketch/streamer-bilingual-subtitles';
const config = { schemaVersion: 1, version: '0.1.0', repository, channel: 'stable',
  appAsset: 'BilibiliSubtitle-0.1.0-win-x64.zip', componentsManifestAsset: 'components-1.json', componentsReleaseTag: 'v0.1.0' };
const hash = value => createHash('sha256').update(value).digest('hex');
const appBytes = Buffer.from('verified-app-test-zip');
function asset(name, bytes, version = '0.1.1') {
  return { name, size: bytes.length, state: 'uploaded', digest: `sha256:${hash(bytes)}`,
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}` };
}
function release({ version = '0.1.1', assets = [], ...overrides } = {}) {
  return { draft: false, prerelease: false, tag_name: `v${version}`, body: '测试更新',
    assets: [asset(`BilibiliSubtitle-${version}-win-x64.zip`, appBytes, version), ...assets], ...overrides };
}
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fetchFixture(metadata, content = new Map(), calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://api.github.com/')) return jsonResponse(metadata);
    if (!content.has(url)) throw new Error('unexpected fixture URL');
    const value = content.get(url);
    return value instanceof Response ? value : new Response(value, { headers: { 'content-length': String(value.length) } });
  };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'subtitle-updater-test-'));
  t.after(() => rm(directory, { force: true, recursive: true })); return directory;
}
async function filesBelow(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await filesBelow(path)); else results.push(path);
  }
  return results;
}
function componentFixture({ split = false, manifestVersion = '0.1.0' } = {}) {
  const partBytes = [Buffer.from('archive-'), Buffer.from('payload')], archive = Buffer.concat(partBytes);
  const component = { id: 'python', version: '3.12.13-win-x64-pinned-20261018', format: split ? 'split-zip' : 'zip',
    target: 'runtime/python', archiveBytes: archive.length, archiveSha256: hash(archive), expandedBytes: 1024,
    requiredFiles: ['python.exe', 'Lib/site-packages/module/__init__.py'],
    ...(split ? { parts: partBytes.map((bytes, index) => ({ name: `python.zip.part${index + 1}`, bytes: bytes.length, sha256: hash(bytes) })) }
      : { fileName: 'python.zip', bytes: archive.length, sha256: hash(archive) }) };
  const manifest = { schemaVersion: 1, releaseVersion: manifestVersion, repository,
    archiveRoot: 'component-contents-relative-to-target', splitZipJoin: 'concatenate-parts-in-listed-order', components: [component] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const assets = [asset(config.componentsManifestAsset, manifestBytes, manifestVersion), ...(split
    ? partBytes.map((bytes, index) => asset(`python.zip.part${index + 1}`, bytes, manifestVersion))
    : [asset('python.zip', archive, manifestVersion)])];
  const metadata = release({ version: manifestVersion, assets });
  const content = new Map([[assets[0].browser_download_url, manifestBytes]]);
  assets.slice(1).forEach((item, index) => content.set(item.browser_download_url, split ? partBytes[index] : archive));
  return { manifest, metadata, content, archive, component };
}

test('strict stable semantic versions compare numerically and reject alternate forms', () => {
  assert.deepEqual(parseVersion('10.2.3'), [10, 2, 3]);
  assert.equal(compareVersions('0.10.0', '0.2.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '1.0.0'), -1);
  for (const value of ['v0.1.0', '01.1.0', '1.2', '1.2.3-beta', '1.2.3+meta', '../1.2.3', '1.2.3\n']) assert.throws(() => parseVersion(value));
});

test('release config is machine-independent and rejects unsafe repository, asset or channel', () => {
  assert.equal(validateReleaseConfig(config).componentsReleaseTag, 'v0.1.0');
  assert.equal(validateReleaseConfig({ ...config, componentsReleaseTag: undefined }).componentsReleaseTag, 'v0.1.0');
  for (const changes of [{ repository: '../evil' }, { repository: 'owner/repo?token=x' }, { appAsset: '../app.zip' },
    { appAsset: 'BilibiliSubtitle-0.1.1-win-x64.zip' }, { channel: 'preview' }, { componentsManifestAsset: 'https://evil/a' },
    { componentsReleaseTag: 'v0.1.0-beta' }]) assert.throws(() => validateReleaseConfig({ ...config, ...changes }));
});

test('check uses public latest endpoint, follows no implicit redirect, and sends no authorization', async () => {
  const calls = [], result = await checkForUpdate(config, { fetchImpl: fetchFixture(release(), new Map(), calls) });
  assert.equal(result.updateAvailable, true); assert.equal(result.version, '0.1.1');
  assert.equal(calls[0].url, `https://api.github.com/repos/${repository}/releases/latest`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(Object.keys(calls[0].options.headers).some(key => /authorization|cookie/i.test(key)), false);
});

test('same and older release are not offered as an app upgrade', () => {
  assert.equal(validateRelease(release({ version: '0.1.0' }), config).updateAvailable, false);
  assert.equal(validateRelease(release({ version: '0.0.9' }), config).updateAvailable, false);
});

test('draft, prerelease, missing digest, incorrect architecture and duplicate asset are rejected', () => {
  for (const value of [release({ draft: true }), release({ prerelease: true }), release({ tag_name: 'v0.1.1-beta' }),
    { ...release(), assets: [] }, { ...release(), assets: [asset('BilibiliSubtitle-0.1.1-win-arm64.zip', appBytes)] }])
    assert.throws(() => validateRelease(value, config));
  const missing = release(); delete missing.assets[0].digest; assert.throws(() => validateRelease(missing, config), /update_asset_invalid/);
  const duplicated = release(); duplicated.assets.push(duplicated.assets[0]); assert.throws(() => validateRelease(duplicated, config), /update_asset_duplicate/);
});

test('selected assets must belong to the same pinned repository and official GitHub download path', () => {
  for (const url of ['http://github.com/a.zip', 'https://evil.example/a.zip', 'https://github.com.evil.example/a.zip',
    `https://github.com/other/repo/releases/download/v0.1.1/BilibiliSubtitle-0.1.1-win-x64.zip`,
    `https://user:secret@github.com/${repository}/releases/download/v0.1.1/BilibiliSubtitle-0.1.1-win-x64.zip`]) {
    const value = release(); value.assets[0].browser_download_url = url;
    assert.throws(() => validateRelease(value, config));
  }
});

test('download-app verifies bytes and SHA before atomic final name and CreateNew plan', async t => {
  const directory = await temporary(t), metadata = release(), content = new Map([[metadata.assets[0].browser_download_url, appBytes]]), progress = [];
  const result = await downloadApp(config, validateRelease(metadata, config), { dataRoot: directory,
    fetchImpl: fetchFixture(metadata, content), onProgress: value => progress.push(value) });
  assert.deepEqual(await readFile(result.zipPath), appBytes); assert.equal(result.sha256, hash(appBytes));
  const plan = JSON.parse(await readFile(result.planPath, 'utf8'));
  assert.equal(plan.kind, 'app'); assert.equal(plan.repository, repository); assert.equal(plan.version, '0.1.1');
  assert.equal(progress.at(-1).bytes, appBytes.length);
  assert.equal((await filesBelow(directory)).some(path => path.endsWith('.part')), false);
  const second = await downloadApp(config, validateRelease(metadata, config), { dataRoot: directory, fetchImpl: fetchFixture(metadata, content) });
  assert.notEqual(result.planPath, second.planPath);
});

test('same or downgraded app cannot be downloaded or create a plan', async t => {
  const directory = await temporary(t);
  await assert.rejects(downloadApp(config, validateRelease(release({ version: '0.1.0' }), config), { dataRoot: directory }), /update_no_new_version/);
  assert.deepEqual(await readdir(directory), []);
});

test('download SHA mismatch keeps only partial file and never creates an install plan', async t => {
  const directory = await temporary(t), metadata = release();
  const wrong = Buffer.from('X'.repeat(appBytes.length));
  await assert.rejects(downloadApp(config, validateRelease(metadata, config), { dataRoot: directory,
    fetchImpl: fetchFixture(metadata, new Map([[metadata.assets[0].browser_download_url, wrong]])) }), /update_download_sha256_mismatch/);
  const files = await filesBelow(directory);
  assert.equal(files.some(path => path.endsWith('app.zip.part')), true);
  assert.equal(files.some(path => path.endsWith('app.zip') || path.endsWith('plan.json')), false);
});

test('truncated body, excessive length and non-200 partial HTTP response never activate download', async t => {
  for (const response of [new Response(appBytes.subarray(0, 3)), new Response(appBytes, { headers: { 'content-length': '999' } }),
    new Response(appBytes, { status: 206 })]) {
    const directory = await temporary(t), metadata = release();
    await assert.rejects(downloadApp(config, validateRelease(metadata, config), { dataRoot: directory,
      fetchImpl: fetchFixture(metadata, new Map([[metadata.assets[0].browser_download_url, response]])) }));
    assert.equal((await filesBelow(directory)).some(path => path.endsWith('plan.json')), false);
  }
});

test('asset larger than 2 GiB is rejected before download begins', () => {
  const value = release(); value.assets[0].size = 2 * 1024 ** 3 + 1;
  assert.throws(() => validateRelease(value, config), /update_asset_invalid/);
});

test('untrusted redirect and redirect loops are blocked without contacting their destination', async () => {
  let calls = 0;
  await assert.rejects(checkForUpdate(config, { fetchImpl: async () => { calls++; return new Response(null,
    { status: 302, headers: { location: 'https://evil.example/private?token=secret' } }); } }), /update_url_rejected/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(checkForUpdate(config, { fetchImpl: async () => { calls++; return new Response(null,
    { status: 302, headers: { location: `https://api.github.com/repos/${repository}/releases/latest` } }); } }), /update_redirect_rejected/);
  assert.equal(calls, 5);
});

test('403, 404 and transport errors expose safe codes rather than response secrets', async () => {
  for (const [status, code] of [[403, 'github_rate_limited'], [429, 'github_rate_limited'], [404, 'github_release_not_found'], [500, 'update_http_failed']]) {
    await assert.rejects(checkForUpdate(config, { fetchImpl: async () => new Response('private-token-123', { status }) }), new RegExp(code));
  }
  await assert.rejects(checkForUpdate(config, { fetchImpl: async () => { throw new Error('private-token-123'); } }), /update_network_failed/);
  assert.equal(safeUpdateError(new Error('private-token-123')), 'software_update_failed');
});

test('request timeout aborts an outstanding metadata request', async () => {
  await assert.rejects(checkForUpdate(config, { timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('private request'), { name: 'AbortError' })), { once: true });
  }) }), /update_request_timeout/);
});

test('loopback asset redirect is rejected by default and enabled only by explicit test injection', async t => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-length': appBytes.length }); response.end(appBytes); });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => server.close(done)));
  const localUrl = `http://127.0.0.1:${server.address().port}/asset`, metadata = release();
  const fetchImpl = (url, options) => url.startsWith('https://github.com/')
    ? Promise.resolve(new Response(null, { status: 302, headers: { location: localUrl } })) : fetch(url, options);
  await assert.rejects(downloadApp(config, validateRelease(metadata, config), { dataRoot: await temporary(t), fetchImpl }), /update_url_rejected/);
  const result = await downloadApp(config, validateRelease(metadata, config), { dataRoot: await temporary(t), fetchImpl, testsOnly: { allowLoopback: true } });
  assert.deepEqual(await readFile(result.zipPath), appBytes);
});

test('component manifest and every component asset are bound to GitHub digest and fixed target', () => {
  const fixture = componentFixture(), targetRelease = validateRelease(fixture.metadata, config);
  assert.equal(validateComponentsManifest(fixture.manifest, config, targetRelease)[0].version, '3.12.13-win-x64-pinned-20261018');
  for (const changes of [{ target: '../../outside' }, { id: 'unknown' }, { requiredFiles: ['../python.exe'] },
    { requiredFiles: ['python.exe', 'PYTHON.exe'] }, { sha256: 'a'.repeat(64) }, { archiveBytes: 1 }, { expandedBytes: 0 }]) {
    const value = structuredClone(fixture.manifest); Object.assign(value.components[0], changes);
    assert.throws(() => validateComponentsManifest(value, config, targetRelease));
  }
  const wrongAsset = structuredClone(fixture.metadata); wrongAsset.assets[2].digest = `sha256:${'b'.repeat(64)}`;
  assert.throws(() => validateComponentsManifest(fixture.manifest, config, validateRelease(wrongAsset, config)), /update_component_asset_mismatch/);
});

test('single component ZIP produces projected installer plan and leaves target settings untouched', async t => {
  const directory = await temporary(t), fixture = componentFixture();
  await mkdir(join(directory, 'settings')); await writeFile(join(directory, 'settings', 'preserved.txt'), 'original');
  const result = await downloadComponents(config, validateRelease(fixture.metadata, config), { dataRoot: directory,
    fetchImpl: fetchFixture(fixture.metadata, fixture.content) });
  assert.deepEqual(await readFile(result.components[0].zipPath), fixture.archive);
  assert.equal(result.components[0].target, 'runtime/python');
  assert.equal(await readFile(join(directory, 'settings', 'preserved.txt'), 'utf8'), 'original');
  assert.equal(JSON.parse(await readFile(result.planPath, 'utf8')).kind, 'components');
  assert.equal(result.components[0].archiveRoot, undefined);
});

test('split ZIP concatenates listed parts before verifying whole archive SHA', async t => {
  const fixture = componentFixture({ split: true });
  const result = await downloadComponents(config, validateRelease(fixture.metadata, config), { dataRoot: await temporary(t),
    fetchImpl: fetchFixture(fixture.metadata, fixture.content) });
  assert.deepEqual(await readFile(result.components[0].zipPath), fixture.archive);
  const wrongManifest = structuredClone(fixture.manifest); wrongManifest.components[0].archiveSha256 = 'a'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(wrongManifest)), metadata = structuredClone(fixture.metadata);
  metadata.assets[1] = asset(config.componentsManifestAsset, bytes, '0.1.0');
  const content = new Map(fixture.content); content.set(metadata.assets[1].browser_download_url, bytes);
  const directory = await temporary(t);
  await assert.rejects(downloadComponents(config, validateRelease(metadata, config), { dataRoot: directory, fetchImpl: fetchFixture(metadata, content) }), /update_download_sha256_mismatch/);
  assert.equal((await filesBelow(directory)).some(path => path.endsWith('plan.json')), false);
});

test('ZIP64 component metadata can exceed 2 GiB while every GitHub part stays below the asset limit', () => {
  const fixture = componentFixture({ split: true });
  fixture.manifest.components[0].parts = [1250000000, 1250000000, 590000000].map((bytes, index) =>
    ({ name: `large.zip.part${index + 1}`, bytes, sha256: 'f'.repeat(64) }));
  const component = fixture.manifest.components[0]; component.archiveBytes = 3090000000; component.expandedBytes = 4000000000;
  fixture.metadata.assets.push(...component.parts.map(part => ({ name: part.name, size: part.bytes, state: 'uploaded', digest: `sha256:${part.sha256}`,
    browser_download_url: `https://github.com/${repository}/releases/download/v0.1.0/${part.name}` })));
  assert.equal(validateComponentsManifest(fixture.manifest, config, validateRelease(fixture.metadata, config))[0].archiveBytes, 3090000000);
});

test('stored model ZIP headers may make archive larger than expanded payload', () => {
  const fixture = componentFixture(), component = fixture.manifest.components[0];
  component.expandedBytes = component.archiveBytes - 1;
  assert.equal(validateComponentsManifest(fixture.manifest, config, validateRelease(fixture.metadata, config))[0].expandedBytes, component.archiveBytes - 1);
});

test('component manifest mismatch fails before any component download or plan creation', async t => {
  const fixture = componentFixture(), metadata = structuredClone(fixture.metadata), directory = await temporary(t);
  metadata.assets[1].digest = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(downloadComponents(config, validateRelease(metadata, config), { dataRoot: directory,
    fetchImpl: fetchFixture(metadata, fixture.content) }), /update_download_sha256_mismatch/);
  assert.deepEqual(await readdir(directory), []);
});

test('components come from pinned tag independent of latest app and may have no app asset', async () => {
  const fixture = componentFixture(), metadata = { ...fixture.metadata, assets: fixture.metadata.assets.slice(1) }, calls = [];
  const value = await getComponentsRelease({ ...config, version: '0.1.8', appAsset: 'BilibiliSubtitle-0.1.8-win-x64.zip' },
    { fetchImpl: fetchFixture(metadata, fixture.content, calls) });
  assert.equal(value.version, '0.1.0'); assert.equal(value.app, null);
  assert.equal(calls[0].url, `https://api.github.com/repos/${repository}/releases/tags/v0.1.0`);
  await assert.rejects(getComponentsRelease(config, { fetchImpl: fetchFixture({ ...metadata, tag_name: 'v0.1.1' }) }), /update_components_release_mismatch/);
});

test('Codex component is allowed without copying or requesting authentication data', () => {
  const fixture = componentFixture(); fixture.manifest.components[0].id = 'codex-cli'; fixture.manifest.components[0].target = 'runtime/codex';
  const value = validateComponentsManifest(fixture.manifest, config, validateRelease(fixture.metadata, config));
  assert.equal(value[0].id, 'codex-cli'); assert.equal(value[0].target, 'runtime/codex');
});

test('CAM++ model required filename accepts plus signs without allowing path traversal', () => {
  const fixture = componentFixture(); fixture.manifest.components[0].id = 'speaker-campp'; fixture.manifest.components[0].target = 'models/speaker';
  fixture.manifest.components[0].requiredFiles = ['manifest.json', 'models/voxceleb_CAM++.onnx'];
  assert.equal(validateComponentsManifest(fixture.manifest, config, validateRelease(fixture.metadata, config))[0].requiredFiles[1], 'models/voxceleb_CAM++.onnx');
});

test('native CLI accepts only fixed absolute roots and known command, rejecting duplicate or extra flags', () => {
  assert.equal(parseUpdateArguments(['--package-root', resolve('package'), '--data-root', resolve('data'), '--command', 'check']).command, 'check');
  for (const args of [[], ['--package-root', 'relative', '--data-root', resolve('data'), '--command', 'check'],
    ['--package-root', resolve('p'), '--data-root', resolve('d'), '--command', 'check', '--token', 'secret'],
    ['--package-root', resolve('p'), '--data-root', resolve('d'), '--command', 'check', '--command', 'download-app']])
    assert.throws(() => parseUpdateArguments(args), /update_arguments_invalid/);
});

test('CLI failures contain one safe JSON line and no stderr exception or secret material', () => {
  const cli = fileURLToPath(new URL('./update-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--token', 'private-token-123'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { event: 'failed', command: null, code: 'update_arguments_invalid' });
  assert.doesNotMatch(result.stdout, /private-token/);
});

test('native command emits progress and exactly one terminal complete and never starts capture or translation', async t => {
  const directory = await temporary(t), events = [];
  await writeFile(join(directory, 'software-release.json'), JSON.stringify(config));
  const result = await runUpdateCommand({ packageRoot: directory, dataRoot: directory, command: 'check' },
    { emit: value => events.push(value), fetchImpl: fetchFixture(release()) });
  assert.equal(result.event, 'complete'); assert.equal(result.latestVersion, '0.1.1');
  assert.deepEqual(events.map(value => value.event), ['progress', 'complete']);
  assert.equal(events.some(value => value.microphone || value.translation), false);
});
