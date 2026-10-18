import { createInterface } from 'node:readline';
import { readFile, stat, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createGateway } from '../gateway.mjs';

const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const codeOf = error => /^[a-z][a-z0-9_]{0,99}$/.test(error?.safeCode ?? '') ? error.safeCode : 'desktop_host_failed';
const slug = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

const userSettingFields = new Set(['pythonExecutable', 'modelDirectory', 'speakerAssets', 'codexExecutable',
  'dataDirectory', 'codexModel', 'codexServiceTier']);
const pathSettingFields = ['pythonExecutable', 'modelDirectory', 'speakerAssets', 'codexExecutable',
  'dataDirectory', 'enhancementAssets', 'replayFile', 'testSpeakerProfile'];

export function desktopSharedRoot(env = process.env) {
  const root = env.BILIBILI_SUBTITLE_HOME || join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'BilibiliSubtitlePrototype');
  if (typeof root !== 'string' || !isAbsolute(root) || /[\u0000-\u001f\u007f-\u009f]/.test(root)) fail('desktop_invalid_shared_root');
  return resolve(root);
}

/** Only package paths use the {shared} token; legacy absolute settings remain valid. */
export function resolveDesktopSettings(packageSettings, userSettings = null, env = process.env) {
  if (!packageSettings || typeof packageSettings !== 'object' || Array.isArray(packageSettings)) fail('desktop_invalid_settings');
  if (userSettings !== null && (!userSettings || typeof userSettings !== 'object' || Array.isArray(userSettings)
    || userSettings.schemaVersion !== 1 || Object.keys(userSettings).some(key => key !== 'schemaVersion' && !userSettingFields.has(key))))
    fail('desktop_invalid_user_settings');
  const shared = desktopSharedRoot(env), value = structuredClone(packageSettings);
  for (const [key, field] of Object.entries(userSettings ?? {})) if (userSettingFields.has(key)) value[key] = field;
  function expand(path) {
    if (typeof path !== 'string' || !path.includes('{')) return path;
    if (!/^\{shared\}[\\/]/.test(path)) fail('desktop_invalid_settings');
    const parts = path.slice(9).split(/[\\/]/);
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('{') || part.includes('}')))
      fail('desktop_invalid_settings');
    return join(shared, ...parts);
  }
  for (const name of pathSettingFields) if (value[name] !== null && value[name] !== undefined) value[name] = expand(value[name]);
  if (value.capturedReplayFiles && typeof value.capturedReplayFiles === 'object' && !Array.isArray(value.capturedReplayFiles))
    for (const [id, file] of Object.entries(value.capturedReplayFiles)) value.capturedReplayFiles[id] = expand(file);
  return validateSettings(value);
}

export async function readDesktopSettings(settingsPath, env = process.env) {
  async function parse(path, optional) {
    const bytes = await readFile(path).catch(error => {
      if (optional && error.code === 'ENOENT') return null;
      fail(optional ? 'desktop_user_settings_unreadable' : 'desktop_settings_unreadable');
    });
    if (bytes === null) return null;
    if (bytes.length > 65536) fail('desktop_invalid_settings');
    try {
      const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (parsed === null) fail(optional ? 'desktop_invalid_user_settings' : 'desktop_invalid_settings');
      return parsed;
    }
    catch { fail(optional ? 'desktop_invalid_user_settings' : 'desktop_invalid_settings'); }
  }
  return resolveDesktopSettings(await parse(settingsPath, false),
    await parse(join(desktopSharedRoot(env), 'desktop.settings.json'), true), env);
}

