import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuideAudio } from '../src/lib/onboarding-guide-audio.js';
import manifest from '../src/assets/onboarding/manifest.json';

const track = manifest.guide_track;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
};
const audioResponse = () => ({
  ok: true,
  arrayBuffer: vi.fn(async () => new ArrayBuffer(16)),
});

let contexts, sources, players, gesture, resumeResults, decodeResults, FakeAudioContext;

beforeEach(() => {
  vi.useFakeTimers();
  contexts = [];
  sources = [];
  players = [];
  gesture = false;
  resumeResults = [];
  decodeResults = [];
  FakeAudioContext = class {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = {};
      this.resume = vi.fn(() => {
        // Safari grants the unlock only while the originating click is active.
        if (!gesture && this.state !== 'running') {
          return Promise.reject(new DOMException('User activation required', 'NotAllowedError'));
        }
        const result = resumeResults.shift() ?? Promise.resolve();
        return result.then(() => {
          if (this.state !== 'closed') this.state = 'running';
        });
      });
      this.close = vi.fn(async () => { this.state = 'closed'; });
      this.decodeAudioData = vi.fn(() => decodeResults.shift()
        ?? Promise.resolve({ duration: track.duration_ms / 1000 }));
      this.createBufferSource = vi.fn(() => {
        const source = {
          buffer: null,
          onended: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        sources.push(source);
        return source;
      });
      contexts.push(this);
    }
  };
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('webkitAudioContext', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
});

afterEach(() => {
  players.forEach(player => player.destroy());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const onChange = vi.fn();
  const player = createGuideAudio({ onChange });
  players.push(player);
  return { player, onChange, state: () => onChange.mock.calls.at(-1)?.[0] };
}

function activate(player) {
  gesture = true;
  try { player.activate(); } finally { gesture = false; }
}

async function start(player) {
  player.prepare();
  await flush();
  activate(player);
  const completion = player.play();
  await flush();
  await advancePlayback();
  return { completion, context: contexts.at(-1), source: sources.at(-1) };
}

async function advancePlayback(context = contexts.at(-1), seconds = 0.02) {
  context.currentTime += seconds;
  await vi.advanceTimersByTimeAsync(100);
}

describe('Safari guide audio activation and lifecycle', () => {
  it('prepares the full track once without opening an audio context or starting sound', async () => {
    const { player } = setup();
    player.prepare();
    player.prepare();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain('guide-full.wav');
    expect(contexts).toHaveLength(0);
    expect(sources).toHaveLength(0);
  });

  it('unlocks synchronously in the click and plays after the asynchronous microphone permission completes', async () => {
    const { player, state } = setup();
    const microphone = deferred();
    player.prepare();
    await flush();

    gesture = true;
    player.activate();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(0);
    gesture = false;
    await flush();
    expect(contexts[0].state).toBe('running');
    expect(sources).toHaveLength(0);

    const afterPermission = microphone.promise.then(() => player.play());
    microphone.resolve();
    await flush();
    expect(contexts).toHaveLength(1);
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ playing: false, loading: true });
    await advancePlayback();
    expect(state()).toMatchObject({ kind: 'guide', index: 0, playing: true, loading: false, blocked: false });
    sources[0].onended();
    await afterPermission;
    expect(state()).toMatchObject({ playing: false, ended: true });
  });

  it('reports blocked audio when play is attempted without a gesture unlock', async () => {
    const { player, state } = setup();
    await player.play();
    expect(sources.every(source => source.start.mock.calls.length === 0)).toBe(true);
    expect(state()).toMatchObject({ playing: false, loading: false, blocked: true, ended: false });
  });

  it('does not claim playback or start a source before both unlock and decoding finish', async () => {
    const resume = deferred();
    const decode = deferred();
    resumeResults.push(resume.promise);
    decodeResults.push(decode.promise);
    const { player, state } = setup();
    player.prepare();
    await flush();
    activate(player);
    const completion = player.play();
    await flush();
    expect(state()).toMatchObject({ playing: false, loading: true });
    expect(sources).toHaveLength(0);
    resume.resolve();
    await flush();
    expect(state()).toMatchObject({ playing: false, loading: true });
    expect(sources).toHaveLength(0);
    decode.resolve({ duration: track.duration_ms / 1000 });
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ playing: false, loading: true });
    await advancePlayback();
    expect(state()).toMatchObject({ playing: true, loading: false });
    sources[0].onended();
    await completion;
  });

  it('uses the WebKit AudioContext fallback when the standard constructor is unavailable', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', FakeAudioContext);
    const { player, state } = setup();
    const { completion, source } = await start(player);
    expect(contexts).toHaveLength(1);
    expect(source.start).toHaveBeenCalledOnce();
    expect(state().playing).toBe(true);
    source.onended();
    await completion;
  });

  it('advances captions with the audio context clock, never by elapsed wall time', async () => {
    const { player, state } = setup();
    player.prepare();
    await flush();
    activate(player);
    contexts[0].currentTime = 100;
    const completion = player.play();
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(state()).toMatchObject({ index: 0, text: track.cues[0].text, playing: false, loading: true });
    for (const cue of track.cues.slice(1)) {
      contexts[0].currentTime = 100 + cue.start_ms / 1000 - 0.01;
      await vi.advanceTimersByTimeAsync(250);
      expect(state().index).toBe(cue.index - 1);
      contexts[0].currentTime = 100 + cue.start_ms / 1000 + 0.01;
      await vi.advanceTimersByTimeAsync(250);
      expect(state()).toMatchObject({ index: cue.index, text: cue.text, playing: true });
    }
    sources[0].onended();
    await completion;
    expect(state()).toMatchObject({ index: 2, text: track.cues[2].text, ended: true, playing: false });
  });

  it('pauses and resumes from the media offset while reusing the unlocked context', async () => {
    const { player, state } = setup();
    const { completion, context, source } = await start(player);
    context.currentTime = 4.2;
    await vi.advanceTimersByTimeAsync(250);
    const lateEnd = source.onended;
    player.pause();
    await completion;
    expect(source.stop).toHaveBeenCalled();
    expect(source.disconnect).toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ paused: true, playing: false, index: 1, ended: false });

    context.currentTime = 20;
    const resumed = player.play();
    await flush();
    expect(contexts).toHaveLength(1);
    expect(sources).toHaveLength(2);
    expect(sources[1].start.mock.calls[0][1]).toBeCloseTo(4.2, 5);
    expect(state()).toMatchObject({ paused: false, playing: false, loading: true, index: 1 });
    await advancePlayback();
    expect(state()).toMatchObject({ paused: false, playing: true, index: 1 });
    lateEnd();
    expect(state()).toMatchObject({ playing: true, ended: false });
    context.currentTime = 27;
    await vi.advanceTimersByTimeAsync(250);
    expect(state().index).toBe(2);
    sources[1].onended();
    await resumed;
  });

  it('starts a finished guide again from the beginning', async () => {
    const { player, state } = setup();
    const { completion, source } = await start(player);
    source.onended();
    await completion;
    expect(state().ended).toBe(true);
    const replay = player.play();
    await flush();
    expect(sources).toHaveLength(2);
    expect(sources[1].start.mock.calls[0][1] ?? 0).toBe(0);
    await advancePlayback();
    expect(state()).toMatchObject({ index: 0, playing: true, ended: false, paused: false });
    sources[1].onended();
    await replay;
  });

  it('stops and closes the context while retaining the caption and offset for a deliberate return', async () => {
    const { player, state } = setup();
    const { completion, source, context } = await start(player);
    context.currentTime = 5;
    await vi.advanceTimersByTimeAsync(250);
    player.stop();
    await completion;
    expect(source.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ index: 1, text: track.cues[1].text, playing: false, ended: false });

    activate(player);
    const resumed = player.play();
    await flush();
    expect(contexts).toHaveLength(2);
    expect(sources[1].start.mock.calls[0][1]).toBeCloseTo(5, 5);
    await advancePlayback();
    expect(state()).toMatchObject({ playing: true, index: 1 });
    sources[1].onended();
    await resumed;
  });

  it.each(['stop', 'destroy'])('%s fences a pending resume and its late success', async action => {
    const pending = deferred();
    resumeResults.push(pending.promise);
    const { player, onChange } = setup();
    player.prepare();
    await flush();
    activate(player);
    const completion = player.play();
    await flush();
    player[action]();
    const notifications = onChange.mock.calls.length;
    pending.resolve();
    await flush();
    await completion;
    expect(contexts[0].close).toHaveBeenCalled();
    expect(sources).toHaveLength(0);
    expect(onChange).toHaveBeenCalledTimes(notifications);
  });

  it.each(['stop', 'destroy'])('%s aborts a pending download and ignores its late response', async action => {
    const download = deferred();
    fetch.mockReturnValueOnce(download.promise);
    const { player, onChange } = setup();
    player.prepare();
    activate(player);
    const completion = player.play();
    await flush();
    const signal = fetch.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    player[action]();
    expect(signal.aborted).toBe(true);
    const notifications = onChange.mock.calls.length;
    download.resolve(audioResponse());
    await flush();
    await completion;
    expect(sources).toHaveLength(0);
    expect(contexts[0].close).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(notifications);
  });

  it('ignores a late decode result after disposal and never emits subsequent state', async () => {
    const decode = deferred();
    decodeResults.push(decode.promise);
    const { player, onChange } = setup();
    player.prepare();
    await flush();
    activate(player);
    const completion = player.play();
    await flush();
    player.destroy();
    const notifications = onChange.mock.calls.length;
    decode.resolve({ duration: track.duration_ms / 1000 });
    await flush();
    await completion;
    activate(player);
    player.prepare();
    await player.play();
    expect(sources).toHaveLength(0);
    expect(contexts).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(notifications);
  });

  it('turns a stalled download into a bounded error and allows a fresh retry', async () => {
    const download = deferred();
    fetch.mockReturnValueOnce(download.promise);
    const { player, state } = setup();
    player.prepare();
    activate(player);
    const completion = player.play();
    await flush();
    await vi.advanceTimersByTimeAsync(8000);
    await completion;
    expect(state()).toMatchObject({ playing: false, loading: false, ended: false });
    expect(state().error || state().blocked).toBeTruthy();
    expect(sources).toHaveLength(0);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);

    activate(player);
    const retry = player.play();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    await advancePlayback();
    expect(state()).toMatchObject({ playing: true, loading: false, blocked: false, error: '' });
    download.resolve(audioResponse());
    await flush();
    expect(sources).toHaveLength(1);
    sources[0].onended();
    await retry;
  });

  it('bounds an unresolved Safari resume and fences it after a successful retry', async () => {
    const resume = deferred();
    resumeResults.push(resume.promise);
    const { player, state } = setup();
    player.prepare();
    await flush();
    activate(player);
    const completion = player.play();
    await flush();
    await vi.advanceTimersByTimeAsync(8000);
    await completion;
    expect(state()).toMatchObject({ playing: false, loading: false });
    expect(state().error || state().blocked).toBeTruthy();
    expect(sources).toHaveLength(0);

    activate(player);
    const retry = player.play();
    await flush();
    await advancePlayback();
    expect(state()).toMatchObject({ playing: true, loading: false, blocked: false, error: '' });
    resume.resolve();
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledOnce();
    sources[0].onended();
    await retry;
  });

  it('never reports playback for a running context whose clock is frozen, times out, and allows a real-clock retry', async () => {
    const { player, state, onChange } = setup();
    player.prepare();
    await flush();
    activate(player);
    const completion = player.play();
    await flush();
    const frozen = contexts[0];
    const lateStateChange = frozen.onstatechange;
    const lateEnd = sources[0].onended;
    expect(frozen.state).toBe('running');
    expect(sources[0].start).toHaveBeenCalledOnce();
    lateStateChange();
    await vi.advanceTimersByTimeAsync(4000);
    lateStateChange();
    expect(state()).toMatchObject({ playing: false, loading: true, index: 0, text: track.cues[0].text });
    expect(onChange.mock.calls.every(([next]) => !next.playing)).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    await completion;
    expect(state()).toMatchObject({ playing: false, loading: false, index: 0, ended: false });
    expect(state().error).not.toBe('');
    expect(frozen.close).toHaveBeenCalledOnce();

    activate(player);
    const retry = player.play();
    await flush();
    expect(contexts).toHaveLength(2);
    expect(sources).toHaveLength(2);
    expect(state()).toMatchObject({ playing: false, loading: true, index: 0 });
    frozen.currentTime = 12;
    lateStateChange();
    lateEnd();
    expect(state()).toMatchObject({ playing: false, loading: true, index: 0, ended: false });
    await advancePlayback();
    expect(state()).toMatchObject({ playing: true, loading: false, blocked: false, error: '' });
    sources[1].onended();
    await retry;
  });

  it('deduplicates play while the guide is already starting or playing', async () => {
    const { player } = setup();
    player.prepare();
    await flush();
    activate(player);
    const first = player.play();
    const second = player.play();
    await flush();
    const third = player.play();
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledOnce();
    sources[0].onended();
    await Promise.all([first, second, third]);
  });
});
