import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSpeakerController, publicSpeakerProfile } from './speaker-controller.mjs';

const tick = () => new Promise(done => setImmediate(done));
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await wait(5); } assert.fail('speaker mock condition timed out'); }
const fixtureName = 'profile-11111111-1111-4111-8111-111111111111.json';
async function directory() {
  const parent = resolve('.runtime/speaker-admission-unit-fixtures');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'controller-'));
}
function profile(sourceKind = 'user_microphone') {
  return { schemaVersion: 1, profileId: 'speaker-test-only', sourceKind, modelId: 'test-speaker-model', modelSha256: 'a'.repeat(64),
    featureVersion: 'test-1', threshold: 0.7, minVoicedMs: 1000, enrollmentVoicedMs: 20_000, embeddingDimension: 2,
    embedding: [0.12, 0.34], privateMarker: 'PRIVATE_BIOMETRIC_TEST_VALUE' };
}
const publicOf = document => ({ ...document, profileSha256: createHash('sha256').update(JSON.stringify(document)).digest('hex') });
async function existingProfile(folder, sourceKind = 'user_microphone') {
  const document = profile(sourceKind);
  await writeFile(join(folder, fixtureName), JSON.stringify(document), { flag: 'wx' });
  await writeFile(join(folder, 'active.json'), JSON.stringify({ schemaVersion: 1, file: fixtureName }));
  return publicOf(document);
}
function fakeProcessFactory({ statusProfile = null, onSpawn, closeOnCancel = true } = {}) {
  const children = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter(); child.pid = 700 + children.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.args = args; child.finished = false;
    child.commands = []; child.killCalls = 0;
    child.line = event => { if (!child.finished) child.stdout.write(JSON.stringify(event) + '\n'); };
    child.finish = (code = 0) => { if (child.finished) return; child.finished = true; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n')) if (line) {
        child.commands.push(JSON.parse(line));
        if (JSON.parse(line).command === 'cancel' && closeOnCancel) setImmediate(() => child.finish());
      }
      done();
    } });
    child.kill = () => { child.killCalls++; child.finish(1); return true; };
    children.push(child);
    assert.equal(options.windowsHide, true);
    setImmediate(() => {
      if (onSpawn) onSpawn(child, args[3]);
      else if (args[3] === 'status') {
        child.line({ type: 'speaker_status', available: true, profileValid: Boolean(statusProfile), profile: statusProfile }); child.finish();
      }
    });
    return child;
  };
  return { children, spawnImpl };
}
async function harness(t, config = {}) {
  const folder = await directory(), fake = fakeProcessFactory(config);
  const controller = createSpeakerController({ python: resolve('test-only-python.exe'), script: resolve('test-only-speaker.py'),
    assets: resolve('test-only-speaker-assets'), profileDirectory: folder, spawnImpl: fake.spawnImpl });
  t.after(async () => { for (const child of fake.children) child.finish(); await controller.close(); });
  return { folder, fake, controller };
}

