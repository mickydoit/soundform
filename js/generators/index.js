import * as attractor from './attractor.js';
import * as chladni from './chladni.js';
import * as radial from './radial.js';
import * as cymatics from './cymatics.js';
import * as timbre from './timbre.js';

const REGISTRY = { attractor: attractor.generate, chladni: chladni.generate, radial: radial.generate, cymatics: cymatics.generate, timbre: timbre.generate };

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