export function validateSettings(value) {
  if (!value || value.schemaVersion !== 1) fail('desktop_invalid_settings');
  for (const name of ['pythonExecutable', 'modelDirectory', 'dataDirectory'])
    if (typeof value[name] !== 'string' || !isAbsolute(value[name]) || /[\r\n\0]/.test(value[name])) fail('desktop_invalid_settings');
  if (value.codexExecutable && (typeof value.codexExecutable !== 'string' || !isAbsolute(value.codexExecutable)
    || !/\.exe$/i.test(value.codexExecutable) || /[\r\n\0]/.test(value.codexExecutable))) fail('desktop_invalid_settings');
  const replayFile = value.replayFile ?? null;
  if (replayFile !== null && (typeof replayFile !== 'string' || !isAbsolute(replayFile)
    || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(replayFile)
    || /[\u0000-\u001f\u007f-\u009f]/.test(replayFile))) fail('desktop_invalid_settings');
  if (!slug(value.codexModel) || !['default', 'fast'].includes(value.codexServiceTier)) fail('desktop_invalid_settings');
  const enhancementAssets = value.enhancementAssets ?? null, capturedReplayFiles = Object.create(null);
  const speakerAssets = value.speakerAssets ?? null;
  const testSpeakerProfile = value.testSpeakerProfile ?? null;
  if (testSpeakerProfile !== null && (typeof testSpeakerProfile !== 'string' || !isAbsolute(testSpeakerProfile)
    || !/\.json$/i.test(testSpeakerProfile) || /[\u0000-\u001f\u007f-\u009f]/.test(testSpeakerProfile))) fail('desktop_invalid_settings');
  if (speakerAssets !== null && (typeof speakerAssets !== 'string' || !isAbsolute(speakerAssets)
    || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(speakerAssets)
    || /[\u0000-\u001f\u007f-\u009f]/.test(speakerAssets))) fail('desktop_invalid_settings');
  const residentPolicy = value.residentPolicy ?? {};
  if (!residentPolicy || typeof residentPolicy !== 'object' || Array.isArray(residentPolicy)
    || Object.keys(residentPolicy).some(key => !['maxCachedModels', 'maxContextBytes', 'modelPolicies', 'contextUsageThreshold'].includes(key))) fail('desktop_invalid_settings');
  if (residentPolicy.maxCachedModels !== undefined && (!Number.isInteger(residentPolicy.maxCachedModels) || residentPolicy.maxCachedModels < 1 || residentPolicy.maxCachedModels > 4)) fail('desktop_invalid_settings');
  if (residentPolicy.maxContextBytes !== undefined && (!Number.isInteger(residentPolicy.maxContextBytes) || residentPolicy.maxContextBytes < 4096 || residentPolicy.maxContextBytes > 1_048_576)) fail('desktop_invalid_settings');
  if (residentPolicy.contextUsageThreshold !== undefined && residentPolicy.contextUsageThreshold !== 0.8) fail('desktop_invalid_settings');
  if (residentPolicy.modelPolicies !== undefined && (!residentPolicy.modelPolicies || typeof residentPolicy.modelPolicies !== 'object' || Array.isArray(residentPolicy.modelPolicies))) fail('desktop_invalid_settings');
  if (enhancementAssets !== null && (typeof enhancementAssets !== 'string' || !isAbsolute(enhancementAssets)
    || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(enhancementAssets)
    || /[\u0000-\u001f\u007f-\u009f]/.test(enhancementAssets))) fail('desktop_invalid_settings');
  if (value.capturedReplayFiles !== undefined && (!value.capturedReplayFiles || typeof value.capturedReplayFiles !== 'object' || Array.isArray(value.capturedReplayFiles))) fail('desktop_invalid_settings');
  for (const [id, file] of Object.entries(value.capturedReplayFiles ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || typeof file !== 'string' || !isAbsolute(file) || !/\.wav$/i.test(file)
      || process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(file)
      || /[\u0000-\u001f\u007f-\u009f]/.test(file)) fail('desktop_invalid_settings');
    capturedReplayFiles[id] = file;
  }
  return { schemaVersion: 1, pythonExecutable: value.pythonExecutable, modelDirectory: value.modelDirectory,
    dataDirectory: value.dataDirectory, codexExecutable: value.codexExecutable || null, replayFile, enhancementAssets, capturedReplayFiles,
    speakerAssets, testSpeakerProfile, residentPolicy: structuredClone(residentPolicy),
    codexModel: value.codexModel, codexServiceTier: value.codexServiceTier };
}

