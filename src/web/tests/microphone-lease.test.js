import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMicrophoneLease } from '../src/lib/microphone-lease.js';
import { createRtc, preflightMicrophone, startMicrophoneMeter } from '../src/lib/realtime-web-rtc.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const makeTrack = (kind = 'audio') => ({
  kind, enabled: true, readyState: 'live',
  stop: vi.fn(function () { this.readyState = 'ended'; }),
});
const makeStream = (tracks = [makeTrack()]) => ({
  getTracks: () => tracks,
  getAudioTracks: () => tracks.filter(track => track.kind === 'audio'),
});
const credentials = {
  room_id: '12345678', sdk_app_id: 1400000001,
  user_id: 'fixture-user', user_sig: 'fixture-ticket', private_map_key: 'fixture-room-ticket',
};
let getUserMedia, leases, calls, contexts, sdkInstances;
function lease(options) { const value = createMicrophoneLease(options); leases.push(value); return value; }
function rtc(options) { const value = createRtc(options); calls.push(value); return value; }
function installMeter({ amplitude = 0.25, bytes = false, broken = false } = {}) {
  class Context {
    constructor() {
      this.source = { connect: vi.fn(), disconnect: vi.fn() };
      this.analyser = { fftSize: 0, disconnect: vi.fn() };
      if (bytes) this.analyser.getByteTimeDomainData = vi.fn(samples => samples.fill(128 + amplitude * 128));
      else this.analyser.getFloatTimeDomainData = vi.fn(samples => samples.fill(amplitude));
      this.createMediaStreamSource = vi.fn(() => { if (broken) throw new Error('meter unavailable'); return this.source; });
      this.createAnalyser = vi.fn(() => this.analyser);
      this.resume = vi.fn().mockResolvedValue();
      this.close = vi.fn().mockResolvedValue();
      contexts.push(this);
    }
  }
  vi.stubGlobal('AudioContext', Context);
}

