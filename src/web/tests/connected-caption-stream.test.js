import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { TextDecoder, TextEncoder } from 'node:util';
import ConnectedInterviewPage from '../src/pages/ConnectedInterviewPage.vue';
import * as api from '../src/lib/workflow-api.js';

// Keep the formal page, voice composable, microphone lease and RTC parser real.
// Only HTTP and the browser/SDK media boundary are synthetic.
vi.mock('../src/lib/workflow-api.js', async original => ({
  ...await original(), ensureIdentity: vi.fn(), getInterview: vi.fn(),
  updateInterviewMode: vi.fn(), prepareVoiceCall: vi.fn(), startVoiceCall: vi.fn(),
  getVoiceCall: vi.fn(), stopVoiceCall: vi.fn(), stopVoiceCallOnUnload: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

const credentials = {
  room_id: '12345678', sdk_app_id: 1400000001,
  user_id: 'caption-listener', bot_user_id: 'caption-bot', user_sig: 'synthetic-ticket',
};
const session = {
  session_id: '41', status: 'interview_replied', resume_mode: 'voice', save_pending: false,
  selected_topic: null, interview_scope: 'global',
  messages: [
    { id: '1', role: 'assistant', content: '想从哪段往事聊起？' },
    { id: '2', role: 'user', content: '小时候的学校。' },
    { id: '3', role: 'assistant', content: '还记得学校的样子吗？' },
  ],
};
const call = (callId, status) => ({ call_id: callId, session_id: '41', status, turn_pending: false });
const nextFrame = async () => { await flushPromises(); await nextTick(); };
const subtitle = page => page.get('[data-testid="call-subtitle"]');
const displayed = page => subtitle(page).findAll('p').map(node => node.text());
let pages, connections;

function createSdkSession() {
  const events = new Map();
  let audioTrack;
  const sdk = {
    on: vi.fn((name, handler) => events.set(name, handler)),
    off: vi.fn((name, handler) => { if (events.get(name) === handler) events.delete(name); }),
    enterRoom: vi.fn().mockResolvedValue(),
    startLocalAudio: vi.fn(async options => { audioTrack = options.option.audioTrack; }),
    getAudioTrack: () => audioTrack,
    updateLocalAudio: vi.fn().mockResolvedValue(),
    setRemoteAudioVolume: vi.fn(), stopLocalAudio: vi.fn().mockResolvedValue(),
    muteRemoteAudio: vi.fn().mockResolvedValue(), exitRoom: vi.fn().mockResolvedValue(),
    destroy: vi.fn(),
  };
  connections.push({ sdk, events, sequence: 0 });
  return sdk;
}

function packet(message, connection = connections.at(-1)) {
  return { userId: credentials.bot_user_id, cmdId: 1, seq: ++connection.sequence,
    data: new TextEncoder().encode(JSON.stringify(message)).buffer };
}
function caption(text, {
  roundId = 'round-a', startTime = '00:00:35', endTime = '00:00:43',
  complete = true, sender = credentials.bot_user_id,
} = {}) {
  return { type: 10000, sender,
    payload: { roundid: roundId, text, start_time: startTime, end_time: endTime, end: complete } };
}
function sendCaption(text, options) {
  const connection = connections.at(-1);
  connection.events.get('CUSTOM_MESSAGE')(packet(caption(text, options), connection));
}
function sendState(state, { roundId = 'round-a', timestamp = 100 } = {}) {
  const connection = connections.at(-1);
  connection.events.get('CUSTOM_MESSAGE')(packet({ type: 10001, sender: credentials.bot_user_id,
    payload: { roundid: roundId, state, timestamp } }, connection));
}
async function openCall() {
  history.replaceState(null, '', '/web/interview.html?session_id=41');
  const page = mount(ConnectedInterviewPage, { attachTo: document.body });
  pages.push(page);
  await nextFrame();
  await page.get('[data-testid="start-voice-interview"]').trigger('click');
  await nextFrame();
  expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
  expect(connections).toHaveLength(1);
  return page;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
  pages = []; connections = [];
  sessionStorage.setItem('manji.auth_token', 'synthetic-owner');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('RTCPeerConnection', function () {});
  vi.stubGlobal('TextDecoder', TextDecoder);
  vi.stubGlobal('TextEncoder', TextEncoder);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected HTTP request in offline subtitle test'); }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => {
    const track = { kind: 'audio', enabled: true, readyState: 'live',
      stop: vi.fn(function () { this.readyState = 'ended'; }) };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  }) } });
  const events = ['CUSTOM_MESSAGE', 'TRACK', 'ERROR', 'KICKED_OUT', 'CONNECTION_STATE_CHANGED', 'AUTOPLAY_FAILED'];
  vi.stubGlobal('TRTC', { create: vi.fn(createSdkSession), isSupported: vi.fn().mockResolvedValue({ result: true }),
    setLogLevel: vi.fn(), EVENT: Object.fromEntries(events.map(name => [name, name])) });
  api.ensureIdentity.mockResolvedValue({ user_id: '7', is_guest: false });
  api.getInterview.mockResolvedValue(session);
  api.updateInterviewMode.mockResolvedValue({ session_id: '41', resume_mode: 'voice' });
  api.prepareVoiceCall.mockImplementation(async () => ({
    ...call((api.prepareVoiceCall.mock.calls.length === 1 ? 'a' : 'b').repeat(32), 'PREPARED'), credentials,
  }));
  api.startVoiceCall.mockImplementation(async callId => call(callId, 'ACTIVE'));
  api.getVoiceCall.mockImplementation(async callId => call(callId, 'ACTIVE'));
  api.stopVoiceCall.mockImplementation(async callId => call(callId, 'STOPPED'));
});

