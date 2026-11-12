import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOnboardingNarration, NARRATION_TEXT } from '../src/lib/onboarding-narration.js';
import manifest from '../src/assets/onboarding/manifest.json';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nextMicrotask = async () => { await Promise.resolve(); await Promise.resolve(); };
let clips, playResults, narrations;

beforeEach(() => {
  clips = [];
  playResults = [];
  narrations = [];
  vi.stubGlobal('Audio', class {
    constructor(src) {
      this.src = src;
      this.currentTime = 0;
      this.muted = false;
      this.load = vi.fn();
      this.pause = vi.fn();
      this.play = vi.fn(() => {
        const result = playResults.shift();
        if (result?.throwError) throw result.throwError;
        return result ?? Promise.resolve();
      });
      clips.push(this);
    }
  });
});

afterEach(() => {
  narrations.forEach(narration => narration.destroy());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const onChange = vi.fn();
  const narration = createOnboardingNarration({ onChange });
  narrations.push(narration);
  return { narration, onChange, state: () => onChange.mock.calls.at(-1)[0] };
}

function advanceAudio(audio, seconds) {
  audio.currentTime = seconds;
  audio.ontimeupdate();
}

describe('fixed onboarding narration', () => {
  it('publishes its initial state without starting audio', () => {
    const { state } = setup();
    expect(clips).toHaveLength(0);
    expect(state()).toMatchObject({ kind: null, index: -1, text: '', playing: false, loading: false, blocked: false, error: '', ended: false });
  });

  it('preloads the complete guide silently and reuses it when the guide opens', async () => {
    const { narration, state } = setup();
    narration.prepare('guide');
    narration.prepare('guide');
    expect(clips).toHaveLength(1);
    const audio = clips[0];
    expect(audio.src).toContain('guide-full.wav');
    expect(audio.preload).toBe('auto');
    expect(audio.load).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ kind: null, playing: false, loading: false });
    const completion = narration.play('guide');
    await nextMicrotask();
    expect(clips).toHaveLength(1);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ kind: 'guide', index: 0, playing: true, loading: false });
    narration.stop();
    await completion;
  });

  it.each(['stop', 'destroy'])('%s releases silent preloading without allowing a late sound', async action => {
    const { narration } = setup();
    narration.prepare('guide');
    const audio = clips[0];
    narration[action]();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.muted).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
    if (action === 'stop') {
      const completion = narration.play('guide');
      expect(clips).toHaveLength(2);
      narration.stop();
      await completion;
    } else {
      narration.prepare('guide');
      await narration.play('guide');
      expect(clips).toHaveLength(1);
    }
  });

  it('plays permission clips in sequence while retaining one media element', async () => {
    const { narration, state } = setup();
    const completion = narration.play('permission');
    const finished = vi.fn();
    completion.then(finished);
    for (let index = 0; index < NARRATION_TEXT.permission.length; index += 1) {
      await nextMicrotask();
      expect(state()).toMatchObject({ kind: 'permission', index, text: NARRATION_TEXT.permission[index], playing: true, loading: false, ended: false });
      expect(clips[0].src).toContain(`permission-${index + 1}.wav`);
      expect(finished).not.toHaveBeenCalled();
      clips[0].onended();
    }
    await completion;
    expect(clips).toHaveLength(1);
    expect(clips[0].play).toHaveBeenCalledTimes(NARRATION_TEXT.permission.length);
    expect(state()).toMatchObject({ index: NARRATION_TEXT.permission.length - 1, playing: false, loading: false, ended: true });
    expect(finished).toHaveBeenCalledOnce();
  });

  it('plays one continuous guide track and changes all subtitles from its actual media position', async () => {
    const { narration, state } = setup();
    const completion = narration.play('guide');
    const audio = clips[0];
    const originalSource = audio.src;
    const finished = vi.fn();
    completion.then(finished);
    await nextMicrotask();
    expect(originalSource).toContain('guide-full.wav');
    for (const cue of manifest.guide_track.cues) {
      if (cue.index > 0) {
        advanceAudio(audio, cue.start_ms / 1000 - 0.01);
        expect(state().index).toBe(cue.index - 1);
      }
      advanceAudio(audio, cue.start_ms / 1000);
      expect(state()).toMatchObject({ kind: 'guide', index: cue.index, text: NARRATION_TEXT.guide[cue.index], playing: true, ended: false });
      expect(audio.src).toBe(originalSource);
      expect(audio.play).toHaveBeenCalledOnce();
      expect(finished).not.toHaveBeenCalled();
    }
    audio.onended();
    await completion;
    expect(clips).toHaveLength(1);
    expect(state()).toMatchObject({ index: 2, text: NARRATION_TEXT.guide[2], playing: false, loading: false, ended: true });
    expect(finished).toHaveBeenCalledOnce();
  });

  it('waits for playback to start and does not advance subtitles on elapsed wall time', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    playResults.push(pending.promise);
    const { narration, state } = setup();
    const completion = narration.play('guide');
    expect(state()).toMatchObject({ index: 0, text: NARRATION_TEXT.guide[0], playing: false, loading: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(state()).toMatchObject({ index: 0, playing: false, loading: true });
    clips[0].onplaying();
    expect(state()).toMatchObject({ index: 0, playing: true, loading: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().index).toBe(0);
    pending.resolve();
    await nextMicrotask();
    expect(state().index).toBe(0);
    narration.stop();
    await completion;
  });

  it('turns an eight-second playback stall into a retryable error and fences late recovery', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    playResults.push(pending.promise);
    const { narration, onChange, state } = setup();
    const completion = narration.play('guide');
    const audio = clips[0];
    const latePlaying = audio.onplaying;
    const lateProgress = audio.ontimeupdate;
    const lateEnded = audio.onended;
    await vi.advanceTimersByTimeAsync(8000);
    await completion;
    expect(state()).toMatchObject({ index: 0, playing: false, loading: false, blocked: false, ended: false });
    expect(state().error).not.toBe('');
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.muted).toBe(true);
    const notifications = onChange.mock.calls.length;
    audio.currentTime = 12;
    latePlaying();
    lateProgress();
    lateEnded();
    pending.resolve();
    await nextMicrotask();
    expect(onChange).toHaveBeenCalledTimes(notifications);
    expect(audio.muted).toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it('keeps a progressing guide alive and only times out after media progress stops', async () => {
    vi.useFakeTimers();
    const { narration, state } = setup();
    const completion = narration.play('guide');
    const audio = clips[0];
    await nextMicrotask();
    await vi.advanceTimersByTimeAsync(7000);
    advanceAudio(audio, 2);
    await vi.advanceTimersByTimeAsync(7000);
    expect(state()).toMatchObject({ playing: true, error: '' });
    advanceAudio(audio, 4);
    expect(state().index).toBe(1);
    await vi.advanceTimersByTimeAsync(8000);
    await completion;
    expect(state()).toMatchObject({ index: 1, playing: false, loading: false, ended: false });
    expect(state().error).not.toBe('');
  });

  it('preserves the current caption during buffering and ignores repeated updates with no media progress', async () => {
    vi.useFakeTimers();
    const { narration, state } = setup();
    const completion = narration.play('guide');
    const audio = clips[0];
    await nextMicrotask();
    advanceAudio(audio, 4);
    audio.onwaiting();
    expect(state()).toMatchObject({ index: 1, text: NARRATION_TEXT.guide[1], playing: false, loading: true });
    await vi.advanceTimersByTimeAsync(4000);
    advanceAudio(audio, 4);
    expect(state()).toMatchObject({ index: 1, playing: false, loading: true, error: '' });
    await vi.advanceTimersByTimeAsync(4000);
    await completion;
    expect(state()).toMatchObject({ index: 1, playing: false, loading: false, ended: false });
    expect(state().error).not.toBe('');
    expect(audio.muted).toBe(true);
  });

  it('resolves blocked playback and allows a manual replay from the first subtitle', async () => {
    const { narration, state } = setup();
    playResults.push(Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    await narration.play('guide');
    expect(state()).toMatchObject({ blocked: true, playing: false, loading: false, error: '', index: 0, ended: false });
    expect(clips[0].pause).toHaveBeenCalled();
    const replay = narration.play('guide');
    await nextMicrotask();
    expect(clips).toHaveLength(2);
    expect(state()).toMatchObject({ blocked: false, playing: true, loading: false, error: '', index: 0 });
    clips.at(-1).onended();
    await replay;
    expect(state().ended).toBe(true);
  });

  it('makes a failed audio download retryable without rejecting the caller', async () => {
    const { narration, state } = setup();
    const completion = narration.play('guide');
    clips[0].error = { code: 2, message: 'transport details must not reach UI' };
    clips[0].onerror();
    await completion;
    expect(state()).toMatchObject({ blocked: false, playing: false, loading: false, ended: false });
    expect(state().error).toContain('可以直接继续');
    expect(state().error).not.toContain('transport');
    narration.play('guide');
    await nextMicrotask();
    expect(state()).toMatchObject({ error: '', index: 0, playing: true });
  });

  it('stops and rewinds synchronously while fencing a late play resolution', async () => {
    const pending = deferred();
    playResults.push(pending.promise);
    const { narration, onChange, state } = setup();
    const completion = narration.play('guide');
    const clip = clips[0];
    const lateEnded = clip.onended;
    const lateProgress = clip.ontimeupdate;
    clip.currentTime = 2.7;
    narration.stop();
    expect(clip.pause).toHaveBeenCalled();
    expect(clip.muted).toBe(true);
    expect(clip.currentTime).toBe(0);
    expect(state()).toMatchObject({ playing: false, loading: false, ended: false });
    const notifications = onChange.mock.calls.length;
    await completion;
    pending.resolve();
    lateEnded();
    lateProgress();
    await nextMicrotask();
    expect(clips).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(notifications);
  });

  it('ignores old failures and ended events after another narration starts', async () => {
    const pending = deferred();
    playResults.push(pending.promise);
    const { narration, state } = setup();
    const first = narration.play('permission');
    const oldClip = clips[0];
    const oldEnded = oldClip.onended;
    const second = narration.play('guide');
    await first;
    pending.reject(new DOMException('late blocked', 'NotAllowedError'));
    oldEnded();
    await nextMicrotask();
    expect(clips).toHaveLength(2);
    expect(state()).toMatchObject({ kind: 'guide', index: 0, blocked: false, playing: true });
    expect(oldClip.muted).toBe(true);
    expect(clips[1].muted).toBe(false);
    narration.stop();
    await second;
  });

  it('destroys without further callbacks and never plays again', async () => {
    const pending = deferred();
    playResults.push(pending.promise);
    const { narration, onChange } = setup();
    const completion = narration.play('guide');
    const lateEnded = clips[0].onended;
    const lateProgress = clips[0].ontimeupdate;
    const notifications = onChange.mock.calls.length;
    narration.destroy();
    await completion;
    pending.resolve();
    lateEnded();
    lateProgress();
    await narration.play('guide');
    narration.prepare('guide');
    narration.stop();
    await nextMicrotask();
    expect(onChange).toHaveBeenCalledTimes(notifications);
    expect(clips).toHaveLength(1);
    expect(clips[0].muted).toBe(true);
  });

  it('handles synchronous play errors and missing audio support without hanging', async () => {
    const { narration, state } = setup();
    playResults.push({ throwError: new DOMException('blocked', 'NotAllowedError') });
    await narration.play('permission');
    expect(state().blocked).toBe(true);
    vi.stubGlobal('Audio', undefined);
    await narration.play('guide');
    expect(state()).toMatchObject({ playing: false, loading: false, blocked: false, ended: false });
    expect(state().error).not.toBe('');
  });

  it('honors a synchronous cancellation when the subtitle listener receives loading state', async () => {
    let narration;
    narration = createOnboardingNarration({ onChange: state => {
      if (state.loading) narration.stop();
    } });
    narrations.push(narration);
    await narration.play('guide');
    expect(clips.every(clip => clip.play.mock.calls.length === 0)).toBe(true);
  });

  it('keeps permission playback active when an old sentence promise settles late', async () => {
    const pending = deferred();
    playResults.push(pending.promise);
    const { narration, state } = setup();
    const completion = narration.play('permission');
    const firstEnded = clips[0].onended;
    firstEnded();
    expect(state().index).toBe(1);
    pending.resolve();
    firstEnded();
    await nextMicrotask();
    expect(state()).toMatchObject({ index: 1, playing: true });
    expect(clips).toHaveLength(1);
    expect(clips[0].pause).not.toHaveBeenCalled();
    expect(clips[0].muted).toBe(false);
    narration.stop();
    await completion;
  });
});
