import guideUrl from '../assets/onboarding/guide-full.wav?url';
import manifest from '../assets/onboarding/manifest.json';

const cues = manifest.guide_track.cues;
const TIMEOUT_MS = 8000;
const blocked = () => new DOMException('Audio needs a user gesture', 'NotAllowedError');

// Safari must resume the output context in the authorization click, before
// awaiting getUserMedia. No source is connected or started until play().
export function createGuideAudio({ onChange = () => {} } = {}) {
  let destroyed = false, output = null, active = null, download = null, buffer = null, offset = 0;
  let state = { kind: 'guide', index: 0, text: cues[0].text, playing: false, loading: false,
    paused: false, blocked: false, error: '', ended: false };
  const notify = patch => {
    state = { ...state, ...patch };
    if (!destroyed) onChange({ ...state });
  };
  const current = run => !destroyed && active === run && output === run.output;
  const caption = seconds => {
    let index = 0;
    for (let i = 1; i < cues.length && seconds * 1000 >= cues[i].start_ms; i += 1) index = i;
    return { index, text: cues[index].text };
  };
  const position = run => run?.startedAt == null ? offset
    : Math.min(run.buffer.duration, run.offset + Math.max(0, run.output.context.currentTime - run.startedAt));

  function loadBytes() {
    if (download) return download.promise;
    const request = { controller: new AbortController(), promise: null };
    request.promise = fetch(guideUrl, { signal: request.controller.signal, cache: 'force-cache' })
      .then(response => {
        if (!response.ok) throw new Error('Narration download failed');
        return response.arrayBuffer();
      });
    download = request;
    request.promise.catch(() => { if (download === request) download = null; });
    return request.promise;
  }

  function prepare() {
    if (!destroyed && !buffer) void loadBytes().catch(() => {});
  }

  function activate() {
    if (destroyed) return;
    prepare();
    try {
      if (!output) {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        const context = new Context();
        const resource = { context, resumed: null, decoded: null };
        output = resource;
        context.onstatechange = () => {
          if (!active || active.output !== resource || destroyed) return;
          const playing = context.state === 'running' && active.startedAt != null
            && position(active) > active.offset;
          notify({ playing, loading: !playing, position: position(active) });
        };
      }
      const resource = output;
      // Call synchronously, not from a promise after permission/download finishes.
      resource.resumed = resource.context.state === 'running' ? Promise.resolve()
        : Promise.resolve(resource.context.resume()).then(() => {
          if (resource.context.state !== 'running') throw blocked();
        });
      resource.resumed.catch(() => {});
      if (!resource.decoded) {
        resource.decoded = buffer ? Promise.resolve(buffer) : loadBytes()
          .then(bytes => resource.context.decodeAudioData(bytes.slice(0)))
          .then(decoded => {
            if (!destroyed && output === resource) buffer = decoded;
            return decoded;
          });
        resource.decoded.catch(() => {});
      }
    } catch (error) {
      // Keep failure available to play() while the microphone prompt proceeds.
      if (output) { output.resumed = Promise.reject(error); output.resumed.catch(() => {}); }
    }
  }

  function releaseRun(run) {
    if (!run) return;
    if (active === run) active = null;
    clearTimeout(run.timeout);
    clearInterval(run.clock);
    if (run.source) {
      run.source.onended = null;
      try { run.source.stop(); } catch { /* Ended or not started. */ }
      try { run.source.disconnect(); } catch { /* Already released. */ }
      run.source = null;
    }
    run.resolve();
  }

  function fail(run, error) {
    if (!current(run)) return;
    offset = position(run);
    releaseRun(run);
    releaseOutput();
    notify({ playing: false, loading: false, paused: false, ended: false, position: offset,
      blocked: error?.name === 'NotAllowedError',
      error: error?.name === 'NotAllowedError' ? '' : '声音暂时没有播放出来，请点一下“播放讲解”。' });
  }

  function watchdog(run) {
    clearTimeout(run.timeout);
    run.timeout = setTimeout(() => fail(run, new Error('Narration stalled')), TIMEOUT_MS);
  }

  function play() {
    if (destroyed) return Promise.resolve();
    if (active) return active.completion;
    if (state.ended || state.error || state.blocked) offset = 0;
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    const run = { output, completion, resolve, source: null, startedAt: null,
      offset, buffer: null, lastTime: offset, timeout: null, clock: null };
    active = run;
    notify({ ...caption(offset), playing: false, loading: true, paused: false, blocked: false, error: '', ended: false });
    if (!current(run)) return completion;
    if (!run.output) { fail(run, blocked()); return completion; }
    watchdog(run);
    Promise.all([run.output.resumed, run.output.decoded]).then(async ([, decoded]) => {
      if (!current(run)) return;
      const context = run.output.context;
      // Opening a capture device can interrupt an already-unlocked Safari
      // output context. Resume that same context after the device has settled.
      if (context.state !== 'running') await context.resume();
      if (!current(run)) return;
      if (context.state !== 'running') throw blocked();
      run.buffer = decoded;
      run.offset = Math.min(offset, Math.max(0, decoded.duration - 0.001));
      const source = context.createBufferSource();
      run.source = source;
      source.buffer = decoded;
      source.connect(context.destination);
      source.onended = () => {
        if (!current(run)) return;
        offset = decoded.duration;
        releaseRun(run);
        notify({ ...caption(offset), position: offset, playing: false, loading: false, paused: false, ended: true });
      };
      run.startedAt = context.currentTime;
      source.start(0, run.offset);
      if (!current(run)) return;
      watchdog(run);
      run.clock = setInterval(() => {
        if (!current(run)) return;
        const time = position(run);
        if (time > run.lastTime) {
          run.lastTime = time;
          watchdog(run);
          // Safari can report "running" while its output clock is frozen.
          // Confirm actual progress before showing a speaking ring or captions.
          if (!state.playing) notify({ playing: true, loading: false, position: time });
        }
        const next = caption(time);
        if (next.index !== state.index) notify({ ...next, position: time });
      }, 80);
    }).catch(error => fail(run, error));
    return completion;
  }

  function pause() {
    if (destroyed || !active) return;
    offset = position(active);
    releaseRun(active);
    notify({ ...caption(offset), position: offset, playing: false, loading: false, paused: true, ended: false });
  }

  function releaseOutput() {
    const resource = output;
    output = null;
    if (resource) {
      resource.context.onstatechange = null;
      try { Promise.resolve(resource.context.close()).catch(() => {}); } catch { /* Already closed. */ }
    }
    download?.controller.abort();
    download = null;
  }

  function stop() {
    if (destroyed) return;
    if (active) pause();
    releaseOutput();
  }

  function destroy() {
    if (destroyed) return;
    stop();
    destroyed = true;
    buffer = null;
  }

  return { prepare, activate, play, pause, stop, destroy };
}
