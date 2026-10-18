import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseChannel } from './sse-channel.mjs';

class FakeResponse extends EventEmitter {
  constructor(returns = []) { super(); this.returns = returns; this.writes = []; this.writableLength = 0; this.destroyed = false; this.writableEnded = false; }
  write(frame) { this.writes.push(frame); return this.returns.length ? this.returns.shift() : true; }
  destroy() { this.destroyed = true; this.emit('close'); }
  end() { this.writableEnded = true; this.emit('close'); }
}
const data = value => `data: ${JSON.stringify(value)}\n\n`;

test('write(false) accepts an oversized-HWM snapshot exactly once, then drains queued events in order', () => {
  const response = new FakeResponse([false, true, true]), diagnostics = [];
  const channel = createSseChannel(response, { onDiagnostic: value => diagnostics.push(value) });
  const snapshot = { type: 'state', text: 'x'.repeat(30_000) };
  assert.equal(channel.send(snapshot), true);
  assert.equal(response.destroyed, false);
  assert.equal(channel.send({ type: 'ordered', id: 1 }), true);
  assert.equal(channel.send({ type: 'visibility', id: 1 }), true);
  assert.deepEqual(response.writes, [data(snapshot)]);
  response.emit('drain');
  assert.deepEqual(response.writes, [data(snapshot), data({ type: 'ordered', id: 1 }), data({ type: 'visibility', id: 1 })]);
  response.emit('drain');
  assert.equal(response.writes.length, 3);
  assert.equal(diagnostics[0].kind, 'backpressure');
  assert.equal(channel.closed, false);
});

test('a second false write pauses the remaining queue without retransmitting an accepted event', () => {
  const response = new FakeResponse([false, false, true]);
  const channel = createSseChannel(response);
  for (const id of [1, 2, 3]) assert.equal(channel.send({ id }), true);
  response.emit('drain');
  assert.deepEqual(response.writes, [data({ id: 1 }), data({ id: 2 })]);
  response.emit('drain');
  assert.deepEqual(response.writes, [data({ id: 1 }), data({ id: 2 }), data({ id: 3 })]);
});

test('heartbeat shares the same bounded ordering and never overtakes queued data', () => {
  const response = new FakeResponse([false]);
  const channel = createSseChannel(response);
  channel.send({ id: 1 }); channel.heartbeat(); channel.send({ id: 2 });
  response.emit('drain');
  assert.deepEqual(response.writes, [data({ id: 1 }), ': heartbeat\n\n', data({ id: 2 })]);
});

test('pending message overflow destroys the connection and explicitly diagnoses the discarded queue', () => {
  const response = new FakeResponse([false]), diagnostics = [];
  const channel = createSseChannel(response, { maxPendingMessages: 2, onDiagnostic: value => diagnostics.push(value) });
  channel.send({ id: 1 }); channel.send({ id: 2 }); channel.send({ id: 3 });
  assert.equal(channel.send({ id: 4 }), false);
  assert.equal(channel.closed, true); assert.equal(response.destroyed, true);
  const overflow = diagnostics.find(value => value.kind === 'pending_limit_exceeded');
  assert.equal(overflow.pendingMessages, 2);
  assert.ok(overflow.pendingBytes > 0);
  assert.equal(channel.send({ id: 5 }), false); assert.equal(channel.heartbeat(), false);
  response.emit('drain'); assert.equal(response.writes.length, 1);
  for (const event of ['drain', 'close', 'error']) assert.equal(response.listenerCount(event), 0);
});

test('byte budget includes UTF-8 size and bytes already accepted by the response', () => {
  const response = new FakeResponse([false]), diagnostics = [];
  const channel = createSseChannel(response, { maxPendingBytes: 80, onDiagnostic: value => diagnostics.push(value) });
  channel.send({ id: 1 });
  response.writableLength = 60;
  assert.equal(channel.send({ text: '中文' }), false);
  const overflow = diagnostics.find(value => value.kind === 'pending_limit_exceeded');
  assert.equal(overflow.writableBytes, 60);
  assert.equal(overflow.rejectedBytes, Buffer.byteLength(data({ text: '中文' })));
});

test('single-frame budget protects the first snapshot too, independently from Node high water mark', () => {
  const response = new FakeResponse();
  const channel = createSseChannel(response, { maxPendingBytes: 50 });
  assert.equal(channel.send({ text: 'x'.repeat(100) }), false);
  assert.equal(response.writes.length, 0); assert.equal(response.destroyed, true);
});

test('peer close and response error release the queue and all owned listeners', () => {
  for (const reason of ['close', 'error']) {
    const response = new FakeResponse([false]), diagnostics = [];
    const channel = createSseChannel(response, { onDiagnostic: value => diagnostics.push(value) });
    channel.send({ id: 1 }); channel.send({ id: 2 });
    response.emit(reason, new Error('private transport details'));
    assert.equal(channel.closed, true); assert.equal(channel.send({ id: 3 }), false);
    for (const event of ['drain', 'close', 'error']) assert.equal(response.listenerCount(event), 0);
    assert.equal(diagnostics.at(-1).kind, reason === 'close' ? 'response_closed' : 'response_error');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private transport details/);
  }
});

test('explicit close is idempotent and finishes without writing queued stale events', () => {
  const response = new FakeResponse([false]);
  const channel = createSseChannel(response);
  channel.send({ id: 1 }); channel.send({ id: 2 }); channel.close(); channel.close();
  assert.equal(response.writableEnded, true); assert.equal(response.destroyed, false);
  assert.deepEqual(response.writes, [data({ id: 1 })]);
  assert.equal(channel.send({ id: 3 }), false);
});

test('write failures and serialization failures close explicitly without leaking source data', () => {
  for (const mode of ['write', 'json']) {
    const response = new FakeResponse(), diagnostics = [];
    const channel = createSseChannel(response, { onDiagnostic: value => diagnostics.push(value) });
    if (mode === 'write') response.write = () => { throw new Error('private-token'); };
    const event = { text: 'private-transcript' };
    if (mode === 'json') event.self = event;
    assert.equal(channel.send(event), false);
    assert.equal(channel.closed, true); assert.equal(response.destroyed, true);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|transcript|self|token/);
  }
});

test('a throwing diagnostic observer cannot interrupt a successfully accepted stream', () => {
  const response = new FakeResponse([false]);
  const channel = createSseChannel(response, { onDiagnostic: () => { throw new Error('observer failed'); } });
  channel.send({ id: 1 }); channel.send({ id: 2 }); response.emit('drain');
  assert.deepEqual(response.writes, [data({ id: 1 }), data({ id: 2 })]);
});

test('invalid budgets fail before attaching response listeners', () => {
  for (const options of [{ maxPendingBytes: 0 }, { maxPendingMessages: -1 }, { maxPendingBytes: 1.5 }]) {
    const response = new FakeResponse();
    assert.throws(() => createSseChannel(response, options), RangeError);
    assert.equal(response.eventNames().length, 0);
  }
});
