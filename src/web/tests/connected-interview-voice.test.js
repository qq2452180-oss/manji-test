import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ConnectedInterviewPage from '../src/pages/ConnectedInterviewPage.vue';
import * as api from '../src/lib/workflow-api.js';
import { navigate } from '../src/lib/navigation.js';

const media = vi.hoisted(() => ({ prepare: vi.fn(), close: vi.fn(), join: vi.fn(), release: vi.fn(), options: null }));
vi.mock('../src/lib/microphone-lease.js', () => ({ createMicrophoneLease: () => ({
  prepare: media.prepare, close: media.release, take: () => ({}),
}) }));
vi.mock('../src/lib/realtime-web-rtc.js', () => ({
  checkEnvironment: vi.fn().mockResolvedValue(true),
  createRtc: options => { media.options = options; return { join: media.join, close: media.close }; },
}));
vi.mock('../src/lib/workflow-api.js', async original => ({
  ...await original(), ensureIdentity: vi.fn(), getCatalog: vi.fn(), getStory: vi.fn(), getInterview: vi.fn(),
  startInterview: vi.fn(), updateInterviewMode: vi.fn(), prepareVoiceCall: vi.fn(),
  startVoiceCall: vi.fn(), getVoiceCall: vi.fn(), stopVoiceCall: vi.fn(), stopVoiceCallOnUnload: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

const callId = 'a'.repeat(32);
const topic = { id: '12', chapter_id: '3', title: '学过的一门手艺' };
const opening = { id: 1, role: 'assistant', content: '您是怎么开始学这门手艺的？' };
const answer = { id: 2, role: 'user', content: '我跟师傅学木工。' };
const reply = { id: 3, role: 'assistant', content: '还记得第一件作品吗？' };
const snapshot = messages => ({ session_id: '41', status: 'interview_replied', messages,
  selected_topic: topic, resume_mode: 'voice', save_pending: false });
const globalOpening = { ...opening, content: '今天想从哪段回忆聊起？' };
const globalSnapshot = (messages, resumeMode = 'voice') => ({ ...snapshot(messages),
  selected_topic: null, interview_scope: 'global', resume_mode: resumeMode });
const call = status => ({ call_id: callId, session_id: '41', status, turn_pending: false });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function open(search = '?topic_id=12&chapter_id=3') {
  history.replaceState(null, '', '/web/interview.html' + search);
  return mount(ConnectedInterviewPage);
}
async function start(page, mode = 'voice') {
  await flushPromises();
  const entrance = page.find(`[data-testid="start-${mode}-interview"]`);
  await (entrance.exists() ? entrance : page.get('[data-testid="start-interview"]')).trigger('click');
  await flushPromises();
}
function summaryOpen(page) {
  const dialog = page.find('[data-testid="call-summary"]');
  return dialog.exists() && dialog.element.open;
}
let hidden;
beforeEach(() => {
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  sessionStorage.setItem('manji.auth_token', 'owner-a');
  media.prepare.mockResolvedValue({}); media.join.mockResolvedValue(); media.close.mockResolvedValue();
  api.ensureIdentity.mockResolvedValue({ user_id: '7', is_guest: true });
  api.getCatalog.mockResolvedValue({ chapters: [{ id: '3', title: '青年生活', topics: [topic] }] });
  api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', selected_topic: topic,
    active_supplement: { session_id: '41', status: 'in_progress' } });
  api.getInterview.mockResolvedValue(snapshot([opening]));
  api.startInterview.mockResolvedValue({ session_id: '41' });
  api.updateInterviewMode.mockResolvedValue({ session_id: '41', resume_mode: 'voice' });
  api.prepareVoiceCall.mockResolvedValue({ ...call('PREPARED'), credentials: { user_id: 'rtc-user' } });
  api.startVoiceCall.mockResolvedValue(call('ACTIVE'));
  api.getVoiceCall.mockResolvedValue(call('ACTIVE'));
  api.stopVoiceCall.mockResolvedValue(call('STOPPED'));
});

describe('connected voice entrance', () => {
  it('starts a global voice call without a topic and reconnects the same session after pausing', async () => {
    api.getInterview.mockResolvedValue(globalSnapshot([globalOpening]));
    const page = open(''); await flushPromises();
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(false);
    expect(page.get('[data-testid="start-voice-interview"]').text()).toBe('语音讲述');
    expect(page.get('[data-testid="start-text-interview"]').text()).toBe('文字讲述');
    expect(media.prepare).not.toHaveBeenCalled();

    await start(page);
    expect(api.startInterview).toHaveBeenCalledExactlyOnceWith(undefined, { resumeMode: 'voice' });
    expect(api.getCatalog).not.toHaveBeenCalled();
    expect(api.prepareVoiceCall).toHaveBeenCalledWith('41', expect.any(String), {});
    expect(media.prepare.mock.invocationCallOrder[0]).toBeLessThan(api.startInterview.mock.invocationCallOrder[0]);
    expect(api.prepareVoiceCall.mock.invocationCallOrder[0]).toBeLessThan(media.join.mock.invocationCallOrder[0]);
    expect(media.join.mock.invocationCallOrder[0]).toBeLessThan(api.startVoiceCall.mock.invocationCallOrder[0]);
    expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
    expect(page.find('.prototype-interview-topic').exists()).toBe(false);
    expect(page.find('.prototype-interview-label').exists()).toBe(false);
    expect(page.find('.prototype-topic-note-hint').exists()).toBe(false);
    expect(page.find('textarea').exists()).toBe(false);
    expect(new URLSearchParams(location.search).get('topic_id')).toBeNull();

    api.getInterview.mockResolvedValue(globalSnapshot([globalOpening, answer, reply]));
    media.options.onAgentState({ state: 3, roundId: 'global-round-1' });
    await page.get('[data-testid="pause-interview"]').trigger('click'); await flushPromises();
    expect(api.stopVoiceCall).toHaveBeenCalledWith(callId);
    expect(page.get('[data-testid="start-interview"]').text()).toBe('继续');
    await start(page);
    expect(api.startInterview).toHaveBeenCalledTimes(1);
    expect(api.prepareVoiceCall).toHaveBeenLastCalledWith('41', expect.any(String), {
      resume_kind: 'pause_replay', resume_message_id: '3',
    });
    expect(api.startVoiceCall).toHaveBeenCalledTimes(2);
    expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
  });

  it('resumes a global text interview as voice from its session ID without creating another session', async () => {
    api.getInterview.mockResolvedValue(globalSnapshot([globalOpening, answer, reply], 'text'));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.find('[data-testid="legacy-select-topic"]').exists()).toBe(false);
    expect(media.prepare).not.toHaveBeenCalled();

    await start(page, 'voice');
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.getCatalog).not.toHaveBeenCalled();
    expect(api.updateInterviewMode).toHaveBeenCalledExactlyOnceWith('41', 'voice');
    expect(api.prepareVoiceCall).toHaveBeenCalledWith('41', expect.any(String), {
      resume_kind: 'home_return', resume_request_id: expect.any(String),
    });
    expect(media.prepare).toHaveBeenCalledTimes(1);
    expect(media.join).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledExactlyOnceWith(callId);
    expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
    expect(page.find('textarea').exists()).toBe(false);
    expect(new URLSearchParams(location.search).get('interaction')).toBe('voice');
  });

  it.each([
    ['topic', '?session_id=41&topic_id=12&chapter_id=3'],
    ['global', '?session_id=41'],
    ['supplement', '?topic_id=12&chapter_id=3&story_id=81'],
  ])('requests one saved-history opening when returning to an unfinished %s interview', async (kind, search) => {
    const messages = [kind === 'global' ? globalOpening : opening, answer, reply];
    const value = kind === 'global' ? globalSnapshot(messages) : {
      ...snapshot(messages), ...(kind === 'supplement' ? { target_story_id: '81' } : {}),
    };
    api.getInterview.mockResolvedValue(value);
    const page = open(search); await flushPromises();
    expect(api.prepareVoiceCall).not.toHaveBeenCalled();
    expect(media.prepare).not.toHaveBeenCalled();
    await start(page);
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.prepareVoiceCall).toHaveBeenCalledExactlyOnceWith('41', expect.any(String), {
      resume_kind: 'home_return', resume_request_id: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
    });
    if (kind === 'supplement') expect(api.getStory).toHaveBeenCalledExactlyOnceWith('81');

    // The server appends its saved recap, and pausing that playback should replay it.
    const recap = { id: 4, role: 'assistant', content: '上次您说起跟师傅学木工，我们接着聊。' };
    api.getInterview.mockResolvedValue({ ...value, messages: [...messages, recap] });
    media.options.onAgentState({ state: 3, roundId: 'return-opening' });
    await page.get('[data-testid="pause-interview"]').trigger('click'); await flushPromises();
    await start(page);
    expect(api.prepareVoiceCall).toHaveBeenLastCalledWith('41', expect.any(String), {
      resume_kind: 'pause_replay', resume_message_id: '4',
    });
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('reuses the home-return request on failure and uses pause-continue after successful recovery', async () => {
    const messages = [opening, answer, reply];
    api.getInterview.mockResolvedValue(snapshot(messages));
    api.startVoiceCall.mockRejectedValueOnce(new Error('恢复开场暂时不可用'));
    const page = open('?session_id=41'); await start(page);
    const options = api.prepareVoiceCall.mock.calls[0][2];
    expect(options).toEqual({ resume_kind: 'home_return', resume_request_id: expect.any(String) });
    expect(page.get('[role="alert"]').text()).toContain('恢复开场');

    await start(page);
    expect(api.prepareVoiceCall.mock.calls[1][2]).toEqual(options);
    expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
    const recap = { id: 4, role: 'assistant', content: '您刚才讲到木工师傅，后来呢？' };
    api.getInterview.mockResolvedValue(snapshot([...messages, recap]));
    media.options.onAgentState({ state: 1, roundId: 'return-opening' });
    await page.get('[data-testid="pause-interview"]').trigger('click'); await flushPromises();
    await start(page);
    expect(api.prepareVoiceCall).toHaveBeenLastCalledWith('41', expect.any(String), {
      resume_kind: 'pause_continue', resume_message_id: '4',
    });
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it.each([
    ['starting in text', false],
    ['switching to text after a failed opening', true],
  ])('clears the return opening when %s before continuing in voice', async (_label, failedOpening) => {
    const messages = [opening, answer, reply];
    const recap = { id: 4, role: 'assistant', content: '上次您说起跟师傅学木工，我们接着聊。' };
    api.getInterview.mockResolvedValue(snapshot(messages));
    if (failedOpening) {
      api.startVoiceCall.mockImplementationOnce(async () => {
        api.getInterview.mockResolvedValue(snapshot([...messages, recap]));
        throw new Error('恢复开场暂时不可用');
      });
    }
    const page = open('?session_id=41');
    await start(page, failedOpening ? 'voice' : 'text');
    if (failedOpening) {
      expect(api.prepareVoiceCall.mock.calls[0][2]).toEqual({
        resume_kind: 'home_return', resume_request_id: expect.any(String),
      });
      expect(page.get('[role="alert"]').text()).toContain('恢复开场');
      await page.get('[data-testid="switch-interview-mode"]').trigger('click'); await flushPromises();
      expect(new URLSearchParams(location.search).get('interaction')).toBe('text');
    } else {
      expect(api.prepareVoiceCall).not.toHaveBeenCalled();
      expect(media.prepare).not.toHaveBeenCalled();
      expect(page.get('textarea').element.disabled).toBe(false);
    }

    // Text has advanced the saved conversation beyond any previous return recap.
    api.getInterview.mockResolvedValue({ ...snapshot([
      ...messages, ...(failedOpening ? [recap] : []),
      { id: 5, role: 'user', content: '第一件做的是小板凳。' },
      { id: 6, role: 'assistant', content: '做成小板凳时是什么心情？' },
    ]), resume_mode: 'text' });
    if (!failedOpening) {
      await page.get('[data-testid="switch-interview-mode"]').trigger('click'); await flushPromises();
    }
    await start(page, 'voice');
    expect(api.prepareVoiceCall).toHaveBeenCalledTimes(failedOpening ? 2 : 1);
    expect(api.prepareVoiceCall).toHaveBeenLastCalledWith('41', expect.any(String), {});
    expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('opens voice on Start, joins before starting the bot, and shows live captions', async () => {
    const page = open(); await flushPromises();
    expect(page.get('[data-testid="interview-entry-choice"]').findAll('button').map(button => button.text()))
      .toEqual(['语音访谈', '文字访谈']);
    expect(page.get('main').findAll('button')).toHaveLength(2);
    expect(summaryOpen(page)).toBe(false);
    expect(page.get('h1').text()).toBe(topic.title);
    expect(page.find('textarea').exists()).toBe(false);
    expect(page.find('[data-testid="finish-interview"]').exists()).toBe(false);
    expect(media.prepare).not.toHaveBeenCalled();
    expect(api.prepareVoiceCall).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
    await start(page);
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(false);
    expect(api.startInterview).toHaveBeenCalledExactlyOnceWith('12', { resumeMode: 'voice' });
    expect(api.prepareVoiceCall).toHaveBeenCalledWith('41', expect.any(String), {});
    expect(media.prepare.mock.invocationCallOrder[0]).toBeLessThan(api.ensureIdentity.mock.invocationCallOrder[0]);
    expect(media.join.mock.invocationCallOrder[0]).toBeLessThan(api.startVoiceCall.mock.invocationCallOrder[0]);
    expect(page.get('[data-testid="voice-call"]').text()).toContain('通话中');
    expect(page.find('.prototype-interview-topic').exists()).toBe(false);
    expect(page.find('.prototype-interview-label').exists()).toBe(false);
    expect(page.find('.prototype-topic-note-hint').exists()).toBe(false);
    expect(page.find('[data-testid="switch-interview-mode"]').exists()).toBe(false);
    expect(page.find('textarea').exists()).toBe(false);
    media.options.onAgentState({ state: 3, roundId: 'round-1' });
    media.options.onCaption({ text: reply.content, roundId: 'round-1', startTime: '00:00:01', endTime: '00:00:03', complete: true });
    await flushPromises();
    expect(page.get('[data-testid="voice-call"]').text()).toContain(reply.content);
    expect(page.find('.voice-ring.is-speaking').exists()).toBe(true);
  });

  it('pauses and reconnects the same interview, then allows switching to text', async () => {
    const page = open(); await start(page);
    api.getInterview.mockResolvedValue(snapshot([opening, answer, reply]));
    media.options.onAgentState({ state: 3, roundId: 'round-1' });
    await page.get('[data-testid="pause-interview"]').trigger('click'); await flushPromises();
    expect(media.close).toHaveBeenCalled();
    expect(api.stopVoiceCall).toHaveBeenCalledWith(callId);
    expect(page.get('[data-testid="start-interview"]').text()).toBe('继续');
    await start(page);
    expect(api.prepareVoiceCall).toHaveBeenLastCalledWith('41', expect.any(String), {
      resume_kind: 'pause_replay', resume_message_id: '3',
    });
    expect(api.startInterview).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledTimes(2);
    await page.get('[data-testid="pause-interview"]').trigger('click'); await flushPromises();
    await page.get('[data-testid="switch-interview-mode"]').trigger('click'); await flushPromises();
    expect(page.find('[data-testid="voice-call"]').exists()).toBe(false);
    expect(page.find('textarea').exists()).toBe(true);
    expect(api.updateInterviewMode).toHaveBeenLastCalledWith('41', 'text');
    expect(new URLSearchParams(location.search).get('interaction')).toBe('text');
    await start(page, 'text');
    expect(page.get('textarea').element.disabled).toBe(false);
    expect(media.prepare).toHaveBeenCalledTimes(2);
  });

  it('does not create a session when microphone permission is denied', async () => {
    media.prepare.mockRejectedValueOnce(new Error('请允许麦克风权限'));
    const page = open(); await start(page);
    expect(page.get('[role="alert"]').text()).toContain('麦克风权限');
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.prepareVoiceCall).not.toHaveBeenCalled();
    expect(page.get('[data-testid="start-interview"]').element.disabled).toBe(false);
  });

  it('closes audio immediately, waits for the final saved turn, and only organizes after confirmation', async () => {
    vi.useFakeTimers();
    const page = open('?session_id=41'); await start(page);
    const stopped = deferred(); api.stopVoiceCall.mockReturnValueOnce(stopped.promise);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(media.close).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(summaryOpen(page)).toBe(false);
    expect(page.get('[data-testid="finish-interview"]').element.disabled).toBe(true);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(api.stopVoiceCall).toHaveBeenCalledExactlyOnceWith(callId);

    stopped.resolve({ ...call('STOPPED'), turn_pending: true }); await flushPromises();
    expect(summaryOpen(page)).toBe(false);
    api.getInterview.mockResolvedValue(snapshot([opening, answer, reply]));
    api.getVoiceCall.mockResolvedValue(call('STOPPED'));
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(summaryOpen(page)).toBe(true);
    expect(page.get('[data-testid="call-summary"]').element.tagName).toBe('DIALOG');
    expect(page.get('[data-testid="generate-biography"]').element.disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(api.startVoiceCall).toHaveBeenCalledTimes(1);

    await page.get('[data-testid="generate-biography"]').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./organizing.html?session_id=41');
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it.each([
    ['topic', '?session_id=41&topic_id=12&chapter_id=3', './index.html?chapter_id=3'],
    ['global', '?session_id=41', './index.html'],
    ['supplement', '?topic_id=12&chapter_id=3&story_id=81', './story.html?story_id=81'],
  ])('defers biography generation while retaining the %s interview for recovery', async (kind, search, back) => {
    const value = kind === 'global' ? globalSnapshot([globalOpening, answer, reply]) : {
      ...snapshot([opening, answer, reply]), ...(kind === 'supplement' ? { target_story_id: '81' } : {}),
    };
    api.getInterview.mockResolvedValue(value);
    const page = open(search); await start(page);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(summaryOpen(page)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    await page.get('[data-testid="chat-later"]').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(back);
    expect(api.stopVoiceCall).toHaveBeenCalledExactlyOnceWith(callId);
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.41')).owner).toBe('owner-a');
  });

  it('keeps the original story target when explicitly generating from a supplement call', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot([opening, answer, reply]), target_story_id: '81' });
    const page = open('?topic_id=12&chapter_id=3&story_id=81'); await start(page);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    await page.get('[data-testid="generate-biography"]').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./organizing.html?session_id=41&story_id=81');
  });

  it.each(['close', 'escape'])('leaves the call paused after dismissing the summary with %s until explicitly continued', async method => {
    api.getInterview.mockResolvedValue(snapshot([opening, answer, reply]));
    const page = open('?session_id=41'); await start(page);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(summaryOpen(page)).toBe(true);
    if (method === 'escape') await page.get('[data-testid="call-summary"]').trigger('cancel');
    else await page.get('[data-testid="close-call-summary"]').trigger('click');
    await flushPromises();
    expect(summaryOpen(page)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(page.get('[data-testid="voice-call"]').text()).toContain('已暂停');
    expect(media.prepare).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledTimes(1);

    await start(page);
    expect(media.prepare).toHaveBeenCalledTimes(2);
    expect(api.startVoiceCall).toHaveBeenCalledTimes(2);
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it.each(['stop', 'stop-sync', 'final-sync'])('retains a recoverable paused call instead of offering generation after a %s failure', async failure => {
    api.getInterview.mockResolvedValue(snapshot([opening, answer, reply]));
    const page = open('?session_id=41'); await start(page);
    if (failure === 'stop') api.stopVoiceCall.mockRejectedValueOnce(new Error('停止通话失败，请重试'));
    else {
      if (failure === 'final-sync') api.getInterview.mockResolvedValueOnce(snapshot([opening, answer, reply]));
      api.getInterview.mockRejectedValueOnce(new Error('记录读取失败，请重试'));
    }
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(media.close).toHaveBeenCalled();
    expect(summaryOpen(page)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(page.get('[role="alert"]').text()).toContain('失败');
    expect(page.get('[data-testid="voice-call"]').text()).toContain('已暂停');

    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(summaryOpen(page)).toBe(true);
    expect(page.get('[data-testid="generate-biography"]').element.disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('discards an open call summary when the account changes', async () => {
    api.getInterview.mockResolvedValue(snapshot([opening, answer, reply]));
    const page = open('?session_id=41'); await start(page);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(summaryOpen(page)).toBe(true);
    sessionStorage.setItem('manji.auth_token', 'owner-b');
    window.dispatchEvent(new Event('manji:auth-changed')); await flushPromises();
    expect(summaryOpen(page)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(page.text()).toContain('登录状态已变化');
    expect(api.startVoiceCall).toHaveBeenCalledTimes(1);
  });

  it('closes on background and returns paused without reopening the microphone', async () => {
    const page = open(); await start(page);
    hidden = true; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(api.stopVoiceCallOnUnload).toHaveBeenCalledWith(callId, 'owner-a');
    expect(media.close).toHaveBeenCalled();
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(page.get('[data-testid="start-interview"]').element.disabled).toBe(false);
    expect(media.prepare).toHaveBeenCalledTimes(1);
    expect(api.startVoiceCall).toHaveBeenCalledTimes(1);
  });

  it('closes audio when a completed-turn refresh makes the page show paused', async () => {
    const page = open(); await start(page);
    api.getInterview.mockRejectedValueOnce(new Error('记录读取失败'));
    media.options.onAgentState({ state: 5, roundId: 'round-1' }); await flushPromises();
    expect(page.get('[data-testid="voice-call"]').text()).toContain('已暂停');
    expect(page.get('[data-testid="start-interview"]').text()).toBe('重试');
    expect(media.close).toHaveBeenCalled();
    expect(api.stopVoiceCall).toHaveBeenCalledWith(callId);
    expect(page.get('[role="alert"]').text()).toContain('记录读取失败');
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.41')).error).toBe('');
  });

  it('drops an old RTC error on reload while preserving the unsent draft', async () => {
    sessionStorage.setItem('manji.connected.draft.41', JSON.stringify({ owner: 'owner-a',
      text: '我还记得那条上学的路。', error: '缺少腾讯 UserSig 签名依赖', pendingInput: null }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.find('[role="alert"]').exists()).toBe(false);
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(true);
    expect(page.find('textarea').exists()).toBe(false);
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.41')).text).toBe('我还记得那条上学的路。');
    await start(page, 'text');
    expect(page.get('textarea').element.value).toBe('我还记得那条上学的路。');
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.41')).error).toBe('');
    expect(media.prepare).not.toHaveBeenCalled();
    expect(api.prepareVoiceCall).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('starts voice by default even when the saved interview last used text', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot([opening, answer, reply]), resume_mode: 'text' });
    const page = open('?session_id=41'); await start(page);
    expect(page.find('[data-testid="voice-call"]').exists()).toBe(true);
    expect(page.find('textarea').exists()).toBe(false);
    expect(media.prepare).toHaveBeenCalledTimes(1);
    expect(api.updateInterviewMode).toHaveBeenCalledWith('41', 'voice');
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('offers a saved-call summary before the first answer with generation unavailable', async () => {
    const page = open(); await start(page);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(api.stopVoiceCall).toHaveBeenCalledWith(callId);
    expect(summaryOpen(page)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(page.get('[data-testid="generate-biography"]').element.disabled).toBe(true);
    expect(page.get('[data-testid="call-summary"]').text()).toMatch(/还没有|尚未/);
    await page.get('[data-testid="generate-biography"]').trigger('click'); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    await page.get('[data-testid="chat-later"]').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html?chapter_id=3');
  });

  it('preserves an unsent draft and explains why it must be sent before generation', async () => {
    const text = '我还记得那条上学的路。';
    sessionStorage.setItem('manji.connected.draft.41', JSON.stringify({ owner: 'owner-a', text, error: '', pendingInput: null }));
    api.getInterview.mockResolvedValue(snapshot([opening, answer, reply]));
    const page = open('?session_id=41'); await start(page);
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(summaryOpen(page)).toBe(true);
    expect(page.get('[data-testid="generate-biography"]').element.disabled).toBe(true);
    expect(page.get('[data-testid="call-summary"]').text()).toContain('文字');
    expect(page.get('[data-testid="call-summary"]').text()).toContain('发送');
    await page.get('[data-testid="chat-later"]').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html?chapter_id=3');
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.41')).text).toBe(text);
  });

  it('can cancel while microphone permission is pending without connecting afterwards', async () => {
    const permission = deferred(); media.prepare.mockReturnValueOnce(permission.promise);
    const page = open(); await flushPromises();
    await page.get('[data-testid="start-voice-interview"]').trigger('click'); await flushPromises();
    expect(page.get('[data-testid="finish-interview"]').text()).toBe('取消');
    await page.get('[data-testid="finish-interview"]').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html?chapter_id=3');
    permission.resolve({}); await flushPromises();
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.prepareVoiceCall).not.toHaveBeenCalled();
  });

  it.each([
    ['text', 'voice'],
    ['voice', 'text'],
  ])('opens the selected %s entrance over saved %s mode', async (interaction, saved) => {
    api.getInterview.mockResolvedValue({ ...snapshot([opening, answer, reply]), resume_mode: saved });
    const page = open(`?session_id=41&interaction=${saved}`); await start(page, interaction);
    expect(api.updateInterviewMode).toHaveBeenCalledWith('41', interaction);
    expect(media.prepare).toHaveBeenCalledTimes(interaction === 'voice' ? 1 : 0);
    expect(page.find('[data-testid="voice-call"]').exists()).toBe(interaction === 'voice');
    expect(new URLSearchParams(location.search).get('interaction')).toBe(interaction);
  });

  it('starts from the text entrance directly without acquiring the microphone', async () => {
    const page = open('?topic_id=12&chapter_id=3'); await start(page, 'text');
    expect(api.startInterview).toHaveBeenCalledExactlyOnceWith('12', { resumeMode: 'text' });
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
    expect(new URLSearchParams(location.search).get('interaction')).toBe('text');
    expect(page.get('textarea').element.disabled).toBe(false);
    expect(media.prepare).not.toHaveBeenCalled();
  });
});