beforeEach(() => {
  leases = []; calls = []; contexts = []; sdkInstances = [];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('RTCPeerConnection', function () {});
  getUserMedia = vi.fn().mockImplementation(async () => makeStream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', undefined);
  vi.stubGlobal('TRTC', {
    EVENT: {}, isSupported: vi.fn().mockResolvedValue({ result: true }), setLogLevel: vi.fn(),
    create: vi.fn(() => {
      const instance = Object.fromEntries(['on', 'off', 'destroy', 'setRemoteAudioVolume'].map(name => [name, vi.fn()]));
      for (const name of ['enterRoom', 'startLocalAudio', 'updateLocalAudio', 'stopLocalAudio', 'muteRemoteAudio', 'exitRoom']) {
        instance[name] = vi.fn().mockResolvedValue();
      }
      instance.getAudioTrack = vi.fn(() => instance.startLocalAudio.mock.calls[0]?.[0]?.option.audioTrack);
      sdkInstances.push(instance);
      return instance;
    }),
  });
});
afterEach(async () => {
  for (const value of leases) value.close();
  await Promise.all(calls.map(value => value.close()));
  vi.unstubAllGlobals();
});

describe('onboarding microphone ownership', () => {
  it('does not request a microphone until prepare, then shares pending and live capture', async () => {
    const permission = deferred(), stream = makeStream();
    getUserMedia.mockReturnValue(permission.promise);
    const microphone = lease();
    expect(getUserMedia).not.toHaveBeenCalled();
    const preparing = microphone.prepare();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
    expect(microphone.prepare()).toBe(preparing);
    permission.resolve(stream);
    expect(await preparing).toBe(stream);
    expect(await microphone.prepare()).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(TRTC.create).not.toHaveBeenCalled();
  });

  it('stops capture synchronously when the guide closes', async () => {
    const microphone = lease(), stream = await microphone.prepare();
    microphone.close();
    expect(stream.getAudioTracks()[0].readyState).toBe('ended');
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
  });

  it('closes a late permission result without touching a newer pending request', async () => {
    const first = deferred(), second = deferred();
    getUserMedia.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const microphone = lease(), oldStream = makeStream(), newStream = makeStream();
    const oldRequest = microphone.prepare();
    const rejected = expect(oldRequest).rejects.toMatchObject({ code: 'RTC_CLOSED' });
    microphone.close();
    const newRequest = microphone.prepare();
    first.resolve(oldStream);
    await rejected;
    expect(oldStream.getAudioTracks()[0].readyState).toBe('ended');
    expect(microphone.prepare()).toBe(newRequest);
    second.resolve(newStream);
    expect(await newRequest).toBe(newStream);
    expect(microphone.take()).toBe(newStream);
    expect(newStream.getAudioTracks()[0].readyState).toBe('live');
    newStream.getAudioTracks()[0].stop();
  });

  it('cannot let an older rejected permission request clear a newer request', async () => {
    const first = deferred(), second = deferred();
    getUserMedia.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const microphone = lease();
    const rejected = expect(microphone.prepare()).rejects.toMatchObject({ code: 'MIC_PERMISSION_DENIED' });
    microphone.close();
    const pending = microphone.prepare();
    first.reject(Object.assign(new Error('private device diagnostic'), { name: 'NotAllowedError' }));
    await rejected;
    expect(microphone.prepare()).toBe(pending);
    second.resolve(makeStream());
    await pending;
  });

  it('transfers a live stream without stopping it and cannot take it twice', async () => {
    installMeter();
    const onLevel = vi.fn(), microphone = lease({ onLevel });
    const stream = await microphone.prepare();
    vi.advanceTimersByTime(80);
    expect(onLevel).toHaveBeenLastCalledWith(0.25);
    expect(microphone.take()).toBe(stream);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(contexts[0].close).toHaveBeenCalledOnce();
    expect(() => microphone.take()).toThrow(expect.objectContaining({ code: 'MIC_UNAVAILABLE' }));
    microphone.close();
    expect(stream.getAudioTracks()[0].stop).not.toHaveBeenCalled();
    stream.getAudioTracks()[0].stop();
  });

  it('reacquires an ended microphone rather than transferring unusable capture', async () => {
    const microphone = lease(), first = await microphone.prepare();
    first.getAudioTracks()[0].stop();
    const second = await microphone.prepare();
    expect(second).not.toBe(first);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['NotAllowedError', 'MIC_PERMISSION_DENIED'], ['SecurityError', 'MIC_PERMISSION_DENIED'],
    ['NotFoundError', 'MIC_NOT_FOUND'], ['NotReadableError', 'MIC_UNAVAILABLE'],
  ])('classifies %s and allows an explicit retry', async (name, code) => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('private diagnostic'), { name }));
    const microphone = lease();
    await expect(microphone.prepare()).rejects.toMatchObject({ code });
    expect(await microphone.prepare()).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('checks the secure browser environment before requesting permission', async () => {
    vi.stubGlobal('isSecureContext', false);
    await expect(lease().prepare()).rejects.toMatchObject({ code: 'RTC_INSECURE_CONTEXT' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('releases unusable returned tracks and reports a missing microphone', async () => {
    const video = makeTrack('video');
    getUserMedia.mockResolvedValue(makeStream([video]));
    await expect(lease().prepare()).rejects.toMatchObject({ code: 'MIC_NOT_FOUND' });
    expect(video.stop).toHaveBeenCalledOnce();
  });
});

describe('microphone volume feedback', () => {
  it.each([false, true])('measures RMS with the byte fallback set to %s and has no speaker output', async bytes => {
    installMeter({ bytes });
    const onLevel = vi.fn(), microphone = lease({ onLevel });
    const stream = await microphone.prepare();
    vi.advanceTimersByTime(80);
    expect(onLevel).toHaveBeenLastCalledWith(0.25);
    expect(contexts[0].source.connect).toHaveBeenCalledExactlyOnceWith(contexts[0].analyser);
    expect(contexts[0].createMediaStreamSource).toHaveBeenCalledExactlyOnceWith(stream);
    stream.getAudioTracks()[0].enabled = false;
    vi.advanceTimersByTime(80);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    microphone.close();
    const count = onLevel.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(onLevel).toHaveBeenCalledTimes(count);
    expect(contexts[0].source.disconnect).toHaveBeenCalledOnce();
    expect(contexts[0].analyser.disconnect).toHaveBeenCalledOnce();
  });

  it('does not prevent capture when Web Audio fails', async () => {
    installMeter({ broken: true });
    const onLevel = vi.fn(), microphone = lease({ onLevel });
    expect(await microphone.prepare()).toBeTruthy();
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it('safely degrades without Web Audio and without a level callback', () => {
    const stream = makeStream(), onLevel = vi.fn();
    const stop = startMicrophoneMeter(stream, onLevel);
    expect(() => stop()).not.toThrow();
    expect(onLevel).toHaveBeenLastCalledWith(0);
    installMeter();
    startMicrophoneMeter(stream)();
    expect(contexts).toHaveLength(0);
    expect(stream.getAudioTracks()[0].stop).not.toHaveBeenCalled();
  });
});

describe('RTC microphone handover', () => {
  it.each([false, true])('joins with room authorization enabled: %s', async roomAuthorized => {
    const { private_map_key, ...ordinaryCredentials } = credentials;
    const supplied = roomAuthorized ? credentials : ordinaryCredentials;
    await rtc().join(supplied);
    const options = sdkInstances[0].enterRoom.mock.calls[0][0];
    expect(options).toMatchObject({
      sdkAppId: credentials.sdk_app_id, roomId: Number(credentials.room_id),
      userId: credentials.user_id, userSig: credentials.user_sig,
    });
    if (roomAuthorized) expect(options.privateMapKey).toBe(private_map_key);
    else expect(options).not.toHaveProperty('privateMapKey');
  });

  it.each(['', '   ', null, 123])('rejects a supplied invalid room authorization key: %s', async key => {
    await expect(rtc().join({ ...credentials, private_map_key: key }))
      .rejects.toMatchObject({ code: 'RTC_CREDENTIALS_INVALID' });
    expect(TRTC.create).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reuses the exact prepared track for RTC without another permission request', async () => {
    installMeter();
    const guideLevel = vi.fn(), callLevel = vi.fn();
    const microphone = lease({ onLevel: guideLevel }), stream = await microphone.prepare();
    const call = rtc({ acquireMicrophone: () => microphone.take(), onLevel: callLevel });
    const joining = call.join(credentials);
    expect(call.join(credentials)).toBe(joining);
    await joining;
    microphone.close();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(sdkInstances[0].startLocalAudio).toHaveBeenCalledExactlyOnceWith({ mute: false, option: { audioTrack: stream.getAudioTracks()[0] } });
    expect(stream.getAudioTracks()[0].readyState).toBe('live');
    expect(contexts[0].close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(80);
    expect(callLevel).toHaveBeenLastCalledWith(0.25);
    expect(guideLevel).toHaveBeenLastCalledWith(0);
    await call.mute(true);
    vi.advanceTimersByTime(80);
    expect(callLevel).toHaveBeenLastCalledWith(0);
    await call.close();
    expect(stream.getAudioTracks()[0].readyState).toBe('ended');
    expect(contexts[1].close).toHaveBeenCalledOnce();
    expect(callLevel).toHaveBeenLastCalledWith(0);
  });

  it('continues to capture normally when no prepared microphone is supplied', async () => {
    const call = rtc();
    await call.join(credentials);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(sdkInstances[0].startLocalAudio).toHaveBeenCalledOnce();
  });

  it('retains typed microphone handover failures without opening a second capture', async () => {
    const call = rtc({ acquireMicrophone: () => { throw Object.assign(new Error('麦克风已关闭'), { code: 'MIC_UNAVAILABLE' }); } });
    await expect(call.join(credentials)).rejects.toMatchObject({ code: 'MIC_UNAVAILABLE' });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sdkInstances[0].enterRoom).not.toHaveBeenCalled();
  });

  it('stops a handed-over stream that arrives after RTC was closed', async () => {
    const pending = deferred(), stream = makeStream();
    const acquire = vi.fn(() => pending.promise), call = rtc({ acquireMicrophone: acquire });
    const joining = call.join(credentials);
    const rejected = expect(joining).rejects.toMatchObject({ code: 'RTC_CLOSED' });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await call.close();
    pending.resolve(stream);
    await rejected;
    expect(stream.getAudioTracks()[0].readyState).toBe('ended');
    expect(sdkInstances[0].enterRoom).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('keeps the legacy permission preflight non-publishing and releases its probe', async () => {
    const stream = makeStream();
    getUserMedia.mockResolvedValue(stream);
    await preflightMicrophone();
    expect(stream.getAudioTracks()[0].readyState).toBe('ended');
    expect(TRTC.create).not.toHaveBeenCalled();
  });
});
