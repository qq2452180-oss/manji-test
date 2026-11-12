import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { useInterview } from '../src/composables/interview.js';
import * as api from '../src/lib/api.js';
import * as appState from '../src/lib/app-state.js';
import { navigate } from '../src/lib/navigation.js';
import { createRtc, checkEnvironment, preflightMicrophone } from '../src/lib/realtime-web-rtc.js';
import { completeVoiceGuide } from '../src/lib/voice-guide-state.js';

// Keep the real controller and composable together: a mocked controller cannot
// reveal failures swallowed by cleanup, duplicate creation, or resume races.
vi.mock('../src/lib/api.js', () => Object.fromEntries([
  'getAuthToken', 'getCurrentUser', 'getGuestTrial', 'getInterviewConfig', 'getRealtimeConfig',
  'bootstrapBiography', 'createInterviewSession', 'getInterviewSession',
  'uploadPhoto', 'submitInterviewInput', 'resumeInterviewSession',
  'pauseInterviewSession', 'getRealtimeCall', 'heartbeatRealtimeCall',
  'pauseInterviewSessionOnUnload', 'stopRealtimeCallOnUnload',
  'getInterviewOrganization', 'retryInterviewOrganization',
].map(name => [name, vi.fn()])));
vi.mock('../src/lib/realtime-web-rtc.js', () => ({ createRtc: vi.fn(), checkEnvironment: vi.fn(), preflightMicrophone: vi.fn() }));
vi.mock('../src/lib/microphone-lease.js', () => ({ createMicrophoneLease: vi.fn(() => ({ prepare: () => preflightMicrophone(), take: vi.fn(), close: vi.fn() })) }));
vi.mock('../src/lib/onboarding-narration.js', async importOriginal => ({ ...(await importOriginal()), createOnboardingNarration: () => ({ prepare: vi.fn(), activate: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), destroy: vi.fn() }) }));
vi.mock('../src/lib/app-state.js', () => ({ setActiveSessionId: vi.fn(), setOrganizationSessionId: vi.fn(), removeActiveSessionId: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const session = mode => ({ session_id: 'flow-session', flow_version: 'interview', mode, status: 'ACTIVE', activity_state: 'PAUSED', saving: false, active_call_id: null, turns: [], photos: [] });
let canonical, call, join, wrappers;
const Harness = defineComponent({ setup() { return useInterview(); }, render() { return h('div', this.view.connectionState); } });
async function open(query) {
  history.replaceState(null, '', '/web2/interview.html' + query);
  const wrapper = mount(Harness);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper.vm;
}
async function upload(vm) {
  await vm.controller.uploadPhotos([new File(['photo'], 'memory.jpg', { type: 'image/jpeg' })]);
}

beforeEach(() => {
  vi.resetAllMocks();
  completeVoiceGuide();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  sessionStorage.clear(); wrappers = []; canonical = session('GENERAL'); call = null;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  if (!performance.getEntriesByType) performance.getEntriesByType = () => [];
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'navigate' }]);
  api.getAuthToken.mockReturnValue('fixture-token');
  api.getCurrentUser.mockResolvedValue({ id: 'flow-owner' });
  api.getGuestTrial.mockResolvedValue({ session_id: null, activity_state: null });
  api.getInterviewConfig.mockResolvedValue({ max_images: 4 });
  api.getRealtimeConfig.mockResolvedValue({ enabled: true });
  api.bootstrapBiography.mockResolvedValue({ biography_id: 'flow-book' });
  api.createInterviewSession.mockImplementation(async mode => { canonical = session(mode); return canonical; });
  api.getInterviewSession.mockImplementation(async () => canonical);
  api.uploadPhoto.mockResolvedValue({ id: 'flow-photo' });
  api.submitInterviewInput.mockImplementation(async (id, request) => {
    const reply = { session_id: id, sequence_no: 1, turn_id: 'flow-turn', client_request_id: request.clientRequestId,
      user_text: request.text, assistant_text: '照片里是什么地方？', media_ids: request.mediaIds,
      response_id: 'flow-response', response_state: 'GENERATED' };
    canonical = { ...canonical, turns: [reply] };
    return reply;
  });
  api.resumeInterviewSession.mockImplementation(async () => {
    call = { call_id: 'flow-call-' + api.resumeInterviewSession.mock.calls.length, session_id: canonical.session_id,
      status: 'ACTIVE', saving: false, error: null, credentials: { room_id: 7 }, turns: canonical.turns };
    canonical = { ...canonical, activity_state: 'ACTIVE', active_call_id: call.call_id };
    return call;
  });
  api.pauseInterviewSession.mockImplementation(async () => {
    canonical = { ...canonical, activity_state: 'PAUSED', active_call_id: null, saving: false };
    call = { ...call, status: 'STOPPED', saving: false };
    return canonical;
  });
  api.getRealtimeCall.mockImplementation(async () => call);
  api.heartbeatRealtimeCall.mockImplementation(async () => call);
  join = vi.fn().mockResolvedValue(undefined);
  createRtc.mockImplementation(() => ({ join, close: vi.fn(), mute: vi.fn() }));
  checkEnvironment.mockResolvedValue(true);
  preflightMicrophone.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const wrapper of wrappers) wrapper.unmount();
  await flushPromises();
  vi.clearAllTimers(); vi.useRealTimers();
});