export async function findCodexExecutable(settings, env = process.env) {
  if (settings.codexExecutable) {
    if ((await stat(settings.codexExecutable).catch(() => null))?.isFile()) return settings.codexExecutable;
    fail('desktop_codex_executable_missing');
  }
  const candidates = [];
  if (env.LOCALAPPDATA) {
    const bin = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    for (const entry of await readdir(bin, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(bin, entry.name, 'codex.exe'), info = await stat(path).catch(() => null);
      if (info?.isFile()) candidates.push({ path, modified: info.mtimeMs });
    }
    candidates.sort((a, b) => b.modified - a.modified);
  }
  for (const directory of (env.PATH ?? '').split(';').filter(Boolean)) {
    const path = join(directory, 'codex.exe');
    if ((await stat(path).catch(() => null))?.isFile()) candidates.push({ path });
  }
  // Existing official installations take precedence; a fresh install uses our bundled official CLI.
  if (!candidates.length) {
    const bundled = join(desktopSharedRoot(env), 'runtime', 'codex', 'codex.exe');
    if ((await stat(bundled).catch(() => null))?.isFile()) candidates.push({ path: bundled });
  }
  if (!candidates.length) fail('desktop_codex_executable_missing');
  return candidates[0].path;
}

/** The launcher assigns its Job Object before sending start; no child process starts earlier. */
export async function runDesktopHost({ settings, input = process.stdin, emit = value => process.stdout.write(JSON.stringify(value) + '\n'),
  createGatewayImpl = createGateway, resolveCodexImpl = findCodexExecutable, validatePaths = true } = {}) {
  const config = validateSettings(settings);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let gateway = null, startPromise = null, closing = false, shutdownPromise = null, exitCode = 0;
  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = Promise.resolve().then(async () => {
      try {
        if (startPromise) await startPromise;
        if (gateway) await gateway.close();
      } catch (error) { exitCode = 1; emit({ event: 'shutdown_failed', code: codeOf(error) }); }
      emit({ event: 'stopped', exitCode });
      lines.close(); input.pause();
      return exitCode;
    });
    return shutdownPromise;
  }
  async function start() {
    try {
      if (validatePaths) {
        if (!(await stat(config.pythonExecutable).catch(() => null))?.isFile()) fail('desktop_python_missing');
        for (const name of ['model.bin', 'download-manifest.json'])
          if (!(await stat(join(config.modelDirectory, name)).catch(() => null))?.isFile()) fail('desktop_asr_model_missing');
        if (config.replayFile !== null && !(await stat(config.replayFile).catch(() => null))?.isFile()) fail('desktop_replay_file_missing');
        if (config.enhancementAssets !== null && !(await stat(config.enhancementAssets).catch(() => null))?.isDirectory()) fail('desktop_enhancement_assets_missing');
        if (config.speakerAssets !== null && !(await stat(join(config.speakerAssets, 'manifest.json')).catch(() => null))?.isFile()) fail('desktop_speaker_assets_missing');
        if (config.testSpeakerProfile !== null && !(await stat(config.testSpeakerProfile).catch(() => null))?.isFile()) fail('desktop_test_speaker_profile_missing');
        for (const file of Object.values(config.capturedReplayFiles)) if (!(await stat(file).catch(() => null))?.isFile()) fail('desktop_captured_replay_file_missing');
        await mkdir(join(config.dataDirectory, 'cli-work'), { recursive: true });
      }
      const executable = await resolveCodexImpl(config);
      gateway = await createGatewayImpl({ translationProvider: 'codex_resident', port: 0,
        codexExecutable: executable, codexModel: config.codexModel, codexServiceTier: config.codexServiceTier,
        codexPromptStyle: 'full', python: config.pythonExecutable, modelDir: config.modelDirectory, replayFile: config.replayFile,
        enhancementAssets: config.enhancementAssets, capturedReplayFiles: config.capturedReplayFiles,
        speakerAssets: config.speakerAssets, speakerProfileDirectory: join(config.dataDirectory, 'speaker-profiles'),
        ...(config.testSpeakerProfile ? { testSpeakerProfile: config.testSpeakerProfile } : {}),
        speakerAdmissionDefault: true, allowEnhancement: false, defaultComputeType: 'float16', translationContextMode: 'previous_translation',
        maxCachedModels: config.residentPolicy.maxCachedModels ?? 4, maxContextBytes: config.residentPolicy.maxContextBytes ?? 131072,
        contextUsageThreshold: config.residentPolicy.contextUsageThreshold ?? 0.8,
        modelPolicies: config.residentPolicy.modelPolicies ?? {},
        cliWorkDir: join(config.dataDirectory, 'cli-work'), outputBase: join(config.dataDirectory, 'runs') });
      if (!closing) emit({ event: 'ready', localUrl: gateway.origin + '/', model: gateway.state.selectedModel,
        modelCount: gateway.state.models.length, auth: gateway.state.auth, microphone: 'off_until_explicit_start' });
    } catch (error) {
      exitCode = 1;
      emit({ event: 'startup_failed', code: codeOf(error) });
    }
  }
  const done = new Promise((resolveDone, reject) => {
    lines.on('line', line => {
      if (line.length > 1024) { exitCode = 1; void shutdown().then(resolveDone, reject); return; }
      let command;
      try { command = JSON.parse(line)?.command; } catch { command = null; }
      if (command === 'start' && !startPromise && !closing) {
        startPromise = start();
        startPromise.then(() => { if (closing || exitCode) void shutdown().then(resolveDone, reject); });
      } else if (command === 'shutdown') void shutdown().then(resolveDone, reject);
    });
    lines.on('close', () => { void shutdown().then(resolveDone, reject); });
  });
  return done;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--settings') fail('desktop_invalid_arguments');
    process.exitCode = await runDesktopHost({ settings: await readDesktopSettings(resolve(process.argv[3])) });
  } catch (error) {
    process.stdout.write(JSON.stringify({ event: 'startup_failed', code: codeOf(error) }) + '\n');
    process.exitCode = 1;
  }
}
