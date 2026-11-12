import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useConnectedVoice } from '../src/composables/connected-voice.js';
import * as api from '../src/lib/workflow-api.js';
import { createRtc, checkEnvironment } from '../src/lib/realtime-web-rtc.js';
import { createMicrophoneLease } from '../src/lib/microphone-lease.js';

vi.mock('../src/lib/workflow-api.js', () => ({
  prepareVoiceCall: vi.fn(), startVoiceCall: vi.fn(), getVoiceCall: vi.fn(),
  stopVoiceCall: vi.fn(), stopVoiceCallOnUnload: vi.fn(),
}));
vi.mock('../src/lib/realtime-web-rtc.js', () => ({ createRtc: vi.fn(), checkEnvironment: vi.fn() }));
vi.mock('../src/lib/microphone-lease.js', () => ({ createMicrophoneLease: vi.fn() }));
const id = 'a'.repeat(32);
const prepared = { call_id: id, session_id: '41', status: 'PREPARED', credentials: { user_id: 'rtc-user' } };
const active = { ...prepared, status: 'ACTIVE', turn_pending: false };
const stopped = { ...active, status: 'STOPPED' };
const uncertainStart = () => Object.assign(new Error('腾讯通话任务状态待查询确认'), {
  code: 'RTC_PROVIDER_UNCERTAIN', status: 502,
});
const missingStart = callId => ({ ...active, call_id: callId, status: 'FAILED',
  last_error: { code: 'RTC_START_NOT_FOUND' } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let transport, microphone, sync, onError;
function setup() { return useConnectedVoice({ onSessionChange: sync, onError }); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  sessionStorage.setItem('manji.auth_token', 'owner-a');
  transport = { join: vi.fn().mockResolvedValue(), close: vi.fn().mockResolvedValue() };
  microphone = { prepare: vi.fn().mockResolvedValue(), take: vi.fn().mockReturnValue('audio-stream'), close: vi.fn() };
  sync = vi.fn().mockResolvedValue(); onError = vi.fn();
  createRtc.mockReturnValue(transport); createMicrophoneLease.mockReturnValue(microphone);
  checkEnvironment.mockResolvedValue();
  api.prepareVoiceCall.mockResolvedValue(prepared); api.startVoiceCall.mockResolvedValue(active);
  api.getVoiceCall.mockResolvedValue(active); api.stopVoiceCall.mockResolvedValue(stopped);
});

describe('connected voice binding', () => {
  it('prepares, joins and starts in order, with the existing microphone and captions', async () => {
    const voice = setup(), join = deferred(); transport.join.mockReturnValue(join.promise);
    await voice.prepareMicrophone();
    const started = voice.start('41'); await flushPromises();
    expect(api.prepareVoiceCall).toHaveBeenCalledWith('41', expect.any(String), {});
    expect(transport.join).toHaveBeenCalledExactlyOnceWith(prepared.credentials);
    expect(api.startVoiceCall).not.toHaveBeenCalled();
    join.resolve(); expect(await started).toBe(true);
    expect(api.startVoiceCall).toHaveBeenCalledExactlyOnceWith(id);
    expect(voice.phase.value).toBe('connected');
    const callbacks = createRtc.mock.calls[0][0];
    expect(callbacks.acquireMicrophone()).toBe('audio-stream');
    callbacks.onCaption({ text: '您慢慢讲。', roundId: 'round-1', startTime: '00:00:01', endTime: '00:00:03', complete: true });
    callbacks.onAgentState({ state: 3, roundId: 'round-1' });
    expect(voice.caption.value).toBe('您慢慢讲。'); expect(voice.agentState.value).toBe(3);
    await vi.advanceTimersByTimeAsync(1500); expect(sync).toHaveBeenCalledTimes(1);
    voice.dispose();
  });

  it('stops a late preparation without joining after pause', async () => {
    const voice = setup(), prepare = deferred(); api.prepareVoiceCall.mockReturnValue(prepare.promise);
    const started = voice.start('41'); await flushPromises();
    const stopping = voice.stop();
    expect(microphone.close).toHaveBeenCalled();
    prepare.resolve(prepared);
    expect(await started).toBe(false); expect(await stopping).toBe(true);
    expect(createRtc).not.toHaveBeenCalled(); expect(api.startVoiceCall).not.toHaveBeenCalled();
    expect(api.stopVoiceCall).toHaveBeenCalledExactlyOnceWith(id);
    expect(voice.phase.value).toBe('paused'); expect(voice.settling.value).toBe(false);
    voice.dispose();
  });

  it('stops capture immediately while joining and prevents the late join from starting the bot', async () => {
    const voice = setup(), join = deferred(); transport.join.mockReturnValue(join.promise);
    const started = voice.start('41'); await flushPromises();
    const stopping = voice.stop();
    expect(transport.close).toHaveBeenCalled();
    expect(await stopping).toBe(true);
    join.resolve(); expect(await started).toBe(false);
    expect(api.startVoiceCall).not.toHaveBeenCalled(); voice.dispose();
  });

  it('keeps the final turn pending until the server has saved it', async () => {
    const voice = setup(); await voice.start('41');
    api.stopVoiceCall.mockResolvedValue({ ...stopped, status: 'STOPPING', turn_pending: true });
    api.getVoiceCall.mockResolvedValue(stopped);
    const stopping = voice.stop(); await flushPromises();
    expect(transport.close).toHaveBeenCalled(); expect(voice.settling.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await stopping).toBe(true); expect(sync).toHaveBeenCalledTimes(1);
    expect(voice.settling.value).toBe(false); voice.dispose();
  });

  it('times out a stuck join, permits retry, and ignores the old late completion', async () => {
    const voice = setup(), join = deferred(); transport.join.mockReturnValue(join.promise);
    const oldTransport = transport;
    const started = voice.start('41'); await flushPromises();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await started).toBe(false);
    expect(oldTransport.close).toHaveBeenCalled(); expect(api.stopVoiceCall).toHaveBeenCalledWith(id);
    expect(voice.phase.value).toBe('error'); expect(voice.settling.value).toBe(false);
    expect(onError.mock.calls[0][0].message).toContain('连接超时');
    expect(api.startVoiceCall).not.toHaveBeenCalled();
    const replacement = { join: vi.fn().mockResolvedValue(), close: vi.fn().mockResolvedValue() };
    createRtc.mockReturnValue(replacement);
    await voice.prepareMicrophone(); expect(await voice.start('41')).toBe(true);
    join.resolve(); await flushPromises();
    expect(api.startVoiceCall).toHaveBeenCalledTimes(1);
    expect(voice.phase.value).toBe('connected'); expect(replacement.close).not.toHaveBeenCalled();
    voice.dispose();
  });

  it('reuses the prepare request after an uncertain network result', async () => {
    const voice = setup(); api.prepareVoiceCall.mockRejectedValueOnce(new Error('网络超时'));
    expect(await voice.start('41')).toBe(false);
    expect(voice.settling.value).toBe(false);
    expect(await voice.start('41')).toBe(true);
    expect(api.prepareVoiceCall.mock.calls[0][1]).toBe(api.prepareVoiceCall.mock.calls[1][1]);
    voice.dispose();
  });

  it('confirms an uncertain start on the same call without hanging up or starting another bot', async () => {
    const voice = setup(), confirmation = deferred();
    api.startVoiceCall.mockRejectedValueOnce(uncertainStart());
    api.getVoiceCall.mockReturnValueOnce(confirmation.promise).mockResolvedValue(active);
    const started = voice.start('41'); await flushPromises();
    expect(voice.phase.value).toBe('connecting');
    expect(api.getVoiceCall).toHaveBeenCalledWith(id);
    expect(api.stopVoiceCall).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    confirmation.resolve({ ...active, status: 'STARTING' }); await flushPromises();
    expect(voice.phase.value).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await started).toBe(true);
    expect(voice.phase.value).toBe('connected');
    expect(api.getVoiceCall.mock.calls.every(([callId]) => callId === id)).toBe(true);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledExactlyOnceWith(id);
    expect(api.stopVoiceCall).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    voice.dispose();
  });

  it('redials once after the server confirms a missing start, preserving the interview and recovery request', async () => {
    const voice = setup(), nextId = 'b'.repeat(32);
    const replacement = { join: vi.fn().mockResolvedValue(), close: vi.fn().mockResolvedValue() };
    const options = { resume_kind: 'home_return', resume_request_id: 'saved-return-request' };
    createRtc.mockReturnValueOnce(transport).mockReturnValue(replacement);
    transport.close.mockImplementation(() => {
      createRtc.mock.calls[0][0].onDisconnected();
      return Promise.resolve();
    });
    api.prepareVoiceCall.mockResolvedValueOnce(prepared).mockResolvedValue({ ...prepared, call_id: nextId });
    api.startVoiceCall.mockRejectedValueOnce(uncertainStart()).mockResolvedValue({ ...active, call_id: nextId });
    api.getVoiceCall.mockResolvedValueOnce(missingStart(id));

    expect(await voice.start('41', options)).toBe(true);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(2);
    const [first, second] = api.prepareVoiceCall.mock.calls;
    expect(first).toEqual(['41', expect.any(String), options]);
    expect(second).toEqual(['41', expect.any(String), options]);
    expect(second[1]).not.toBe(first[1]);
    expect(api.startVoiceCall.mock.calls).toEqual([[id], [nextId]]);
    expect(transport.close.mock.invocationCallOrder[0]).toBeLessThan(microphone.prepare.mock.invocationCallOrder[0]);
    expect(microphone.prepare.mock.invocationCallOrder[0]).toBeLessThan(replacement.join.mock.invocationCallOrder[0]);
    expect(voice.phase.value).toBe('connected');
    expect(api.stopVoiceCall).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    voice.dispose();
  });

  it('stops automatic redial after the replacement call also has a confirmed missing start', async () => {
    const voice = setup(), nextId = 'b'.repeat(32);
    api.prepareVoiceCall.mockResolvedValueOnce(prepared).mockResolvedValue({ ...prepared, call_id: nextId });
    api.startVoiceCall.mockRejectedValue(uncertainStart());
    api.getVoiceCall.mockResolvedValueOnce(missingStart(id)).mockResolvedValue(missingStart(nextId));
    api.stopVoiceCall.mockResolvedValue({ ...stopped, call_id: nextId });

    expect(await voice.start('41')).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(2);
    expect(api.startVoiceCall.mock.calls).toEqual([[id], [nextId]]);
    expect(voice.phase.value).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(voice.settling.value).toBe(false);
    voice.dispose();
  });

  it('bounds confirmation without creating another call while the previous start remains unconfirmed', async () => {
    const voice = setup();
    api.startVoiceCall.mockRejectedValueOnce(uncertainStart());
    api.getVoiceCall
      .mockResolvedValueOnce({ ...active, status: 'PREPARED' })
      .mockResolvedValueOnce({ ...active, status: 'STOPPING' })
      .mockResolvedValueOnce({ ...active, status: 'UNKNOWN' })
      .mockResolvedValue({ ...active, status: 'STARTING' });
    const started = voice.start('41'); await flushPromises();
    await vi.advanceTimersByTimeAsync(6000);
    expect(voice.phase.value).toBe('connecting');
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(1);
    expect(api.stopVoiceCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45000);
    expect(await started).toBe(false);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledExactlyOnceWith(id);
    expect(voice.phase.value).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
    voice.dispose();
  });

  it.each(['pause', 'identity change'])('does not redial after %s while start confirmation is pending', async action => {
    const voice = setup(), confirmation = deferred();
    api.startVoiceCall.mockRejectedValueOnce(uncertainStart());
    api.getVoiceCall.mockReturnValueOnce(confirmation.promise);
    const started = voice.start('41'); await flushPromises();
    expect(api.getVoiceCall).toHaveBeenCalledWith(id);
    if (action === 'pause') expect(await voice.stop()).toBe(true);
    else sessionStorage.setItem('manji.auth_token', 'owner-b');
    confirmation.resolve(missingStart(id));
    expect(await started).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledExactlyOnceWith(id);
    expect(microphone.prepare).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    voice.dispose();
  });

  it('clears a reservation cancelled before preparation was sent', async () => {
    const voice = setup(), environment = deferred(); checkEnvironment.mockReturnValue(environment.promise);
    const started = voice.start('41'); const stopping = voice.stop();
    environment.resolve();
    expect(await started).toBe(false); expect(await stopping).toBe(true);
    expect(voice.settling.value).toBe(false); expect(api.prepareVoiceCall).not.toHaveBeenCalled();
    voice.dispose();
  });

  it('clears definitively rejected preparation instead of retrying it during pause', async () => {
    const voice = setup(); api.prepareVoiceCall.mockRejectedValueOnce(Object.assign(new Error('语音未启用'), { status: 503, code: 'RTC_UNAVAILABLE' }));
    expect(await voice.start('41')).toBe(false);
    expect(voice.settling.value).toBe(false); expect(await voice.stop()).toBe(true);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(1); voice.dispose();
  });

  it('confirms an unload stop after returning without reopening the microphone', async () => {
    const voice = setup(); await voice.start('41');
    await voice.stop({ unload: true });
    expect(api.stopVoiceCallOnUnload).toHaveBeenCalledWith(id, 'owner-a');
    expect(voice.settling.value).toBe(true);
    expect(await voice.stop()).toBe(true); expect(voice.settling.value).toBe(false);
    expect(createRtc).toHaveBeenCalledTimes(1); expect(microphone.prepare).not.toHaveBeenCalled();
    voice.dispose();
  });

  it('allows retrying the same call when stopping fails', async () => {
    const voice = setup(); await voice.start('41');
    api.stopVoiceCall.mockRejectedValueOnce(new Error('暂时无法连接'));
    expect(await voice.stop()).toBe(false);
    expect(voice.settling.value).toBe(false);
    expect(await voice.stop()).toBe(true);
    expect(api.stopVoiceCall.mock.calls.map(([callId]) => callId)).toEqual([id, id]);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(1);
    voice.dispose();
  });

  it('marks a remotely ended call paused after refreshing its saved interview', async () => {
    const voice = setup(); await voice.start('41'); api.getVoiceCall.mockResolvedValue(stopped);
    await vi.advanceTimersByTimeAsync(1500);
    expect(voice.phase.value).toBe('paused'); expect(voice.settling.value).toBe(false);
    expect(sync).toHaveBeenCalledExactlyOnceWith(); expect(transport.close).toHaveBeenCalled();
    voice.dispose();
  });

  it('releases a late cloud reservation after page disposal with the original identity', async () => {
    const voice = setup(), prepare = deferred(); api.prepareVoiceCall.mockReturnValue(prepare.promise);
    const started = voice.start('41'); await flushPromises(); voice.dispose();
    sessionStorage.setItem('manji.auth_token', 'owner-b'); prepare.resolve(prepared);
    expect(await started).toBe(false);
    expect(api.stopVoiceCallOnUnload).toHaveBeenCalledExactlyOnceWith(id, 'owner-a');
    expect(api.stopVoiceCall).not.toHaveBeenCalled(); expect(api.startVoiceCall).not.toHaveBeenCalled();
  });

  it('closes the microphone and reports a call polling failure', async () => {
    const voice = setup(); await voice.start('41');
    api.getVoiceCall.mockRejectedValueOnce(new Error('连接中断'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.close).toHaveBeenCalled(); expect(api.stopVoiceCall).toHaveBeenCalledWith(id);
    expect(voice.phase.value).toBe('error'); expect(onError.mock.calls[0][0].message).toBe('连接中断');
    await vi.advanceTimersByTimeAsync(3000); expect(api.getVoiceCall).toHaveBeenCalledTimes(1);
    voice.dispose();
  });

  it('closes the old transport before reconnecting after a completed-turn refresh failure', async () => {
    const voice = setup(); await voice.start('41');
    const previous = transport;
    sync.mockRejectedValueOnce(new Error('记录读取失败'));
    createRtc.mock.calls[0][0].onAgentState({ state: 5 });
    await flushPromises();
    expect(voice.phase.value).toBe('error');
    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(api.stopVoiceCall).toHaveBeenCalledExactlyOnceWith(id);
    expect(voice.settling.value).toBe(false);
    const replacement = { join: vi.fn().mockResolvedValue(), close: vi.fn().mockResolvedValue() };
    createRtc.mockReturnValue(replacement);
    expect(await voice.start('41')).toBe(true);
    expect(previous.close.mock.invocationCallOrder[0]).toBeLessThan(replacement.join.mock.invocationCallOrder[0]);
    expect(api.prepareVoiceCall.mock.calls[0][1]).not.toBe(api.prepareVoiceCall.mock.calls[1][1]);
    voice.dispose();
    expect(replacement.close).toHaveBeenCalled();
  });

  it('ignores a previous call refresh failure after another call has started', async () => {
    const voice = setup(); await voice.start('41');
    const reading = deferred(); sync.mockReturnValueOnce(reading.promise);
    createRtc.mock.calls[0][0].onAgentState({ state: 5 });
    expect(await voice.stop()).toBe(true);
    const replacement = { join: vi.fn().mockResolvedValue(), close: vi.fn().mockResolvedValue() };
    createRtc.mockReturnValue(replacement);
    expect(await voice.start('41')).toBe(true);
    reading.reject(new Error('上一通记录读取失败')); await flushPromises();
    expect(voice.phase.value).toBe('connected');
    expect(onError).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
    voice.dispose();
  });
});