test('public profile projection never exposes embedding vectors, arbitrary attributes or filesystem paths', () => {
  const projected = publicSpeakerProfile({ ...publicOf(profile()), profileFile: 'PRIVATE_LOCAL_PATH' });
  assert.equal(projected.profileId, 'speaker-test-only'); assert.equal(projected.sourceKind, 'user_microphone');
  assert.equal(projected.modelSha256, 'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(projected), /embedding"|PRIVATE_|profileFile/);
  assert.equal('embedding' in projected, false);
});

test('missing and test-fixture profiles cannot admit the user microphone', async t => {
  for (const kind of ['missing', 'test_fixture']) {
    const folder = await directory(); const metadata = kind === 'missing' ? null : await existingProfile(folder, kind);
    const fake = fakeProcessFactory({ statusProfile: metadata });
    const controller = createSpeakerController({ python: resolve('fake.exe'), script: resolve('fake.py'), assets: resolve('fake-assets'),
      profileDirectory: folder, spawnImpl: fake.spawnImpl });
    t.after(() => controller.close());
    if (kind === 'missing') await controller.refresh();
    else await assert.rejects(() => controller.refresh(), /speaker_profile_invalid/);
    assert.equal(controller.snapshot().enrolled, false); assert.equal(controller.admittedProfile(), null);
  }
});

test('invalid pointer after a formerly valid profile revokes admission instead of retaining stale ready state', async t => {
  const folder = await directory(), metadata = await existingProfile(folder), fake = fakeProcessFactory({ statusProfile: metadata });
  const controller = createSpeakerController({ python: resolve('fake.exe'), script: resolve('fake.py'), assets: resolve('fake-assets'),
    profileDirectory: folder, spawnImpl: fake.spawnImpl });
  t.after(() => controller.close());
  await controller.refresh(); assert.ok(controller.admittedProfile());
  await writeFile(join(folder, 'active.json'), JSON.stringify({ schemaVersion: 1, file: '../untrusted-profile.json' }));
  await assert.rejects(() => controller.refresh(), /speaker_profile_pointer_invalid/);
  assert.equal(controller.admittedProfile(), null); assert.equal(controller.snapshot().enrolled, false);
});

test('concurrent enrollment is admitted once and cancellation closes the sole owned process', async t => {
  const { fake, controller } = await harness(t);
  const results = await Promise.allSettled([controller.enroll({ device: 9 }), controller.enroll({ device: 9 })]);
  const admitted = results.filter(result => result.status === 'fulfilled');
  assert.equal(admitted.length, 1, 'the whole enrollment, including mkdir, needs one operation reservation');
  assert.equal(results.filter(result => result.status === 'rejected')[0].reason.safeCode, 'speaker_operation_busy');
  await until(() => fake.children.length === 1);
  assert.equal(controller.busy(), true);
  assert.equal((await controller.cancel()).cancelled, true);
  await admitted[0].value.completion;
  assert.equal(controller.admittedProfile(), null); assert.equal(controller.busy(), false);
  assert.equal(fake.children.length, 1); assert.equal(fake.children[0].finished, true);
});

test('closing immediately after successful child exit cancels registration before publishing an active profile', async t => {
  const { folder, fake, controller } = await harness(t);
  const enrolled = await controller.enroll({ device: 9 }); await until(() => fake.children.length === 1);
  const child = fake.children[0], output = child.args[child.args.indexOf('--profile-output') + 1], document = profile();
  await writeFile(output, JSON.stringify(document), { flag: 'wx' });
  child.line({ type: 'enrollment_completed', profileCreated: true, profile: publicOf(document) });
  child.finish();
  const closing = controller.close();
  await Promise.all([closing, enrolled.completion]);
  await assert.rejects(() => readFile(join(folder, 'active.json')), error => error.code === 'ENOENT');
  assert.equal(controller.admittedProfile(), null); assert.equal(controller.busy(), false);
  assert.equal(controller.healthy(), false);
});

test('an already closed controller refuses enrollment before filesystem or process work', async t => {
  const { fake, controller } = await harness(t);
  await controller.close();
  await assert.rejects(() => controller.enroll({ device: 9 }), error => ['speaker_controller_unavailable', 'speaker_operation_busy'].includes(error.safeCode));
  assert.equal(fake.children.length, 0); assert.equal(controller.busy(), false);
});

test('an error event alone cannot count a still-owned process as terminated', async t => {
  const { fake, controller } = await harness(t, { onSpawn: () => {}, closeOnCancel: false });
  const refreshing = controller.refresh(); const observed = refreshing.catch(error => error);
  await until(() => fake.children.length === 1);
  const child = fake.children[0]; child.emit('error', new Error('PRIVATE_PROCESS_FAILURE'));
  let closeReturned = false;
  const closing = controller.close().then(value => { closeReturned = true; return value; });
  await tick(); assert.equal(closeReturned, false, 'error does not prove OS process close');
  child.finish(1);
  const closed = await closing; const error = await observed;
  assert.equal(closed.terminationConfirmed, true); assert.ok(error instanceof Error);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE_PROCESS_FAILURE/);
});

