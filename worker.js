/* Web Worker: runs the solver off the main thread so the page stays responsive. */
importScripts('engine.js');

self.onmessage = function (ev) {
  const { id, type, model, asg, opts } = ev.data;
  const onProgress = p => self.postMessage({ id, type: 'progress', progress: p });
  try {
    let res;
    if (type === 'generate') res = VF.generate(model, Object.assign({}, opts, { onProgress }));
    else if (type === 'improve') res = VF.improveRoster(model, asg, Object.assign({}, opts, { onProgress }));
    else throw new Error('Unknown job: ' + type);
    self.postMessage({ id, type: 'done', result: { asg: res.asg, iterations: res.iterations, elapsedMs: res.elapsedMs, attempt: res.attempt, polished: res.polished } });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err && err.stack || err) });
  }
};
