import * as attractor from './attractor.js';
import * as radial from './radial.js';
import * as cymatics from './cymatics.js';
import * as harmonic from './harmonic.js';
import * as oscillo from './oscillo.js';

const REGISTRY = { attractor: attractor.generate, radial: radial.generate, cymatics: cymatics.generate, harmonic: harmonic.generate, oscillo: oscillo.generate };

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
