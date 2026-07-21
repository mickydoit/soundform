import { generate } from './generators/index.js?v=40';

self.onmessage = (e) => {
  const { fingerprint, params } = e.data;
  try {
    const out = generate(fingerprint, params, p => self.postMessage({ progress: p }));
    self.postMessage(
      { done: true, positions: out.positions, attr: out.attr, strands: out.strands },
      [out.positions.buffer, out.attr.buffer, ...out.strands.map(s => s.buffer)]
    );
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
