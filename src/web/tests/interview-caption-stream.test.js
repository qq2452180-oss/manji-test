import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { TextDecoder, TextEncoder } from 'node:util';
import InterviewPage from '../src/pages/InterviewPage.vue';
import * as api from '../src/lib/api.js';

// Exercise the real Vue page, composable, controller and RTC message parser.
// Only the business API and browser/SDK media boundary are synthetic; no
// microphone is opened and no provider or backend request can be made.
vi.mock('../src/lib/api.js', () => Object.fromEntries([
  'getAuthToken', 'getCurrentUser', 'getInterviewConfig', 'getRealtimeConfig',
  'bootstrapBiography', 'createInterviewSession', 'getInterviewSession',
  'uploadPhoto', 'getPhotoBlob', 'submitInterviewInput', 'resumeInterviewSession',
  'pauseInterviewSession', 'getRealtimeCall', 'heartbeatRealtimeCall',
  'pauseInterviewSessionOnUnload', 'stopRealtimeCallOnUnload',
  'completeInterviewSession', 'getInterviewOrganization', 'retryInterviewOrganization',
].map(name => [name, vi.fn()])));

const credentials = {
  room_id: '12345678', sdk_app_id: 1400000001,
  user_id: 'caption-listener', bot_user_id: 'caption-bot',
  user_sig: 'synthetic-user-ticket', private_map_key: 'synthetic-room-ticket',
};
const longText = '小时候的院子里，有一棵高高的大树。夏天我们坐在树荫下面，一边乘凉一边听大人讲故事。那时候邻居之间经常互相照应，谁家做了好吃的也会分给大家。您最怀念那时候的哪个小细节，愿意再和我讲讲吗？';
const visibleText = wrapper => wrapper.findAll('.voice-caption > p').map(node => node.text()).join('');
const button = (wrapper, text) => wrapper.findAll('button').find(node => node.text() === text);
const nextFrame = async () => { await flushPromises(); await nextTick(); };
let wrappers, sdkSessions, canonical, call;

