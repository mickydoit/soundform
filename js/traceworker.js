// js/traceworker.js — classic worker. Runs imagetracer's pipeline one palette
// layer at a time so the UI can show real per-level progress. imagetracer's
// imagedataToTracedata() is one synchronous call with no progress hook, so we
// drive its exposed stage functions ourselves.
importScripts('vendor/imagetracer.js?v=58');

self.onmessage = (e) => {
  const { imageData, options } = e.data;
  try {
    const IT = self.ImageTracer;
    const ii = IT.colorquantization(imageData, options); // { array, palette } — uses options.pal
    const levels = ii.palette.length;
    const layers = [];
    for (let k = 0; k < levels; k++) {
      const layer = IT.layeringstep(ii, k);
      const paths = IT.pathscan(layer, options.pathomit);
      const internodePaths = IT.internodes(paths, options);
      const traced = IT.batchtracepaths(internodePaths, options.ltres, options.qtres);
      layers.push(traced);
      self.postMessage({ progress: (k + 1) / levels, level: k + 1, levels });
    }
    self.postMessage({
      done: true,
      tracedata: { width: imageData.width, height: imageData.height, layers, palette: ii.palette },
    });
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