test('a broken child stdin is handled without an unhandled exception or premature exit claim', async t => {
  const { fake, controller } = await harness(t, { onSpawn: () => {}, closeOnCancel: false });
  const observed = controller.refresh().catch(error => error);
  await until(() => fake.children.length === 1);
  const child = fake.children[0];
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('PRIVATE_PIPE_FAILURE'), { code: 'EPIPE' })));
  let returned = false;
  const closing = controller.close().then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false);
  child.finish(1); await closing; await observed;
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE_PIPE_FAILURE/);
});

test('cancelling a replacement enrollment preserves the prior explicitly enrolled profile', async t => {
  const folder = await directory(), metadata = await existingProfile(folder), fake = fakeProcessFactory({ statusProfile: metadata });
  const controller = createSpeakerController({ python: resolve('fake.exe'), script: resolve('fake.py'), assets: resolve('fake-assets'),
    profileDirectory: folder, spawnImpl: fake.spawnImpl });
  t.after(async () => { for (const child of fake.children) child.finish(); await controller.close(); });
  await controller.refresh(); const oldPath = controller.admittedProfile(), pointerBefore = await readFile(join(folder, 'active.json'), 'utf8');
  const active = await controller.enroll({ device: 9 }); await until(() => fake.children.length === 2);
  assert.equal(controller.admittedProfile(), null, 'a replacement in progress must not appear ready');
  assert.equal((await controller.cancel()).cancelled, true); await active.completion;
  assert.equal(controller.admittedProfile(), oldPath);
  assert.equal(await readFile(join(folder, 'active.json'), 'utf8'), pointerBefore);
  assert.equal(controller.snapshot().profile.profileSha256, metadata.profileSha256);
});

test('a complete explicitly started enrollment activates only the verified local file and public metadata', async t => {
  const { folder, fake, controller } = await harness(t);
  const enrolled = await controller.enroll({ device: 9 }); await until(() => fake.children.length === 1);
  const child = fake.children[0], output = child.args[child.args.indexOf('--profile-output') + 1], document = profile();
  await writeFile(output, JSON.stringify(document), { flag: 'wx' });
  child.line({ type: 'enrollment_completed', profileCreated: true, profile: publicOf(document) }); child.finish();
  await enrolled.completion;
  assert.equal(controller.snapshot().status, 'ready'); assert.equal(controller.admittedProfile(), output);
  const pointer = JSON.parse(await readFile(join(folder, 'active.json'), 'utf8'));
  assert.equal(join(folder, pointer.file), output);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE_BIOMETRIC_TEST_VALUE|"embedding":/);
});

test('unconfirmed process termination stays fatal and is never reported as successful close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fake, controller } = await harness(t, { onSpawn: () => {}, closeOnCancel: false });
  const observed = controller.refresh().catch(error => error);
  for (let index = 0; index < 200 && fake.children.length !== 1; index++) await tick();
  assert.equal(fake.children.length, 1);
  const child = fake.children[0]; child.kill = () => false;
  child.emit('error', new Error('PRIVATE_UNCONFIRMED_PROCESS'));
  t.mock.timers.tick(6000);
  const error = await observed;
  assert.equal(error.safeCode, 'speaker_process_exit_unconfirmed');
  assert.equal((await controller.close()).terminationConfirmed, false);
  assert.equal(controller.healthy(), false); assert.equal(controller.admittedProfile(), null);
  assert.equal(controller.snapshot().processExitUnconfirmed, true); assert.equal(child.finished, false);
  child.finish(1);
  assert.equal((await controller.close()).terminationConfirmed, false, 'a late close must not erase the original uncertainty');
});