function createSdkSession() {
  const events = new Map();
  let audioTrack;
  const sdk = {
    on: vi.fn((name, handler) => events.set(name, handler)),
    off: vi.fn((name, handler) => { if (events.get(name) === handler) events.delete(name); }),
    enterRoom: vi.fn().mockResolvedValue(undefined),
    startLocalAudio: vi.fn(async options => { audioTrack = options.option.audioTrack; }),
    getAudioTrack: () => audioTrack,
    updateLocalAudio: vi.fn().mockResolvedValue(undefined),
    setRemoteAudioVolume: vi.fn(), stopLocalAudio: vi.fn().mockResolvedValue(undefined),
    muteRemoteAudio: vi.fn().mockResolvedValue(undefined), exitRoom: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
  const session = { events, sdk, sequence: 0 };
  sdkSessions.push(session);
  return sdk;
}

function packet(message, connection = sdkSessions.at(-1)) {
  return { userId: credentials.bot_user_id, cmdId: 1, seq: ++connection.sequence,
    data: new TextEncoder().encode(JSON.stringify(message)).buffer };
}
function sendCaption(text, { roundId = 'round-a', startTime = '00:00:01', endTime = '00:00:09', complete = true } = {}) {
  const connection = sdkSessions.at(-1);
  connection.events.get('CUSTOM_MESSAGE')(packet({ type: 10000, sender: credentials.bot_user_id,
    payload: { roundid: roundId, text, start_time: startTime, end_time: endTime, end: complete } }, connection));
}
function sendState(state, { roundId = 'round-a', timestamp = 100 } = {}) {
  const connection = sdkSessions.at(-1);
  connection.events.get('CUSTOM_MESSAGE')(packet({ type: 10001, sender: credentials.bot_user_id,
    payload: { roundid: roundId, state, timestamp } }, connection));
}
async function openConnectedPage() {
  history.replaceState(null, '', '/web2/interview.html?session_id=caption-session');
  const wrapper = mount(InterviewPage, { attachTo: document.body });
  wrappers.push(wrapper);
  await nextFrame();
  await button(wrapper, '继续聊').trigger('click');
  await nextFrame();
  expect(wrapper.find('[aria-label="暂停访谈"]').exists()).toBe(true);
  expect(sdkSessions).toHaveLength(1);
  return wrapper;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
  wrappers = []; sdkSessions = []; call = null;
  canonical = { session_id: 'caption-session', flow_version: 'interview', mode: 'GENERAL',
    status: 'ACTIVE', activity_state: 'PAUSED', saving: false, active_call_id: null,
    turns: [], photos: [] };
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('RTCPeerConnection', function () {});
  vi.stubGlobal('TextDecoder', TextDecoder);
  vi.stubGlobal('TextEncoder', TextEncoder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => {
    const track = { kind: 'audio', enabled: true, readyState: 'live', stop: vi.fn(function () { this.readyState = 'ended'; }) };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }) } });
  const eventNames = ['CUSTOM_MESSAGE', 'TRACK', 'ERROR', 'KICKED_OUT', 'CONNECTION_STATE_CHANGED', 'AUTOPLAY_FAILED'];
  vi.stubGlobal('TRTC', { create: vi.fn(createSdkSession), isSupported: vi.fn().mockResolvedValue({ result: true }),
    setLogLevel: vi.fn(), EVENT: Object.fromEntries(eventNames.map(name => [name, name])) });
  api.getAuthToken.mockReturnValue('synthetic-auth-token');
  api.getCurrentUser.mockResolvedValue({ id: 'caption-owner' });
  api.getInterviewConfig.mockResolvedValue({ max_images: 4 });
  api.getRealtimeConfig.mockResolvedValue({ enabled: true });
  api.bootstrapBiography.mockResolvedValue({ biography_id: 'caption-book' });
  api.getInterviewSession.mockImplementation(async () => canonical);
  api.resumeInterviewSession.mockImplementation(async () => {
    call = { call_id: `caption-call-${api.resumeInterviewSession.mock.calls.length}`,
      session_id: canonical.session_id, status: 'ACTIVE', saving: false, error: null, credentials, turns: canonical.turns };
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
});