describe('saved resume openings through the real controller', () => {
  const first = { call_id: 'saved-call-1', text: '上次说到河边，后来呢？', created_at: '2026-10-19T10:00:00.000100Z' };
  const second = { call_id: 'saved-call-2', text: '接着讲讲城里的工作？', created_at: '2026-10-19T11:00:00.000100Z' };

  it('restores all saved questions after a fresh page load without relying on local history', async () => {
    canonical = { ...session('GENERAL'), resume_openings: [first, second] };
    const initial = await open('?session_id=flow-session&interaction=text');
    expect(initial.view.resumeOpenings).toEqual([first, second]);
    wrappers[0].unmount();
    sessionStorage.clear();
    const restored = await open('?session_id=flow-session&interaction=text');
    expect(restored.view.resumeOpenings).toEqual([first, second]);
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
  });

  it('merges repeated call snapshots by call ID and replaces them from a complete session snapshot', async () => {
    canonical = { ...session('GENERAL'), resume_openings: [first] };
    const vm = await open('?session_id=flow-session');
    const start = api.resumeInterviewSession.getMockImplementation();
    api.resumeInterviewSession.mockImplementation(async (...args) => {
      const started = await start(...args);
      call = { ...started, resume_openings: [first, second, second], question: '临时的当前问题' };
      return call;
    });
    await vm.continueVoice();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getRealtimeCall.mock.calls.length).toBeGreaterThan(1);
    expect(api.heartbeatRealtimeCall).toHaveBeenCalled();
    expect(vm.view.resumeOpenings).toEqual([first, second]);
    expect(vm.view.resumeOpenings.some(item => item.text === call.question)).toBe(false);
    canonical = { ...canonical, resume_openings: [second] };
    await vm.pauseVoice();
    expect(vm.view.resumeOpenings).toEqual([second]);
  });

  it('clears saved questions on account change and ignores an old call response in the next session', async () => {
    canonical = { ...session('GENERAL'), resume_openings: [first] };
    const vm = await open('?session_id=flow-session');
    await vm.continueVoice();
    const pending = deferred(), oldCall = { ...call, resume_openings: [first, second] };
    api.getRealtimeCall.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(0);
    api.getAuthToken.mockReturnValue('new-owner-token');
    vm.controller.authChanged();
    expect(vm.view.resumeOpenings).toEqual([]);
    pending.resolve(oldCall); await flushPromises();
    expect(vm.view.resumeOpenings).toEqual([]);
    wrappers[0].unmount();
    api.getCurrentUser.mockResolvedValue({ id: 'new-owner' });
    canonical = { ...session('GENERAL'), session_id: 'new-session', resume_openings: [] };
    const next = await open('?session_id=new-session&interaction=text');
    expect(next.view.sessionId).toBe('new-session');
    expect(next.view.resumeOpenings).toEqual([]);
  });
});

