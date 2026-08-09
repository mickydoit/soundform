import { generate } from './generators/index.js?v=56';

self.onmessage = (e) => {
  const { fingerprint, params } = e.data;
  try {
    const out = generate(fingerprint, params, p => self.postMessage({ progress: p }));
    // Strands are either a raw Float32Array (legacy generators) or a
    // { pts, tone, band, ring } object wrapping one (tone strands) — grab
    // the underlying buffer either way for the transfer list.
    const strandBuffers = out.strands.map(s => (s.pts ?? s).buffer);
    self.postMessage(
      // kind/circles/smooth are only set by the analytic Liquid mode; they
      // are plain objects, so they ride the structured clone and need no
      // transfer entry.
      { done: true, positions: out.positions, attr: out.attr, strands: out.strands,
        kind: out.kind, state: out.state },
      [out.positions.buffer, out.attr.buffer, ...strandBuffers]
    );
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
