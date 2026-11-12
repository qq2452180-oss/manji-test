import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import InterviewPage from '../src/pages/InterviewPage.vue';
import * as api from '../src/lib/api.js';
import { createRtc, checkEnvironment, stopMicrophoneStream } from '../src/lib/realtime-web-rtc.js';
import { createOnboardingNarration } from '../src/lib/onboarding-narration.js';
import { completeVoiceGuide, hasCompletedVoiceGuide } from '../src/lib/voice-guide-state.js';
import { useInterview } from '../src/composables/interview.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/api.js', () => Object.fromEntries([
  'getAuthToken', 'getCurrentUser', 'getGuestTrial', 'getInterviewConfig', 'getRealtimeConfig',
  'bootstrapBiography', 'createInterviewSession', 'getInterviewSession', 'getPhotoBlob',
  'submitInterviewInput', 'resumeInterviewSession', 'pauseInterviewSession',
  'getRealtimeCall', 'heartbeatRealtimeCall', 'pauseInterviewSessionOnUnload', 'stopRealtimeCallOnUnload',
].map(name => [name, vi.fn()])));
vi.mock('../src/lib/realtime-web-rtc.js', async original => ({ ...(await original()), createRtc: vi.fn(), checkEnvironment: vi.fn() }));
vi.mock('../src/lib/onboarding-narration.js', async original => ({ ...(await original()), createOnboardingNarration: vi.fn() }));
vi.mock('../src/lib/app-state.js', () => ({ setActiveSessionId: vi.fn(), setOrganizationSessionId: vi.fn(), removeActiveSessionId: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = (wrapper, label) => wrapper.findAll('button').find(node => node.text() === label);
function audioStream() {
  const track = { kind: 'audio', readyState: 'live', enabled: true, stop: vi.fn(() => { track.readyState = 'ended'; }) };
  return { getAudioTracks: () => [track], getTracks: () => [track], track };
}
let microphone, streams, speaker, narrationEvents, joined, canonical, call, wrappers;
async function open(query = '?new=1&interaction=voice&trial=1') {
  history.replaceState(null, '', '/web2/interview.html' + query);
  const wrapper = mount(InterviewPage); wrappers.push(wrapper); await flushPromises(); return wrapper;
}
async function authorize(wrapper) {
  await button(wrapper, '开启麦克风').trigger('click'); await flushPromises();
}
async function visibility(hidden) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
}

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  wrappers = []; streams = []; joined = []; call = null;
  canonical = { session_id: 'guide-session', flow_version: 'interview', mode: 'GENERAL', status: 'ACTIVE', activity_state: 'PAUSED', saving: false, active_call_id: null, turns: [], photos: [] };
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  if (!performance.getEntriesByType) performance.getEntriesByType = () => [];
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'navigate' }]);
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('RTCPeerConnection', function () {});
  microphone = vi.fn(async () => { const stream = audioStream(); streams.push(stream); return stream; });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
  api.getAuthToken.mockReturnValue('guide-token');
  api.getCurrentUser.mockResolvedValue({ id: 'guide-owner', is_guest: true });
  api.getGuestTrial.mockResolvedValue({ session_id: null, activity_state: null });
  api.getInterviewConfig.mockResolvedValue({ max_images: 4 });
  api.getRealtimeConfig.mockResolvedValue({ enabled: true });
  api.bootstrapBiography.mockResolvedValue({ biography_id: 'guide-book' });
  api.createInterviewSession.mockImplementation(async () => canonical);
  api.getInterviewSession.mockImplementation(async () => canonical);
  api.resumeInterviewSession.mockImplementation(async () => {
    call = { call_id: 'guide-call', session_id: canonical.session_id, status: 'ACTIVE', saving: false, credentials: { room_id: 7 }, turns: [] };
    canonical = { ...canonical, activity_state: 'ACTIVE', active_call_id: call.call_id }; return call;
  });
  api.pauseInterviewSession.mockImplementation(async () => {
    canonical = { ...canonical, activity_state: 'PAUSED', active_call_id: null }; call = { ...call, status: 'STOPPED', saving: false }; return canonical;
  });
  api.getRealtimeCall.mockImplementation(async () => call);
  api.heartbeatRealtimeCall.mockImplementation(async () => call);
  checkEnvironment.mockResolvedValue(true);
  createRtc.mockImplementation(options => {
    let stream;
    return { join: vi.fn(async () => { stream = await options.acquireMicrophone(); joined.push(stream); }),
      close: vi.fn(() => stopMicrophoneStream(stream)), mute: vi.fn() };
  });
  createOnboardingNarration.mockImplementation(({ onChange }) => {
    narrationEvents = onChange;
    speaker = { prepare: vi.fn(), activate: vi.fn(), pause: vi.fn(), play: vi.fn(kind => { onChange({ kind, text: kind === 'guide' ? '麦克风已经打开了。' : '您说话，我来听。', playing: true }); return Promise.resolve(); }),
      stop: vi.fn(() => onChange({ playing: false })), destroy: vi.fn() };
    return speaker;
  });
});
afterEach(async () => {
  wrappers.forEach(wrapper => wrapper.unmount()); await flushPromises();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('first voice permission and tutorial with the real controller and microphone lease', () => {
  it('waits for permission, then tutorial, and hands the same microphone to exactly one call', async () => {
    const wrapper = await open();
    expect(wrapper.get('h1').text()).toBe('让小暖听见您');
    expect(speaker.prepare).toHaveBeenCalledWith('guide');
    expect(speaker.play).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled(); expect(api.createInterviewSession).not.toHaveBeenCalled();
    await authorize(wrapper);
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    expect(microphone).toHaveBeenCalledOnce(); expect(speaker.play).toHaveBeenLastCalledWith('guide');
    expect(api.createInterviewSession).not.toHaveBeenCalled(); expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    expect(hasCompletedVoiceGuide()).toBe(false);
    const start = button(wrapper, '准备好了，咱们开始吧');
    start.element.click(); start.element.click(); await flushPromises();
    expect(api.createInterviewSession).toHaveBeenCalledOnce(); expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    expect(microphone).toHaveBeenCalledOnce(); expect(joined).toEqual([streams[0]]);
    expect(streams[0].track.stop).not.toHaveBeenCalled(); expect(hasCompletedVoiceGuide()).toBe(true);
    await wrapper.get('[aria-label="暂停访谈"]').trigger('click');
    expect(streams[0].track.stop).toHaveBeenCalled();
    expect(wrapper.text()).toContain('结束并整理');
  });

  it('preloads while awaiting permission and starts narration as soon as permission resolves', async () => {
    const pending = deferred(), stream = audioStream(); microphone.mockReturnValueOnce(pending.promise);
    const wrapper = await open();
    expect(speaker.prepare).toHaveBeenCalledWith('guide');
    const stops = speaker.stop.mock.calls.length;
    await authorize(wrapper);
    expect(speaker.stop).toHaveBeenCalledTimes(stops);
    expect(speaker.activate).toHaveBeenCalledExactlyOnceWith('guide');
    expect(speaker.activate.mock.invocationCallOrder[0]).toBeLessThan(microphone.mock.invocationCallOrder[0]);
    expect(speaker.play).not.toHaveBeenCalled();
    pending.resolve(stream); await flushPromises();
    expect(speaker.play).toHaveBeenCalledExactlyOnceWith('guide');
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    expect(api.createInterviewSession).not.toHaveBeenCalled();
  });

  it('offers browser settings and retry after denial without creating any interview or call', async () => {
    microphone.mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotAllowedError' }));
    const wrapper = await open(); await authorize(wrapper);
    expect(wrapper.text()).toContain('麦克风没有打开'); expect(wrapper.text()).toContain('已开启，重试');
    expect(wrapper.get('summary').text()).toBe('如何开启麦克风');
    expect(button(wrapper, '先打字聊')).toBeUndefined();
    expect(button(wrapper, '返回聊天方式选择')).toBeUndefined();
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(api.createInterviewSession).not.toHaveBeenCalled(); expect(api.submitInterviewInput).not.toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled(); expect(hasCompletedVoiceGuide()).toBe(false);
  });

  it('closes a late permission result after unmounting and never starts the tutorial', async () => {
    const pending = deferred(), stream = audioStream(); microphone.mockReturnValueOnce(pending.promise);
    const wrapper = await open(); await authorize(wrapper);
    expect(wrapper.text()).toContain('正在等待允许');
    wrapper.unmount(); wrappers = wrappers.filter(item => item !== wrapper);
    pending.resolve(stream); await flushPromises();
    expect(stream.track.stop).toHaveBeenCalled(); expect(speaker.destroy).toHaveBeenCalledOnce();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled(); expect(speaker.play).not.toHaveBeenCalledWith('guide');
  });

  it('keeps the original permission page after returning from the background', async () => {
    const wrapper = await open();
    await visibility(true); await visibility(false);
    expect(wrapper.get('h1').text()).toBe('让小暖听见您');
    expect(button(wrapper, '开启麦克风').attributes('disabled')).toBeUndefined();
    expect(microphone).not.toHaveBeenCalled(); expect(speaker.play).not.toHaveBeenCalled();
    await authorize(wrapper);
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    expect(microphone).toHaveBeenCalledOnce();
  });

  it('keeps the tutorial on return and reacquires the microphone through the existing Start button', async () => {
    const wrapper = await open(); await authorize(wrapper); const plays = speaker.play.mock.calls.length;
    await visibility(true); expect(streams[0].track.stop).toHaveBeenCalled();
    await visibility(false);
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    expect(wrapper.text()).not.toContain('准备好后，再继续');
    expect(microphone).toHaveBeenCalledOnce(); expect(speaker.play).toHaveBeenCalledTimes(plays);
    expect(api.resumeInterviewSession).not.toHaveBeenCalled();
    const start = button(wrapper, '准备好了，咱们开始吧');
    start.element.click(); start.element.click(); await flushPromises();
    expect(microphone).toHaveBeenCalledTimes(2);
    expect(api.createInterviewSession).toHaveBeenCalledOnce(); expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
    expect(joined).toEqual([streams[1]]); expect(streams[1].track.stop).not.toHaveBeenCalled();
  });

  it('returns an interrupted permission request to the original button and ignores its late result', async () => {
    const pending = deferred(), oldStream = audioStream(); microphone.mockReturnValueOnce(pending.promise);
    const wrapper = await open(); await authorize(wrapper);
    await visibility(true); await visibility(false);
    expect(wrapper.get('h1').text()).toBe('让小暖听见您');
    expect(button(wrapper, '开启麦克风').attributes('disabled')).toBeUndefined();
    await authorize(wrapper);
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    pending.resolve(oldStream); await flushPromises();
    expect(oldStream.track.stop).toHaveBeenCalled();
    expect(streams[0].track.stop).not.toHaveBeenCalled();
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    expect(microphone).toHaveBeenCalledTimes(2); expect(api.createInterviewSession).not.toHaveBeenCalled();
  });

  it('keeps permission-denial help when returning from browser settings', async () => {
    microphone.mockRejectedValueOnce(Object.assign(new Error(), { name: 'NotAllowedError' }));
    const wrapper = await open(); await authorize(wrapper);
    await visibility(true); await visibility(false);
    expect(wrapper.text()).toContain('麦克风没有打开');
    expect(wrapper.get('summary').text()).toBe('如何开启麦克风');
    expect(microphone).toHaveBeenCalledOnce();
    await button(wrapper, '已开启，重试').trigger('click'); await flushPromises();
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
  });

  it('stops narration and pending capture immediately when the account changes', async () => {
    const pending = deferred(), stream = audioStream(); microphone.mockReturnValueOnce(pending.promise);
    const wrapper = await open(); await authorize(wrapper);
    api.getAuthToken.mockReturnValue('other-account'); window.dispatchEvent(new Event('manji:auth-changed'));
    pending.resolve(stream); await flushPromises();
    expect(stream.track.stop).toHaveBeenCalled(); expect(navigate).toHaveBeenCalled();
    expect(api.createInterviewSession).not.toHaveBeenCalled(); expect(api.resumeInterviewSession).not.toHaveBeenCalled();
  });

  it('shows readable tutorial and allows starting when narration is blocked', async () => {
    const wrapper = await open(); await authorize(wrapper);
    narrationEvents({ kind: 'guide', text: '麦克风已经打开了。', playing: false, blocked: true }); await nextTick();
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.get('.onboarding-caption').text()).toContain('麦克风已经打开了');
    expect(wrapper.get('.onboarding-caption').text()).not.toContain('讲完后，点结束并整理');
    expect(wrapper.text()).not.toContain('播放讲解');
    expect(wrapper.text()).not.toContain('声音暂时没有播放');
    await button(wrapper, '准备好了，咱们开始吧').trigger('click'); await flushPromises();
    expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
  });

  it.each(['reload', 'back_forward'])('refresh/history returns to permission without automatic sound or mic (%s)', async navigationType => {
    performance.getEntriesByType.mockReturnValue([{ type: navigationType }]);
    const wrapper = await open();
    expect(wrapper.get('h1').text()).toBe('让小暖听见您');
    expect(microphone).not.toHaveBeenCalled(); expect(speaker.play).not.toHaveBeenCalled(); expect(api.resumeInterviewSession).not.toHaveBeenCalled();
  });

  it('discards a late permission result after the browser leaves the page without creating a session', async () => {
    const pending = deferred(), stream = audioStream(); microphone.mockReturnValueOnce(pending.promise);
    const wrapper = await open(); await authorize(wrapper);
    window.dispatchEvent(new Event('pagehide')); pending.resolve(stream); await flushPromises();
    expect(stream.track.stop).toHaveBeenCalled(); expect(speaker.destroy).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled(); expect(speaker.play).not.toHaveBeenCalled();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
  });

  it('keeps network failure as retryable and releases the granted microphone', async () => {
    const wrapper = await open(); await authorize(wrapper);
    api.getRealtimeConfig.mockRejectedValueOnce(Object.assign(new Error('暂时连接不上'), { code: 'NETWORK_ERROR' }));
    await button(wrapper, '准备好了，咱们开始吧').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('暂时连接不上'); expect(wrapper.text()).toContain('重新连接');
    expect(streams[0].track.stop).toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(api.createInterviewSession).not.toHaveBeenCalled();
  });

  it('does not let a duplicate Continue action close the first action\'s pending microphone', async () => {
    completeVoiceGuide(); performance.getEntriesByType.mockReturnValue([{ type: 'reload' }]);
    const pending = deferred(), stream = audioStream(); microphone.mockReturnValueOnce(pending.promise);
    history.replaceState(null, '', '/web2/interview.html?new=1');
    const wrapper = mount(defineComponent({ setup: useInterview, render() { return h('div'); } })); wrappers.push(wrapper);
    await flushPromises();
    const first = wrapper.vm.continueVoice(); await flushPromises();
    await wrapper.vm.continueVoice();
    pending.resolve(stream); await first; await flushPromises();
    expect(microphone).toHaveBeenCalledOnce(); expect(joined).toEqual([stream]);
    expect(stream.track.stop).not.toHaveBeenCalled(); expect(api.resumeInterviewSession).toHaveBeenCalledOnce();
  });

  it('releases the microphone if resuming an existing photo interview fails before RTC handoff', async () => {
    canonical = { ...canonical, mode: 'PHOTO', turns: [{ sequence_no: 1, user_text: '', assistant_text: '这是在哪拍的照片？', media_ids: ['photo'], response_state: 'GENERATED' }] };
    api.getCurrentUser.mockResolvedValue({ id: 'member', is_guest: false });
    api.resumeInterviewSession.mockRejectedValueOnce(Object.assign(new Error('这次连接暂时不可用'), { status: 403 }));
    const wrapper = await open('?session_id=guide-session&entry=PHOTO');
    await button(wrapper, '继续聊').trigger('click'); await flushPromises();
    expect(microphone).toHaveBeenCalledOnce(); expect(streams[0].track.stop).toHaveBeenCalled();
    expect(createRtc).not.toHaveBeenCalled(); expect(wrapper.text()).toContain('这次连接暂时不可用');
  });
});
