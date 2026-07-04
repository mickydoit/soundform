import * as attractor from './attractor.js';
import * as chladni from './chladni.js';

const REGISTRY = { attractor: attractor.generate, chladni: chladni.generate };
// Tasks 8–11 add: chladni, radial, spectral, timbre

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
