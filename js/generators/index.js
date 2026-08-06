import * as attractor from './attractor.js?v=48';
import * as radial from './radial.js?v=48';
import * as cymatics from './cymatics.js?v=48';
import * as harmonic from './harmonic.js?v=48';
import * as oscillo from './oscillo.js?v=48';

const REGISTRY = { attractor: attractor.generate, radial: radial.generate, cymatics: cymatics.generate, harmonic: harmonic.generate, oscillo: oscillo.generate };

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
