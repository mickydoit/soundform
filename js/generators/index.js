import * as attractor from './attractor.js?v=56';
import * as radial from './radial.js?v=56';
import * as cymatics from './cymatics.js?v=56';
import * as harmonic from './harmonic.js?v=56';
import * as oscillo from './oscillo.js?v=56';
import * as liquid from './liquid.js?v=56';

const REGISTRY = { attractor: attractor.generate, radial: radial.generate, cymatics: cymatics.generate, harmonic: harmonic.generate, oscillo: oscillo.generate, liquid: liquid.generate };

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
