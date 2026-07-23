import { generate } from './generators/index.js?v=44';

self.onmessage = (e) => {
  const { fingerprint, params } = e.data;
  try {
    const out = generate(fingerprint, params, p => self.postMessage({ progress: p }));
    // Strands are either a raw Float32Array (legacy generators) or a
    // { pts, tone, band, ring } object wrapping one (tone strands) — grab
    // the underlying buffer either way for the transfer list.
    const strandBuffers = out.strands.map(s => (s.pts ?? s).buffer);
    self.postMessage(
      { done: true, positions: out.positions, attr: out.attr, strands: out.strands },
      [out.positions.buffer, out.attr.buffer, ...strandBuffers]
    );
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