describe('voice entry through real interview lifecycle', () => {
  it('uses the same interview pipeline for guests and exposes a trial label', async () => {
    api.getCurrentUser.mockResolvedValue({ id: 'guest-owner', is_guest: true });
    const vm = await open('?new=1&interaction=text&trial=1');
    expect(vm.view.isGuest).toBe(true);
    expect(vm.view.account).toBe('初次体验');
    expect(createRtc).not.toHaveBeenCalled();
    await vm.controller.submit({ text: '小时候，我家门前有一棵树。' });
    expect(api.submitInterviewInput).toHaveBeenCalledTimes(1);
    expect(vm.view.turns).toHaveLength(1);
  });
  it('restores a guest trial even if a new interview URL is opened directly', async () => {
    api.getCurrentUser.mockResolvedValue({ id: 'guest-owner', is_guest: true });
    api.getGuestTrial.mockResolvedValue({ session_id: 'flow-session', activity_state: 'PAUSED' });
    const vm = await open('?new=1&interaction=text');
    expect(vm.view.sessionId).toBe('flow-session');
    expect(vm.view.restoredSession).toBe(true);
    expect(api.createInterviewSession).not.toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled();
  });
  it.each(['MATERIAL_WAITING', 'MATERIAL_CONFLICT', 'MATERIAL_DELAYED'])('automatically checks %s without offering retry or reopening the microphone', async phase => {
    canonical = { ...session('GENERAL'), activity_state: 'FINISHING' };
    api.getInterviewOrganization.mockResolvedValueOnce({ status: 'FAILED', phase, retry_allowed: true, material_revision: 1 })
      .mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'recovered-story', material_revision: 2 });
    const vm = await open('?session_id=flow-session');
    expect(vm.view.phase).toBe('finishing');
    expect(vm.view.canRetryOrganization).toBe(false);
    expect(vm.view.errorStage).toBe('');
    expect(vm.view.notice).toContain(phase === 'MATERIAL_DELAYED' ? '系统会自动继续处理' : '核对完成后会自动整理');
    await vm.controller.retryOrganization();
    expect(api.retryInterviewOrganization).not.toHaveBeenCalled();
    const delay = phase === 'MATERIAL_DELAYED' ? 30000 : 1500;
    await vi.advanceTimersByTimeAsync(delay - 1); await flushPromises();
    expect(api.getInterviewOrganization).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await flushPromises();
    expect(vm.view.phase).toBe('finished');
    expect(vm.view.organization.story_id).toBe('recovered-story');
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(preflightMicrophone).not.toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled();
  });

  it('still retries story generation failure only through an explicit action', async () => {
    canonical = { ...session('GENERAL'), activity_state: 'FINISHED' };
    api.getInterviewOrganization.mockResolvedValue({ status: 'FAILED', error_code: 'MODEL_FAILED', retry_allowed: true });
    api.retryInterviewOrganization.mockResolvedValue({ status: 'RUNNING' });
    const vm = await open('?session_id=flow-session');
    expect(vm.view.canRetryOrganization).toBe(true);
    await vi.advanceTimersByTimeAsync(30000); await flushPromises();
    expect(api.retryInterviewOrganization).not.toHaveBeenCalled();
    await vm.controller.retryOrganization();
    expect(api.retryInterviewOrganization).toHaveBeenCalledExactlyOnceWith('flow-session');
    expect(vm.view.phase).toBe('finishing');
    expect(preflightMicrophone).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 408, 429, 503])('keeps checking organization after a temporary progress failure with status %s', async status => {
    canonical = { ...session('GENERAL'), activity_state: 'FINISHING' };
    api.getInterviewOrganization.mockResolvedValueOnce({ status: 'RUNNING', phase: 'MATERIAL_DELAYED' })
      .mockRejectedValueOnce(Object.assign(new Error('服务重启中'), { status }))
      .mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'recovered-story' });
    const vm = await open('?session_id=flow-session');
    await vi.advanceTimersByTimeAsync(30000); await flushPromises();
    expect(vm.view.notice).toContain('系统会自动继续查询');
    expect(vm.view.errorStage).toBe('');
    await vi.advanceTimersByTimeAsync(29999); await flushPromises();
    expect(api.getInterviewOrganization).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await flushPromises();
    expect(vm.view.phase).toBe('finished');
    expect(vm.view.organization.story_id).toBe('recovered-story');
    expect(api.retryInterviewOrganization).not.toHaveBeenCalled();
    expect(preflightMicrophone).not.toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 422])('stops organization polling after the server rejects it with status %s', async status => {
    canonical = { ...session('GENERAL'), activity_state: 'FINISHING' };
    api.getInterviewOrganization.mockResolvedValueOnce({ status: 'RUNNING', phase: 'MATERIAL_DELAYED' })
      .mockRejectedValue(Object.assign(new Error('无法查看该记录'), { status }));
    const vm = await open('?session_id=flow-session');
    await vi.advanceTimersByTimeAsync(30000); await flushPromises();
    expect(vm.view.errorStage).toBe('organization');
    await vi.advanceTimersByTimeAsync(60000); await flushPromises();
    expect(api.getInterviewOrganization).toHaveBeenCalledTimes(2);
    expect(preflightMicrophone).not.toHaveBeenCalled();
  });

  it('starts a fresh GENERAL navigation once without submitting material', async () => {
    const vm = await open('?new=1&entry=GENERAL');
    expect(vm.view.connectionState).toBe('connected');
    expect(api.createInterviewSession).toHaveBeenCalledExactlyOnceWith('GENERAL', expect.any(String));
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
  });

  it('leaves a paused conversation and resumes the same session once from the home link', async () => {
    const vm = await open('?new=1&entry=GENERAL');
    const finish = vi.spyOn(vm.controller, 'finish');
    await vm.pauseVoice();
    expect(vm.canChatLater).toBe(true);
    await Promise.all([vm.chatLater(), vm.chatLater()]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html');
    expect(appState.setActiveSessionId).toHaveBeenLastCalledWith('flow-session');
    expect(finish).not.toHaveBeenCalled();
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();

    wrappers[0].unmount();
    const resumed = await open('?session_id=flow-session&resume=1');
    expect(location.search).toBe('?session_id=flow-session');
    expect(resumed.view).toMatchObject({ sessionId: 'flow-session', connectionState: 'connected' });
    expect(api.resumeInterviewSession).toHaveBeenCalledTimes(2);
    expect(api.resumeInterviewSession.mock.calls.every(([id]) => id === 'flow-session')).toBe(true);
    expect(api.createInterviewSession).toHaveBeenCalledOnce();
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
    expect(join).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed pause on the page until chat later can confirm a stopped call', async () => {
    const vm = await open('?new=1&entry=GENERAL');
    api.pauseInterviewSession.mockRejectedValueOnce(new Error('暂停请求暂时失败'))
      .mockRejectedValueOnce(new Error('仍未暂停成功'));
    await vm.pauseVoice();
    expect(vm.view.errorStage).toBe('pause');
    expect(vm.canChatLater).toBe(true);
    await vm.chatLater();
    expect(navigate).not.toHaveBeenCalled();
    expect(vm.localError).toContain('暂停');
    await vm.chatLater();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html');
    expect(vm.view).toMatchObject({ activityState: 'PAUSED', transportClosed: true, pending: false });
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
  });

  it('can leave after the call has stopped while final transcript material is still being saved', async () => {
    canonical = { ...session('GENERAL'), transport_closed: true, saving: true, material_state: 'WAITING_CALLBACK' };
    const vm = await open('?session_id=flow-session');
    expect(vm.canChatLater).toBe(true);
    await vm.chatLater();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html');
    expect(appState.setActiveSessionId).toHaveBeenLastCalledWith('flow-session');
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
  });

  it('ignores repeat continue clicks while the home resume is preparing its call', async () => {
    const starting = deferred(), resume = api.resumeInterviewSession.getMockImplementation();
    api.resumeInterviewSession.mockReturnValueOnce(starting.promise);
    const vm = await open('?session_id=flow-session&resume=1');
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    await Promise.all([vm.continueVoice(), vm.continueVoice()]);
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    starting.resolve(await resume()); await flushPromises();
    expect(vm.view.connectionState).toBe('connected');
    expect(join).toHaveBeenCalledOnce();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
  });

  it.each(['hide', 'owner-change'])('does not navigate home after %s during a pause retry', async interruption => {
    const vm = await open('?new=1&entry=GENERAL');
    api.pauseInterviewSession.mockRejectedValueOnce(new Error('暂停请求暂时失败'));
    await vm.pauseVoice();
    const stopping = deferred(), pause = api.pauseInterviewSession.getMockImplementation();
    api.pauseInterviewSession.mockReturnValueOnce(stopping.promise);
    const leaving = vm.chatLater();
    await flushPromises();
    if (interruption === 'hide') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    } else api.getAuthToken.mockReturnValue('different-owner-token');
    stopping.resolve(await pause()); await leaving; await flushPromises();
    expect(navigate).not.toHaveBeenCalledWith('./index.html');
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
  });

  it.each(['reload', 'back_forward'])('consumes a home resume intent without opening audio on %s', async type => {
    performance.getEntriesByType.mockReturnValue([{ type }]);
    const vm = await open('?session_id=flow-session&resume=1');
    expect(location.search).toBe('?session_id=flow-session');
    expect(vm.view.sessionId).toBe('flow-session');
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(preflightMicrophone).not.toHaveBeenCalled();
    await vm.continueVoice();
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    expect(vm.view.connectionState).toBe('connected');
  });

  it.each(['?session_id=flow-session&resume=1&interaction=text', '?resume=1'])('does not use a home resume intent to start %s', async query => {
    await open(query);
    expect(new URLSearchParams(location.search).has('resume')).toBe(false);
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
    expect(preflightMicrophone).not.toHaveBeenCalled();
  });

  it('consumes the home intent before loading and does not auto-resume after a failed restore', async () => {
    const loading = deferred();
    api.getInterviewSession.mockReturnValueOnce(loading.promise);
    const vm = await open('?session_id=flow-session&resume=1');
    expect(location.search).toBe('?session_id=flow-session');
    loading.reject(new Error('暂时无法读取上次的讲述'));
    await flushPromises();
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
    await vm.reconnect();
    expect(api.resumeInterviewSession).toHaveBeenCalledExactlyOnceWith('flow-session', expect.any(String), undefined);
    expect(vm.view.connectionState).toBe('connected');
  });

  it.each(['hide', 'unmount', 'owner-change'])('does not replay a home resume intent after %s during loading', async interruption => {
    const loading = deferred();
    api.getInterviewSession.mockReturnValueOnce(loading.promise);
    await open('?session_id=flow-session&resume=1');
    if (interruption === 'hide') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
    } else if (interruption === 'unmount') wrappers[0].unmount();
    else api.getAuthToken.mockReturnValue('different-owner-token');
    loading.resolve(canonical); await flushPromises();
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
    expect(preflightMicrophone).not.toHaveBeenCalled();
  });

  it('closes local audio immediately, then allows resume while the stopped call still waits for final text', async () => {
    const vm = await open('?new=1&entry=GENERAL');
    const oldRtc = createRtc.mock.results[0].value, oldCallbacks = createRtc.mock.calls[0][0];
    const oldPoll = deferred();
    api.getRealtimeCall.mockReturnValueOnce(oldPoll.promise);
    await vi.advanceTimersByTimeAsync(0);
    const stopping = deferred();
    api.pauseInterviewSession.mockReturnValueOnce(stopping.promise);
    const paused = vm.controller.pause();
    expect(oldRtc.close).toHaveBeenCalledOnce();
    expect(vm.view.phase).toBe('pausing');
    const stoppedCall = { ...call, status: 'STOPPED', transport_closed: true, saving: true,
      material_state: 'WAITING_CALLBACK', error: { code: 'REALTIME_SAVING', message: '最后的文字还在核对。' } };
    canonical = { ...canonical, activity_state: 'PAUSED', active_call_id: null,
      transport_closed: true, saving: true, material_state: 'WAITING_CALLBACK' };
    stopping.resolve(canonical); await paused;
    expect(vm.view).toMatchObject({ phase: 'paused', connectionState: 'paused', connectionError: null,
      transportClosed: true, saving: true, materialState: 'WAITING_CALLBACK', canStart: true, pending: false });
    expect(api.submitInterviewInput).not.toHaveBeenCalled();

    await vm.continueVoice();
    const newRtc = createRtc.mock.results[1].value;
    expect(vm.view.connectionState).toBe('connected');
    expect(api.pauseInterviewSession).toHaveBeenCalledOnce();
    expect(api.resumeInterviewSession).toHaveBeenCalledTimes(2);
    oldPoll.resolve(stoppedCall);
    oldCallbacks.onDisconnected();
    oldCallbacks.onCaption({ text: '旧通话的迟到字幕', roundId: 'old', startTime: '00:00:01', endTime: '00:00:02', complete: true });
    await flushPromises();
    expect(vm.view.connectionState).toBe('connected');
    expect(vm.view.caption).not.toContain('旧通话');
    expect(newRtc.close).not.toHaveBeenCalled();
  });

  it('restores a paused session with pending material and accepts photos and explicit text without waiting', async () => {
    canonical = { ...session('GENERAL'), transport_closed: true, saving: true, material_state: 'WAITING_CALLBACK' };
    const vm = await open('?session_id=flow-session&interaction=text');
    expect(vm.view).toMatchObject({ phase: 'paused', canStart: true, canSubmit: true, pending: false, saving: true });
    expect(api.pauseInterviewSession).not.toHaveBeenCalled();
    await upload(vm);
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    await vm.controller.submit({ text: '这是刚才那段讲述的补充。', autoResume: false });
    expect(api.submitInterviewInput).toHaveBeenCalledExactlyOnceWith('flow-session', expect.objectContaining({
      text: '这是刚才那段讲述的补充。', mediaIds: ['flow-photo'],
    }));
    expect(vm.view.pendingInput).toBeNull();
    expect(api.pauseInterviewSession).not.toHaveBeenCalled();
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled();
  });

  it('settles a stopped call reported by polling without treating material checking as a connection error', async () => {
    const vm = await open('?new=1&entry=GENERAL');
    call = { ...call, status: 'STOPPED', transport_closed: true, saving: true,
      material_state: 'WAITING_CALLBACK', error: { code: 'REALTIME_SAVING', message: '最后的文字还在核对。' } };
    await vi.advanceTimersByTimeAsync(0); await flushPromises();
    expect(vm.view).toMatchObject({ phase: 'paused', connectionState: 'paused', connectionError: null,
      canStart: true, saving: true, transportClosed: true, pending: false });
    expect(api.pauseInterviewSession).not.toHaveBeenCalled();
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
  });

  it('keeps join failure visible after cleanup, and reconnects once with one click', async () => {
    join.mockRejectedValueOnce(Object.assign(new Error('入房连接失败'), { code: 'RTC_JOIN_FAILED' }));
    const vm = await open('?new=1&entry=GENERAL');
    expect(api.pauseInterviewSession).toHaveBeenCalledOnce();
    expect(vm.view.connectionState).toBe('failed');
    expect(vm.view.connectionError.message).toContain('入房连接失败');
    await Promise.all([vm.reconnect(), vm.reconnect()]);
    expect(vm.view.connectionState).toBe('connected');
    expect(vm.view.connectionError).toBeNull();
    expect(api.createInterviewSession).toHaveBeenCalledOnce();
    expect(api.resumeInterviewSession).toHaveBeenCalledTimes(2);
  });

  it('keeps a resume preparation failure retryable without unknown-call recovery', async () => {
    canonical.turns = [{ sequence_no: 1, user_text: '小时候住在河边。', assistant_text: '河边有什么？', response_state: 'GENERATED' }];
    api.resumeInterviewSession.mockRejectedValueOnce(Object.assign(new Error('暂时没能接上刚才的讲述，请重新连接。'),
      { status: 503, code: 'RESUME_OPENING_FAILED' }));
    const vm = await open('?session_id=flow-session');
    await vm.continueVoice();
    expect(vm.view).toMatchObject({ phase: 'paused', connectionState: 'failed', pending: false,
      canRetryCall: true, notice: '暂时没能接上刚才的讲述，请重新连接。' });
    expect(createRtc).not.toHaveBeenCalled();
    expect(api.pauseInterviewSession).not.toHaveBeenCalled();
    await Promise.all([vm.reconnect(), vm.reconnect()]);
    expect(vm.view.connectionState).toBe('connected');
    expect(api.resumeInterviewSession).toHaveBeenCalledTimes(2);
    expect(join).toHaveBeenCalledOnce();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
  });

  it('retries initialization and starts ordinary voice in the same action', async () => {
    api.getInterviewConfig.mockRejectedValueOnce(new Error('配置暂时未响应'));
    const vm = await open('?new=1&entry=GENERAL');
    expect(preflightMicrophone).not.toHaveBeenCalled();
    await vm.reconnect();
    expect(vm.view.connectionState).toBe('connected');
    expect(api.getInterviewConfig).toHaveBeenCalledTimes(2);
    expect(api.createInterviewSession).toHaveBeenCalledOnce();
  });

  it('retains a created PHOTO session when a later initialization request fails', async () => {
    api.getInterviewSession.mockRejectedValueOnce(new Error('读取刚创建的访谈失败'));
    const vm = await open('?new=1&entry=PHOTO');
    expect(vm.view.sessionId).toBe('flow-session');
    await vm.reconnect();
    expect(api.createInterviewSession).toHaveBeenCalledOnce();
    expect(preflightMicrophone).not.toHaveBeenCalled();
    await upload(vm);
    expect(api.submitInterviewInput).not.toHaveBeenCalled();
    await vm.submitPhotos();
    expect(vm.view.connectionState).toBe('connected');
    expect(api.createInterviewSession).toHaveBeenCalledOnce();
    expect(api.resumeInterviewSession).toHaveBeenCalledWith('flow-session', expect.any(String), 'flow-response');
  });

  it('retries the same first PHOTO input and connects after its confirmed reply', async () => {
    api.submitInterviewInput.mockRejectedValueOnce(new Error('首条照片回复超时'));
    const vm = await open('?new=1&entry=PHOTO');
    await upload(vm); await vm.submitPhotos();
    expect(vm.view.pendingInput).toBeTruthy();
    expect(preflightMicrophone).not.toHaveBeenCalled();
    const first = api.submitInterviewInput.mock.calls[0][1];
    await vm.submitPhotos();
    expect(api.submitInterviewInput.mock.calls[1][1]).toEqual(first);
    expect(api.createInterviewSession).toHaveBeenCalledOnce();
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    expect(vm.view.connectionState).toBe('connected');
  });

  it('reconnects PHOTO audio with its confirmed opening instead of regenerating it', async () => {
    join.mockRejectedValueOnce(new Error('照片回复已完成，但语音连接失败'));
    const vm = await open('?new=1&entry=PHOTO');
    await upload(vm); await vm.submitPhotos();
    expect(vm.view.connectionState).toBe('failed');
    expect(vm.view.pendingInput).toBeNull();
    await vm.reconnect();
    expect(vm.view.connectionState).toBe('connected');
    expect(api.submitInterviewInput).toHaveBeenCalledOnce();
    expect(api.resumeInterviewSession.mock.calls.map(args => args[2])).toEqual(['flow-response', 'flow-response']);
  });

  it('does not auto-start after hiding and returning while initialization was pending', async () => {
    const config = deferred(); api.getInterviewConfig.mockReturnValueOnce(config.promise);
    const vm = await open('?new=1&entry=GENERAL');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    config.resolve({ max_images: 4 }); await flushPromises();
    expect(preflightMicrophone).not.toHaveBeenCalled();
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    await vm.continueVoice();
    expect(vm.view.connectionState).toBe('connected');
  });
});
