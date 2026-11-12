import narrationText from '../content/voice-onboarding.json';
import manifest from '../assets/onboarding/manifest.json';
import permissionOne from '../assets/onboarding/permission-1.wav?url';
import permissionTwo from '../assets/onboarding/permission-2.wav?url';
import guideFull from '../assets/onboarding/guide-full.wav?url';
import { createGuideAudio } from './onboarding-guide-audio.js';

export const NARRATION_TEXT = Object.freeze({
  permission: Object.freeze([...narrationText.permission]),
  guide: Object.freeze([...narrationText.guide]),
});

const AUDIO = Object.freeze({ permission: [permissionOne, permissionTwo], guide: [guideFull] });
const GUIDE_CUES = manifest.guide_track.cues;
const STALL_TIMEOUT_MS = 8000;

/** Preload silently, then play the guide as one track with media-clock captions. */
export function createOnboardingNarration({ onChange = () => {} } = {}) {
  let destroyed = false;
  let active = null;
  const prepared = new Map();
  let state = {
    kind: null, index: -1, text: '', playing: false, loading: false,
    paused: false, blocked: false, error: '', ended: false,
  };

  function notify(patch) {
    state = { ...state, ...patch };
    if (!destroyed) onChange({ ...state });
  }
  const guide = globalThis.AudioContext || globalThis.webkitAudioContext
    ? createGuideAudio({ onChange: notify }) : null;

  function silence(audio) {
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    audio.onplaying = null;
    audio.onwaiting = null;
    audio.ontimeupdate = null;
    // Pending play promises and old media events must never restart a cancelled run.
    audio.muted = true;
    try { audio.pause(); } catch { /* Already released. */ }
    try { audio.currentTime = 0; } catch { /* Metadata may not yet be loaded. */ }
  }

  function settle(run) {
    if (active === run) active = null;
    clearTimeout(run.stallTimer);
    silence(run.audio);
    run.audio = null;
    run.resolve();
  }

  function cancel() {
    const run = active;
    active = null;
    if (run) settle(run);
  }

  function clearPrepared() {
    prepared.forEach(silence);
    prepared.clear();
  }

  function current(run, audio, index = run.trackIndex) {
    return !destroyed && active === run && run.audio === audio && run.trackIndex === index;
  }

  function fail(run, audio, index, error) {
    if (!current(run, audio, index)) return;
    const blocked = error?.name === 'NotAllowedError';
    settle(run);
    notify({
      playing: false, loading: false, blocked,
      error: blocked ? '' : '讲解暂时没有播放出来，您可以重播，也可以直接继续。',
      ended: false,
    });
  }

  function watchProgress(run, audio, index) {
    clearTimeout(run.stallTimer);
    run.stallTimer = setTimeout(() => fail(run, audio, index, new Error('Narration stalled')), STALL_TIMEOUT_MS);
  }

  function prepare(kind) {
    if (kind === 'guide' && guide) { guide.prepare(); return; }
    if (destroyed || prepared.has(kind) || active?.kind === kind) return;
    if (!Object.hasOwn(AUDIO, kind)) throw new TypeError('Unknown narration kind');
    let audio;
    try {
      audio = new Audio(AUDIO[kind][0]);
      audio.preload = 'auto';
      audio.load();
      prepared.set(kind, audio);
    } catch {
      silence(audio);
      // Playback retains the normal error/retry UI if silent preloading fails.
    }
  }

  function next(run, trackIndex) {
    if (destroyed || active !== run) return;
    if (trackIndex >= AUDIO[run.kind].length) {
      settle(run);
      notify({ playing: false, loading: false, blocked: false, error: '', ended: true });
      return;
    }

    run.trackIndex = trackIndex;
    run.lastTime = -1;
    notify({
      kind: run.kind, index: trackIndex, text: NARRATION_TEXT[run.kind][trackIndex],
      playing: false, loading: true, paused: false, blocked: false, error: '', ended: false,
    });
    if (destroyed || active !== run) return;
    let audio = run.audio;
    try {
      // Guide playback never switches src between captions. Permission narration
      // retains its existing two clips, sharing the same activated element.
      if (audio && trackIndex > 0) audio.src = AUDIO[run.kind][trackIndex];
      else if (!audio) audio = new Audio(AUDIO[run.kind][trackIndex]);
      audio.preload = 'auto';
      run.audio = audio;
      const started = () => {
        if (!current(run, audio, trackIndex)) return;
        notify({ playing: true, loading: false, position: Number(audio.currentTime) || 0 });
      };
      audio.onplaying = started;
      audio.onwaiting = () => {
        if (current(run, audio, trackIndex)) notify({ playing: false, loading: true, position: Number(audio.currentTime) || 0 });
      };
      audio.ontimeupdate = () => {
        if (!current(run, audio, trackIndex)) return;
        const time = Number(audio.currentTime) || 0;
        if (time > run.lastTime) {
          run.lastTime = time;
          watchProgress(run, audio, trackIndex);
        }
        if (run.kind !== 'guide') return;
        let index = 0;
        for (let i = 1; i < GUIDE_CUES.length; i += 1) {
          if (time * 1000 < GUIDE_CUES[i].start_ms) break;
          index = i;
        }
        if (index !== state.index) notify({ index, text: NARRATION_TEXT.guide[index], position: time });
      };
      audio.onended = () => {
        if (!current(run, audio, trackIndex)) return;
        if (run.kind === 'guide') {
          const index = NARRATION_TEXT.guide.length - 1;
          notify({ index, text: NARRATION_TEXT.guide[index] });
        }
        next(run, trackIndex + 1);
      };
      audio.onerror = () => fail(run, audio, trackIndex, audio.error);
      if (!current(run, audio)) return;
      watchProgress(run, audio, trackIndex);
      const playback = audio.play();
      Promise.resolve(playback).then(
        () => { if (!current(run, audio)) silence(audio); else started(); },
        error => fail(run, audio, trackIndex, error),
      );
    } catch (error) {
      fail(run, audio, trackIndex, error);
    }
  }

  function play(kind) {
    if (destroyed) return Promise.resolve();
    if (!Object.hasOwn(AUDIO, kind)) return Promise.reject(new TypeError('Unknown narration kind'));
    if (kind === 'guide' && guide) { cancel(); return guide.play(); }
    cancel();
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    const audio = prepared.get(kind) || null;
    prepared.delete(kind);
    const run = { kind, resolve, audio, trackIndex: -1, stallTimer: null, lastTime: -1 };
    active = run;
    next(run, 0);
    return completion;
  }

  function stop() {
    if (destroyed) return;
    cancel();
    clearPrepared();
    if (guide) guide.stop();
    notify({ playing: false, loading: false, paused: state.kind === 'guide' && !state.ended && state.index >= 0,
      blocked: false, error: '', ended: state.ended });
  }

  function activate(kind) {
    if (destroyed) return;
    if (kind === 'guide' && guide) guide.activate();
    else prepare(kind);
  }

  function pause() {
    if (state.kind === 'guide' && guide) guide.pause();
    else stop();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    guide?.destroy();
    cancel();
    clearPrepared();
  }

  notify({});
  return { prepare, activate, play, pause, stop, destroy };
}
