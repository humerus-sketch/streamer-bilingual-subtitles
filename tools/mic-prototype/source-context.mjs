// Experimental candidate retained for review; the default gateway does not import or enable it.
export const SOURCE_CONTEXT_POLICY = Object.freeze({ maxSegments: 3, windowMs: 20_000, maxCharacters: 800 });

const characters = value => [...value].length;
const render = entries => JSON.stringify({ speaker: 'livestream host', preceding_ja: entries.map(entry => entry.ja) });

/** Keeps only arrived Japanese source data; translation results never enter this buffer. */
export class SourceContextBuffer {
  constructor(workerSessionId) {
    this.workerSessionId = workerSessionId;
    this.entries = [];
  }
  clear() { this.entries = []; }
  capture(segment) {
    const matchingSession = segment.workerSessionId === this.workerSessionId;
    const timelineValid = Number.isSafeInteger(segment.startSample) && Number.isSafeInteger(segment.endSample)
      && segment.startSample >= 0 && segment.endSample > segment.startSample
      && Number.isSafeInteger(segment.sampleRate) && segment.sampleRate > 0;
    const valid = matchingSession && timelineValid && typeof segment.ja === 'string' && Boolean(segment.ja.trim());
    if (matchingSession && !valid) this.clear();
    const current = valid ? { segmentId: segment.segmentId, revision: segment.revision ?? 1, ja: segment.ja,
      startMs: segment.startSample / segment.sampleRate * 1000, endMs: segment.endSample / segment.sampleRate * 1000,
      sampleRate: segment.sampleRate } : null;
    if (current && this.entries.some(entry => entry.sampleRate !== current.sampleRate)) this.clear();
    const candidates = current ? this.entries.filter(entry => entry.segmentId !== current.segmentId
      && entry.endMs <= current.startMs && current.startMs - entry.endMs <= SOURCE_CONTEXT_POLICY.windowMs) : [];
    let included = [];
    for (const entry of candidates.slice(-SOURCE_CONTEXT_POLICY.maxSegments).reverse()) {
      const next = [entry, ...included];
      // Keep complete source clauses rather than truncating away a negation or condition.
      if (characters(render(next)) > SOURCE_CONTEXT_POLICY.maxCharacters) break;
      included = next;
    }
    const context = render(included);
    const snapshot = Object.freeze({ version: 1, context, characters: characters(context),
      priorSegments: Object.freeze(included.map(entry => Object.freeze({ workerSessionId: this.workerSessionId,
        segmentId: entry.segmentId, revision: entry.revision }))), timelineValid: matchingSession && timelineValid });
    if (current) {
      const previousRevision = this.entries.find(entry => entry.segmentId === current.segmentId)?.revision ?? 0;
      if (current.revision > previousRevision) this.entries = [...this.entries.filter(entry => entry.segmentId !== current.segmentId), current]
        .sort((a, b) => a.endMs - b.endMs).slice(-SOURCE_CONTEXT_POLICY.maxSegments);
    }
    return snapshot;
  }
}