afterEach(async () => {
  for (const page of pages) page.unmount();
  await flushPromises();
  expect(fetch).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('subtitles through the connected voice page and RTC parser', () => {
  it('replaces equal-length sentences within a long packet instead of accumulating its whole paragraph', async () => {
    const page = await openCall();
    sendState(3);
    sendCaption('第一句话。第二句话。');
    await nextFrame();
    expect(subtitle(page).attributes('aria-atomic')).toBe('true');
    expect(displayed(page)).toEqual(['第一句话。']);
    // Packet timestamps are not assumed to share the browser's time origin.
    await vi.advanceTimersByTimeAsync(3999); await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    await vi.advanceTimersByTimeAsync(1); await nextFrame();
    expect(displayed(page)).toEqual(['第二句话。']);
    await vi.advanceTimersByTimeAsync(4000); await nextFrame();
    expect(displayed(page)).toEqual([]);
  });

  it('immediately accepts a newer cue and its revision without replaying old sentence timers or late packets', async () => {
    const page = await openCall();
    sendState(3);
    sendCaption('第一句话。第二句话。');
    await vi.advanceTimersByTimeAsync(2000);
    const newer = { startTime: '00:01:00', endTime: '00:01:06' };
    sendCaption('新的字幕。', { ...newer, complete: false }); await nextFrame();
    expect(displayed(page)).toEqual(['新的字幕。']);
    sendCaption('修正字幕。', newer); await nextFrame();
    expect(displayed(page)).toEqual(['修正字幕。']);
    await vi.advanceTimersByTimeAsync(2000); await nextFrame();
    expect(displayed(page)).toEqual(['修正字幕。']);
    sendCaption('迟到的旧字幕。'); await nextFrame();
    expect(displayed(page)).toEqual(['修正字幕。']);
    await vi.advanceTimersByTimeAsync(4000); await nextFrame();
    expect(displayed(page)).toEqual([]);
  });

  it('clears an interrupted round immediately and prevents late captions or queued sentences from reviving it', async () => {
    const page = await openCall();
    sendState(3);
    sendCaption('第一句话。第二句话。'); await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    sendState(4, { timestamp: 200 }); await nextFrame();
    expect(displayed(page)).toEqual([]);
    sendCaption('已经结束的尾句。', { startTime: '00:00:44', endTime: '00:00:46' });
    await nextFrame();
    expect(displayed(page)).toEqual([]);
    await vi.advanceTimersByTimeAsync(10000); await nextFrame();
    expect(displayed(page)).toEqual([]);
  });

  it('lets an accepted long cue finish after done and its two-second late-packet window expires', async () => {
    const page = await openCall();
    sendState(3);
    sendCaption('第一句话。第二句话。'); await nextFrame();
    await vi.advanceTimersByTimeAsync(1000);
    sendState(5, { timestamp: 200 }); await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    await vi.advanceTimersByTimeAsync(2000); await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    sendCaption('过期窗口之后的字幕。', { startTime: '00:00:44', endTime: '00:00:46' });
    await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    await vi.advanceTimersByTimeAsync(1000); await nextFrame();
    expect(displayed(page)).toEqual(['第二句话。']);
    await vi.advanceTimersByTimeAsync(4000); await nextFrame();
    expect(displayed(page)).toEqual([]);
  });

  it('shows every sentence of a zero-duration paragraph and finishes naturally despite done and its tail timeout', async () => {
    const page = await openCall();
    const sentences = [
      '这是第一句需要完整展示的字幕内容。',
      '这是第二句需要完整展示的字幕内容。',
      '这是第三句需要完整展示的字幕内容。',
    ];
    sendState(3);
    sendCaption(sentences.join(''), { startTime: '00:00:00', endTime: '00:00:00' });
    await nextFrame();
    expect(displayed(page)).toEqual([sentences[0]]);
    sendState(5, { timestamp: 200 }); await nextFrame();
    await vi.advanceTimersByTimeAsync(2000); await nextFrame();
    expect(displayed(page)).toEqual([sentences[0]]);

    const seen = [sentences[0]];
    for (let elapsed = 2000; elapsed < 15000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200); await nextFrame();
      const visible = displayed(page);
      expect(visible.length).toBeLessThanOrEqual(1);
      if (visible.length && seen.at(-1) !== visible[0]) seen.push(visible[0]);
    }
    expect(seen).toEqual(sentences);
    expect(seen.join('')).toBe(sentences.join(''));
    expect(displayed(page)).toEqual([]);
  });

  it('accepts a tail caption arriving after done, then immediately replaces it when a new round starts', async () => {
    const page = await openCall();
    sendState(5);
    await vi.advanceTimersByTimeAsync(500);
    sendCaption('第一句话。第二句话。'); await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    await vi.advanceTimersByTimeAsync(1500); await nextFrame();
    expect(displayed(page)).toEqual(['第一句话。']);
    await vi.advanceTimersByTimeAsync(2500); await nextFrame();
    expect(displayed(page)).toEqual(['第二句话。']);
    sendState(2, { roundId: 'round-b', timestamp: 200 }); await nextFrame();
    expect(displayed(page)).toEqual([]);
    sendCaption('新一轮的字幕。', { roundId: 'round-b' }); await nextFrame();
    expect(displayed(page)).toEqual(['新一轮的字幕。']);
    sendCaption('上一轮迟到的尾句。', { startTime: '00:00:44', endTime: '00:00:46' });
    await vi.advanceTimersByTimeAsync(4000); await nextFrame();
    expect(displayed(page)).toEqual(['新一轮的字幕。']);
  });

  it('clears pending sentences on pause and ignores an old SDK callback after reconnecting', async () => {
    const page = await openCall();
    const oldConnection = connections[0], oldMessage = oldConnection.events.get('CUSTOM_MESSAGE');
    sendState(3);
    sendCaption('第一句话。第二句话。'); await nextFrame();
    await page.get('[data-testid="pause-interview"]').trigger('click'); await nextFrame();
    expect(displayed(page)).toEqual([]);
    expect(oldConnection.sdk.exitRoom).toHaveBeenCalled();
    await page.get('[data-testid="start-interview"]').trigger('click'); await nextFrame();
    expect(connections).toHaveLength(2);
    sendState(3, { roundId: 'new-call-round' });
    sendCaption('重连后的字幕。', { roundId: 'new-call-round', startTime: '00:00:01', endTime: '00:00:09' });
    await nextFrame();
    oldMessage(packet(caption('旧通话迟到字幕。'), oldConnection)); await nextFrame();
    expect(displayed(page)).toEqual(['重连后的字幕。']);
    await vi.advanceTimersByTimeAsync(4000); await nextFrame();
    expect(displayed(page)).toEqual(['重连后的字幕。']);
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(2);
  });

  it('ignores user ASR and keeps the current cue while listening, then clears it when a new reply starts', async () => {
    const page = await openCall();
    sendState(3);
    sendCaption('当前机器人的一句话。'); await nextFrame();
    sendCaption('用户的识别结果。', { sender: credentials.user_id, roundId: 'user-round' });
    sendState(1, { roundId: 'round-b', timestamp: 200 }); await nextFrame();
    expect(displayed(page)).toEqual(['当前机器人的一句话。']);
    sendState(2, { roundId: 'round-b', timestamp: 300 }); await nextFrame();
    expect(displayed(page)).toEqual([]);
    sendCaption('下一轮新的回答。', { roundId: 'round-b' }); await nextFrame();
    expect(displayed(page)).toEqual(['下一轮新的回答。']);
    sendCaption('上一轮迟到字幕。'); await nextFrame();
    expect(displayed(page)).toEqual(['下一轮新的回答。']);
    sendState(3, { roundId: 'round-c', timestamp: 400 }); await nextFrame();
    expect(displayed(page)).toEqual([]);
  });
});
