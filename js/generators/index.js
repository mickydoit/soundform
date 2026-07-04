import * as attractor from './attractor.js';
import * as chladni from './chladni.js';
import * as radial from './radial.js';
import * as spectral from './spectral.js';

const REGISTRY = { attractor: attractor.generate, chladni: chladni.generate, radial: radial.generate, spectral: spectral.generate };
// Tasks 8–11 add: chladni, radial, spectral, timbre

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
