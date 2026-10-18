const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_MESSAGES = 256;

/** A false write result means accepted with backpressure, not a disconnected client. */
export function createSseChannel(response, {
  onDiagnostic = () => {},
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  maxPendingMessages = DEFAULT_MAX_PENDING_MESSAGES,
} = {}) {
  for (const [name, value] of Object.entries({ maxPendingBytes, maxPendingMessages })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  const pending = [];
  let pendingBytes = 0, blocked = false, closed = false;
  const writableBytes = () => Number.isFinite(response.writableLength) ? Math.max(0, response.writableLength) : 0;
  function diagnose(kind, extra = {}) {
    // Never copy event bodies, transcript text, credentials or arbitrary Error objects into diagnostics.
    try { onDiagnostic({ kind, backpressure: blocked, pendingBytes, pendingMessages: pending.length, writableBytes: writableBytes(), ...extra }); }
    catch { /* Diagnostic consumers must not break or duplicate the data stream. */ }
  }
  function finish(kind, destroy = false, end = false, extra = {}) {
    if (closed) return;
    closed = true;
    diagnose(kind, extra);
    pending.length = 0; pendingBytes = 0; blocked = false;
    response.removeListener('drain', onDrain);
    response.removeListener('close', onClose);
    response.removeListener('error', onError);
    if (destroy && !response.destroyed) response.destroy();
    else if (end && !response.destroyed && !response.writableEnded) response.end();
  }
  function write(frame) {
    if (closed) return false;
    if (response.destroyed || response.writableEnded) { finish('response_unavailable'); return false; }
    try {
      if (!response.write(frame)) {
        blocked = true;
        diagnose('backpressure');
      }
      return true;
    } catch {
      finish('write_failed', true);
      return false;
    }
  }
  function onDrain() {
    if (closed) return;
    blocked = false;
    diagnose('drain');
    while (!closed && !blocked && pending.length) {
      const item = pending.shift(); pendingBytes -= item.bytes;
      if (!write(item.frame)) break;
    }
  }
  function onClose() { finish('response_closed'); }
  function onError() { finish('response_error', true); }
  function offer(frame) {
    if (closed) return false;
    if (response.destroyed || response.writableEnded) { finish('response_unavailable'); return false; }
    const bytes = Buffer.byteLength(frame);
    // Account for bytes already accepted by Node as well as this channel's waiting queue.
    if (bytes + pendingBytes + writableBytes() > maxPendingBytes
      || (blocked && pending.length + 1 > maxPendingMessages)) {
      finish('pending_limit_exceeded', true, false, { rejectedBytes: bytes });
      return false;
    }
    if (blocked) {
      pending.push({ frame, bytes }); pendingBytes += bytes;
      return true;
    }
    return write(frame);
  }
  response.on('drain', onDrain);
  response.on('close', onClose);
  response.on('error', onError);
  return {
    send(event) {
      if (closed) return false;
      let json;
      try { json = JSON.stringify(event); }
      catch { finish('event_serialization_failed', true); return false; }
      if (json === undefined) { finish('event_serialization_failed', true); return false; }
      return offer(`data: ${json}\n\n`);
    },
    heartbeat() { return offer(': heartbeat\n\n'); },
    close() { finish('channel_closed', false, true); },
    get closed() { return closed; },
  };
}