afterEach(async () => {
  for (const wrapper of wrappers) wrapper.unmount();
  await flushPromises();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('long provider captions through the actual voice UI', () => {
  it.each(['GENERAL', 'PHOTO'])('reveals one long packet over time and retains it in %s voice interviews', async mode => {
    // Resume an existing session, including an already prepared PHOTO session;
    // this checks the shared voice path without simulating photo submission.
    canonical = { ...canonical, mode, turns: mode === 'PHOTO' ? [{
      session_id: canonical.session_id, sequence_no: 1, turn_id: 'saved-photo-turn',
      user_text: '', assistant_text: '照片中的小院，还记得住着谁吗？',
      media_ids: ['synthetic-photo'], response_id: 'saved-photo-response', response_state: 'GENERATED',
    }] : [] };
    const wrapper = await openConnectedPage();
    sendState(3); sendCaption(longText); await nextFrame();
    const first = visibleText(wrapper);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(longText.length);
    expect(longText.startsWith(first)).toBe(true);
    expect(wrapper.findAll('.voice-caption > p')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); await nextFrame();
    const middle = visibleText(wrapper);
    expect(middle.length).toBeGreaterThan(first.length);
    expect(middle.length).toBeLessThan(longText.length);
    expect(longText.startsWith(middle)).toBe(true);
    await vi.advanceTimersByTimeAsync(28000); await nextFrame();
    expect(visibleText(wrapper)).toBe(longText);
    sendState(5, { timestamp: 101 });
    await vi.advanceTimersByTimeAsync(2500); await nextFrame();
    expect(visibleText(wrapper)).toBe(longText);
    expect(sdkSessions[0].sdk.destroy).not.toHaveBeenCalled();
    expect(api.pauseInterviewSession).not.toHaveBeenCalled();
  });

  it('does not reveal a burst of complete packets in the same Vue frame', async () => {
    const wrapper = await openConnectedPage();
    const first = '第一段，我们从院子里那棵树聊起。';
    const second = '第二段，您还记得那时和谁一起玩耍吗？';
    sendState(3);
    sendCaption(first, { endTime: '00:00:05' });
    sendCaption(second, { startTime: '00:00:05', endTime: '00:00:10' });
    await nextFrame();
    const initial = visibleText(wrapper);
    expect(initial.length).toBeGreaterThan(0);
    expect(initial.length).toBeLessThan(first.length + second.length);
    expect((first + second).startsWith(initial)).toBe(true);
    expect(initial).not.toContain('您还记得');
    await vi.advanceTimersByTimeAsync(30000); await nextFrame();
    expect(visibleText(wrapper)).toBe(first + second);
  });

  it('finishes displaying an accepted packet after the adapter closes its tail window', async () => {
    const wrapper = await openConnectedPage();
    sendState(3); sendCaption(longText); sendState(5, { timestamp: 101 });
    await nextFrame();
    expect(visibleText(wrapper).length).toBeLessThan(longText.length);
    await vi.advanceTimersByTimeAsync(2500); await nextFrame();
    sendCaption('过期字幕不能插进已接收的展示队列。', { startTime: '00:00:10', endTime: '00:00:12' });
    await vi.advanceTimersByTimeAsync(27500); await nextFrame();
    expect(visibleText(wrapper)).toBe(longText);
    expect(wrapper.text()).not.toContain('过期字幕');
  });

  it('cancels queued text on pause and ignores old transport callbacks after reconnecting', async () => {
    const wrapper = await openConnectedPage();
    sendState(3); sendCaption(longText); await nextFrame();
    expect(visibleText(wrapper).length).toBeLessThan(longText.length);
    const oldConnection = sdkSessions[0], lateMessage = oldConnection.events.get('CUSTOM_MESSAGE');
    await wrapper.get('[aria-label="暂停访谈"]').trigger('click'); await nextFrame();
    await vi.advanceTimersByTimeAsync(30000); await nextFrame();
    expect(visibleText(wrapper)).toBe('已暂停，可以继续聊或补充照片。');
    expect(wrapper.text()).not.toContain('院子');
    expect(oldConnection.sdk.destroy).toHaveBeenCalledOnce();
    await button(wrapper, '继续聊').trigger('click'); await nextFrame();
    expect(sdkSessions).toHaveLength(2);
    sendState(3, { roundId: 'round-new' });
    sendCaption('新通话里的一句话。', { roundId: 'round-new', endTime: '00:00:02' });
    lateMessage(packet({ type: 10000, sender: credentials.bot_user_id,
      payload: { roundid: 'round-a', text: longText, start_time: '00:00:10', end_time: '00:00:20', end: true } }, oldConnection));
    await vi.advanceTimersByTimeAsync(30000); await nextFrame();
    expect(visibleText(wrapper)).toBe('新通话里的一句话。');
  });

  it('replaces retained text only at the next round first visible phrase and never resumes its old queue', async () => {
    const wrapper = await openConnectedPage();
    sendState(3); sendCaption(longText); await nextFrame();
    const previous = visibleText(wrapper);
    sendState(2, { roundId: 'round-b', timestamp: 200 }); await nextFrame();
    expect(visibleText(wrapper)).toBe(previous);
    const next = '这一次，我们先说说照片中的那个地方。您还记得当时发生了什么事吗？';
    sendCaption(next, { roundId: 'round-b' }); await nextFrame();
    const first = visibleText(wrapper);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(next.length);
    expect(next.startsWith(first)).toBe(true);
    expect(wrapper.text()).not.toContain(previous);
    sendCaption(longText, { startTime: '00:00:10', endTime: '00:00:20' });
    await vi.advanceTimersByTimeAsync(30000); await nextFrame();
    expect(visibleText(wrapper)).toBe(next);
  });
});
