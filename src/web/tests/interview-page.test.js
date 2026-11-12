import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import InterviewPage from '../src/pages/InterviewPage.vue';
import { createInterviewController } from '../src/lib/interview-controller.js';
import { createRtc, checkEnvironment, preflightMicrophone } from '../src/lib/realtime-web-rtc.js';
import * as api from '../src/lib/api.js';
import * as appState from '../src/lib/app-state.js';
import { navigate, reloadPage } from '../src/lib/navigation.js';
import interviewStyles from '../src/styles/interview.css?raw';
import { completeVoiceGuide } from '../src/lib/voice-guide-state.js';

vi.mock('../src/lib/interview-controller.js', () => ({ createInterviewController: vi.fn() }));
vi.mock('../src/lib/realtime-web-rtc.js', () => ({ createRtc: vi.fn(), checkEnvironment: vi.fn(), preflightMicrophone: vi.fn() }));
vi.mock('../src/lib/microphone-lease.js', () => ({ createMicrophoneLease: vi.fn(() => ({ prepare: () => preflightMicrophone(), take: vi.fn(), close: vi.fn() })) }));
vi.mock('../src/lib/onboarding-narration.js', async importOriginal => ({ ...(await importOriginal()), createOnboardingNarration: () => ({ prepare: vi.fn(), activate: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn(), destroy: vi.fn() }) }));
vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(), getPhotoBlob: vi.fn() }));
vi.mock('../src/lib/app-state.js', () => ({ setActiveSessionId: vi.fn(), setOrganizationSessionId: vi.fn(), removeActiveSessionId: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const button = (wrapper, label) => wrapper.findAll('button').find(node => node.text() === label);
const segment = (startTime, text, complete = true) => ({ startTime, endTime: startTime, text, complete });
const snapshot = extra => ({
  phase: 'paused', entry: 'GENERAL', sessionId: 'session-a', turns: [], attachments: [],
  initialized: true, restoredSession: false, restoredDraft: false, connectionError: null,
  connectionState: extra?.phase === 'connected' ? 'connected' : extra?.phase === 'connecting' ? 'connecting' : 'paused',
  opening: '不应该出现在语音字幕里的开场白', question: '不应该出现在语音字幕里的历史回答', transcript: '',
  caption: '', captionSpeaker: '', captionRoundId: '', agentState: 0, muted: false,
  busy: false, saving: false, activityState: 'PAUSED', pending: false, transportClosed: !extra?.saving,
  errorStage: '', notice: '', maxImages: 250,
  canStart: true, canPause: false, canSubmit: true, canRetryInput: true, canRetryCall: false, canFinish: true,
  ...extra,
});
let initial, controller, handlers;

function emit(patch = {}) {
  if (!patch.connectionState && ['connected', 'connecting', 'paused'].includes(patch.phase)) patch = { ...patch, connectionState: patch.phase };
  initial = { ...initial, ...patch };
  handlers.onChange(initial);
}
function render(query = '') {
  history.replaceState(null, '', '/web2/interview.html' + query);
  return mount(InterviewPage, { attachTo: document.body });
}
async function visibility(hidden) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
  await nextTick();
}
async function selectFiles(wrapper, files) {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', { configurable: true, value: files });
  await input.trigger('change');
  await flushPromises();
}

beforeEach(() => {
  vi.resetAllMocks();
  completeVoiceGuide();
  initial = snapshot();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  if (!performance.getEntriesByType) performance.getEntriesByType = () => [];
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'navigate' }]);
  api.getAuthToken.mockReturnValue('test-token');
  api.getPhotoBlob.mockResolvedValue(new Blob(['photo'], { type: 'image/jpeg' }));
  createInterviewController.mockImplementation(options => {
    handlers = options;
    controller = {
      initialize: vi.fn(async () => { emit(); return initial; }), snapshot: vi.fn(() => initial),
      start: vi.fn(async () => { emit({ phase: 'connected', canStart: false, canPause: true }); }),
      resume: vi.fn(async () => { emit({ phase: 'connected', canStart: false, canPause: true }); }),
      pause: vi.fn(async () => { emit({ phase: 'paused', caption: '', captionSegments: [], agentState: 0, canStart: true, canPause: false }); }),
      retryPause: vi.fn(async () => { emit({ phase: 'paused', errorStage: '' }); }),
      uploadPhotos: vi.fn(async files => { emit({ attachments: files.map((file, index) => ({ id: 'upload-' + index, mediaId: 'media-' + index, state: 'uploaded', name: file.name })) }); }),
      retryUpload: vi.fn(), removePhoto: vi.fn(), submit: vi.fn().mockResolvedValue({ response_id: 'response-a' }),
      retryInput: vi.fn(), finish: vi.fn(), destroy: vi.fn(),
      setVisible: vi.fn(value => { if (!value) emit({ phase: 'paused', caption: '', captionSegments: [], agentState: 0 }); }),
      authChanged: vi.fn(() => { emit({ phase: 'auth', caption: '', captionSegments: [], agentState: 0, attachments: [], turns: [], notice: '请重新登录' }); }),
    };
    return controller;
  });
});

describe('Vue minimal Xiaonuan voice page', () => {
  it('renders saved resume questions in text history and keeps existing message nodes when an older turn arrives', async () => {
    initial = snapshot({ opening: '', resumeOpenings: [
      { call_id: 'new-call', text: '后来到了哪里？', created_at: '2026-10-19T10:00:00.000900Z' },
    ], turns: [
      { turn_id: 'new-answer', sequence_no: 1, user_text: '到了上海。', assistant_text: '在上海做什么？',
        realtime_call_id: 'new-call', call_started_at: '2026-10-19T10:00:00.000900Z', created_at: '2026-10-19T10:00:01Z' },
    ] });
    const wrapper = render('?session_id=session-a&interaction=text'); await flushPromises();
    const openingNode = wrapper.findAll('.chat-message')[0].element;
    expect(wrapper.findAll('.chat-bubble').map(node => node.text())).toEqual(['后来到了哪里？', '到了上海。', '在上海做什么？']);
    emit({ turns: [...initial.turns, { turn_id: 'late-old-answer', sequence_no: 2, user_text: '河边还有一座桥。', assistant_text: '',
      realtime_call_id: 'old-call', call_started_at: '2026-10-19T10:00:00.000100Z', created_at: '2026-10-19T10:00:02Z' }] });
    await nextTick();
    expect(wrapper.findAll('.chat-bubble').map(node => node.text())).toEqual(['河边还有一座桥。', '后来到了哪里？', '到了上海。', '在上海做什么？']);
    expect(wrapper.findAll('.chat-message')[1].element).toBe(openingNode);
    expect(wrapper.text()).not.toContain(initial.question);
    wrapper.unmount();
  });

  it('offers chat later after pausing and keeps the same session without organizing it', async () => {
    const wrapper = render('?session_id=session-a'); await flushPromises();
    const later = button(wrapper, '下次聊');
    expect(later.attributes('disabled')).toBeUndefined();
    await later.trigger('click'); await flushPromises();
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(appState.setActiveSessionId).toHaveBeenLastCalledWith('session-a');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html');
    expect(controller.finish).not.toHaveBeenCalled();
    expect(appState.removeActiveSessionId).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'pausing', pending: true, transportClosed: false },
    { phase: 'paused', pending: true, transportClosed: false },
    { phase: 'paused', busy: true, attachments: [{ state: 'uploading' }] },
    { phase: 'paused', attachments: [{ state: 'failed', error: '上传失败' }] },
  ])('keeps chat later disabled while the call or selected photos are unsettled: %j', async extra => {
    initial = snapshot({ connectionState: 'paused', ...extra });
    const wrapper = render('?session_id=session-a'); await flushPromises();
    expect(button(wrapper, '下次聊').attributes('disabled')).toBeDefined();
    await button(wrapper, '下次聊').trigger('click');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('allows chat later once transport closes even if final material is still being reconciled', async () => {
    initial = snapshot({ saving: true, transportClosed: true, materialState: 'WAITING_CALLBACK' });
    const wrapper = render('?session_id=session-a'); await flushPromises();
    expect(button(wrapper, '下次聊').attributes('disabled')).toBeUndefined();
    await button(wrapper, '下次聊').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledWith('./index.html');
  });

  it('stays on the page after pause fails and retries chat later without starting a call', async () => {
    initial = snapshot({ errorStage: 'pause', pending: true, transportClosed: false, phase: 'error' });
    const wrapper = render('?session_id=session-a'); await flushPromises();
    await button(wrapper, '下次聊').trigger('click'); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('暂停成功');
    controller.pause.mockImplementationOnce(async () => emit({ phase: 'paused', pending: false, transportClosed: true, errorStage: '' }));
    await button(wrapper, '下次聊').trigger('click'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./index.html');
    expect(controller.resume).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'unmount', 'owner'])('ignores a late chat-later result after %s', async boundary => {
    const wrapper = render('?session_id=session-a'); await flushPromises();
    const pending = deferred(); controller.pause.mockReturnValueOnce(pending.promise);
    await button(wrapper, '下次聊').trigger('click');
    if (boundary === 'hidden') await visibility(true);
    if (boundary === 'unmount') wrapper.unmount();
    if (boundary === 'owner') api.getAuthToken.mockReturnValue('another-owner');
    pending.resolve(); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(appState.setActiveSessionId).not.toHaveBeenCalled();
  });

  it('shows resume preparation progress in the existing caption area and allows cancellation', async () => {
    initial = snapshot({ phase: 'connecting', busy: true, canStart: false,
      notice: '小暖正在回顾刚才的讲述，马上接着聊。' });
    const wrapper = render('?session_id=session-a'); await flushPromises();
    expect(wrapper.get('.voice-caption').text()).toBe(initial.notice);
    expect(button(wrapper, '继续聊')).toBeUndefined();
    await wrapper.get('[aria-label="暂停访谈"]').trigger('click');
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(wrapper.get('.voice-caption').text()).toBe('已暂停，可以继续聊或补充照片。');
  });

  it('renders only pause, ring, and live sentence without stored question or conversation controls', async () => {
    initial = snapshot({ phase: 'connected', agentState: 3, caption: '小暖此刻正在说的这句话。', captionSpeaker: 'assistant',
      turns: [{ sequence_no: 1, user_text: '以前讲述的文字', assistant_text: '以前保存的回答' }] });
    const wrapper = render(); await flushPromises();
    expect(wrapper.find('header').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(1);
    expect(wrapper.get('button').attributes('aria-label')).toBe('暂停访谈');
    expect(wrapper.get('.voice-ring').classes()).toContain('is-speaking');
    expect(wrapper.get('.voice-caption').text()).toBe('小暖此刻正在说的这句话。');
    expect(wrapper.find('.chat-messages').exists()).toBe(false);
    expect(wrapper.find('.material-composer').exists()).toBe(false);
    expect(wrapper.find('textarea').exists()).toBe(false);
    for (const unwanted of ['历史回答', '开场白', '以前讲述', '以前保存', '静音', '历史记录', '改用语音', '文字讲述']) expect(wrapper.text()).not.toContain(unwanted);
    emit({ caption: '', agentState: 3 }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('小暖正在说话…');
    expect(wrapper.text()).not.toContain(initial.question);
  });

  it('shows a long fallback caption at natural height, with listening and thinking only for their live state', async () => {
    initial = snapshot({ phase: 'connected', agentState: 3, caption: '这是一句完整展开的较长字幕，回忆里的每个细节都可以慢慢讲，不用着急。', captionSpeaker: 'assistant' });
    const wrapper = render(); await flushPromises();
    const caption = wrapper.get('.voice-caption');
    expect(caption.text()).toBe(initial.caption);
    expect(caption.attributes('tabindex')).toBeUndefined();
    const style = document.createElement('style'); style.textContent = interviewStyles; document.head.append(style);
    try {
      const computed = getComputedStyle(caption.element);
      expect(['', 'auto']).toContain(computed.height);
      expect(['', 'none']).toContain(computed.maxHeight);
      expect(['', 'visible']).toContain(computed.overflow);
      expect(['', 'visible']).toContain(computed.overflowY);
    } finally { style.remove(); }
    const scrollWrites = vi.spyOn(caption.element, 'scrollTop', 'set');
    emit({ caption: '第二句话。' }); await nextTick(); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('第二句话。');
    expect(scrollWrites).not.toHaveBeenCalled();
    emit({ caption: '', agentState: 2 }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('小暖正在想…');
    expect(wrapper.get('.voice-ring').classes()).toContain('is-thinking');
    emit({ agentState: 1 }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('小暖正在听您讲话');
    emit({ muted: true }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('');
    emit({ phase: 'paused', muted: false }); await nextTick();
    expect(wrapper.text()).not.toContain('正在听您讲话');
  });

  it('pauses immediately and offers the existing actions plus chat later', async () => {
    initial = snapshot({ phase: 'connected', agentState: 3, caption: '正在播放。', captionSpeaker: 'assistant',
      captionSegments: [segment('00:00:01', '正在播放。')] });
    const wrapper = render(); await flushPromises();
    wrapper.get('[aria-label="暂停访谈"]').element.click();
    expect(controller.pause).toHaveBeenCalledOnce();
    await flushPromises();
    expect(wrapper.findAll('button').map(node => node.text())).toEqual(['继续聊', '传张照片', '结束并整理', '下次聊']);
    expect(wrapper.get('.voice-ring').classes()).toContain('is-paused');
    expect(wrapper.text()).toContain('已暂停，可以继续聊或补充照片。');
    expect(wrapper.text()).not.toContain('正在播放。');
    await button(wrapper, '结束并整理').trigger('click');
    expect(controller.finish).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it('selecting, cancelling or uploading a photo keeps the page paused without submitting or opening audio', async () => {
    const wrapper = render(); await flushPromises();
    const input = wrapper.get('input[type="file"]');
    const picker = vi.spyOn(input.element, 'click').mockImplementation(() => {});
    await button(wrapper, '传张照片').trigger('click');
    expect(picker).toHaveBeenCalledOnce();
    await selectFiles(wrapper, []);
    expect(controller.uploadPhotos).not.toHaveBeenCalled();
    const file = new File(['fixture'], '往事.jpg', { type: 'image/jpeg' });
    await selectFiles(wrapper, [file]);
    expect(controller.uploadPhotos).toHaveBeenCalledExactlyOnceWith([file]);
    expect(wrapper.get('.voice-ring').classes()).toContain('is-paused');
    expect(wrapper.text()).toContain('点“继续聊”后，小暖才会看到这些照片。');
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(controller.submit).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('explicit continue submits uploaded photos once with auto-resume and blocks repeated clicks during submission', async () => {
    initial = snapshot({ attachments: [{ id: 'photo-1', mediaId: 'media-1', state: 'uploaded', name: '照片.jpg' }] });
    const wrapper = render(); await flushPromises();
    const pending = deferred(); controller.submit.mockReturnValue(pending.promise);
    const continueButton = button(wrapper, '继续聊');
    continueButton.element.dispatchEvent(new MouseEvent('click'));
    continueButton.element.dispatchEvent(new MouseEvent('click'));
    await nextTick();
    expect(controller.submit).toHaveBeenCalledExactlyOnceWith({ text: '', autoResume: true });
    expect(continueButton.attributes('disabled')).toBeDefined();
    expect(controller.resume).not.toHaveBeenCalled();
    pending.resolve({ response_id: 'reply-a' }); await flushPromises();
  });

  it('blocks continue for failed or unfinished uploads and exposes each photo recovery action', async () => {
    initial = snapshot({ attachments: [{ id: 'failed-photo', name: '照片.jpg', state: 'failed', error: '上传失败' }] });
    const wrapper = render(); await flushPromises();
    expect(button(wrapper, '继续聊').attributes('disabled')).toBeDefined();
    await button(wrapper, '继续聊').trigger('click');
    expect(controller.submit).not.toHaveBeenCalled();
    await button(wrapper, '重试').trigger('click');
    expect(controller.retryUpload).toHaveBeenCalledWith('failed-photo');
    await button(wrapper, '移除').trigger('click');
    expect(controller.removePhoto).toHaveBeenCalledWith('failed-photo');
    emit({ attachments: [{ id: 'uploading-photo', state: 'uploading', name: '照片.jpg' }] }); await nextTick();
    expect(button(wrapper, '继续聊').attributes('disabled')).toBeDefined();
  });

  it('retries pending material with explicit auto-resume, and resumes directly when there is no material', async () => {
    initial = snapshot({ pendingInput: { requestId: 'retained-request', text: '', mediaIds: ['photo-1'] }, errorStage: 'input', notice: '回复尚未确认' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('input[type="file"]').attributes('disabled')).toBeDefined();
    await button(wrapper, '重试，继续聊').trigger('click'); await flushPromises();
    expect(controller.retryInput).toHaveBeenCalledExactlyOnceWith({ autoResume: true });
    expect(controller.submit).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
    emit({ pendingInput: null, errorStage: '', notice: '' }); await nextTick();
    await button(wrapper, '继续聊').trigger('click');
    expect(controller.resume).toHaveBeenCalledOnce();
  });

  it('allows pause to cancel an in-flight photo reply even while the exclusive continue action is busy', async () => {
    initial = snapshot({ attachments: [{ id: 'photo-1', mediaId: 'media-1', state: 'uploaded' }] });
    const wrapper = render(); await flushPromises();
    const pending = deferred();
    controller.submit.mockImplementation(() => { emit({ phase: 'generating', busy: true }); return pending.promise; });
    await button(wrapper, '继续聊').trigger('click');
    await wrapper.get('[aria-label="暂停访谈"]').trigger('click');
    expect(controller.pause).toHaveBeenCalledOnce();
    pending.resolve(null); await flushPromises();
  });

  it('finishing an empty new page returns home without creating a session or submitting photos', async () => {
    initial = snapshot({ sessionId: '' });
    const wrapper = render(); await flushPromises();
    await button(wrapper, '不聊了').trigger('click');
    expect(navigate).toHaveBeenCalledWith('./index.html');
    expect(controller.finish).not.toHaveBeenCalled();
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it('keeps an uncertain finish retryable without reconnecting voice or resubmitting materials', async () => {
    initial = snapshot({ phase: 'error', errorStage: 'finish', notice: '结束结果尚未确认，请重试结束。',
      finishPending: true, canStart: false, canRetryCall: false, canFinish: true });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('结束结果尚未确认');
    expect(button(wrapper, '继续聊').attributes('disabled')).toBeDefined();
    expect(button(wrapper, '重试结束').attributes('disabled')).toBeUndefined();
    await button(wrapper, '重试结束').trigger('click');
    expect(controller.finish).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });
});

describe('live AI caption priority', () => {
  it.each(['connecting', 'connected'])('shows all received paragraphs and revises the current paragraph while %s', async connectionState => {
    const first = segment('00:00:01', '第一小段，先慢慢聊。');
    const second = segment('00:00:04', '第二小段');
    initial = snapshot({ phase: connectionState, connectionState, agentState: 3,
      caption: first.text + '\n\n' + second.text, captionSpeaker: 'assistant', captionRoundId: 'round-a',
      captionSegments: [first, second] });
    const wrapper = render(); await flushPromises();
    const paragraphs = () => wrapper.findAll('.voice-caption > p').map(node => node.text());
    expect(paragraphs()).toEqual([first.text, second.text]);
    expect(wrapper.get('.voice-caption').attributes('aria-live')).toBe('polite');
    expect(wrapper.get('.voice-caption').attributes('aria-atomic')).toBe('false');
    const originalFirst = wrapper.findAll('.voice-caption > p')[0].element;
    const third = segment('00:00:07', '第三小段', false);
    emit({ caption: [first, second, third].map(item => item.text).join('\n\n'), captionSegments: [first, second, third] });
    await nextTick();
    expect(paragraphs()).toEqual([first.text, second.text, third.text]);
    const originalThird = wrapper.findAll('.voice-caption > p')[2].element;
    const revised = { ...third, text: '第三小段已经说完整。', complete: true };
    emit({ caption: [first, second, revised].map(item => item.text).join('\n\n'), captionSegments: [first, second, revised], agentState: 5 });
    await nextTick();
    expect(paragraphs()).toEqual([first.text, second.text, revised.text]);
    expect(wrapper.findAll('.voice-caption > p')[0].element).toBe(originalFirst);
    expect(wrapper.findAll('.voice-caption > p')[2].element).toBe(originalThird);
    expect(initial.connectionState).toBe(connectionState);
    expect(controller.start).not.toHaveBeenCalled(); expect(controller.resume).not.toHaveBeenCalled(); expect(controller.pause).not.toHaveBeenCalled();
  });

  it('clears accumulated paragraphs on interruption and starts the next reply with only its own paragraphs', async () => {
    initial = snapshot({ phase: 'connected', caption: '旧的第一段。\n\n旧的第二段。', captionSpeaker: 'assistant', captionRoundId: 'round-a',
      captionSegments: [segment('00:00:01', '旧的第一段。'), segment('00:00:04', '旧的第二段。')], agentState: 3 });
    const wrapper = render(); await flushPromises();
    expect(wrapper.findAll('.voice-caption > p')).toHaveLength(2);
    emit({ caption: '', captionSegments: [], captionSpeaker: '', captionRoundId: '', agentState: 4 }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('小暖正在听您讲话');
    expect(wrapper.text()).not.toContain('旧的');
    const current = segment('00:00:01', '新一轮的第一段。');
    emit({ caption: current.text, captionSegments: [current], captionSpeaker: 'assistant', captionRoundId: 'round-b', agentState: 3 }); await nextTick();
    expect(wrapper.findAll('.voice-caption > p').map(node => node.text())).toEqual([current.text]);
  });

  it.each(['finishing', 'finished'])('hides every subtitle paragraph while %s even before a late clear snapshot', async phase => {
    initial = snapshot({ phase: 'connected', caption: '第一段。\n\n第二段。', captionSpeaker: 'assistant',
      captionSegments: [segment('00:00:01', '第一段。'), segment('00:00:04', '第二段。')] });
    const wrapper = render(); await flushPromises();
    expect(wrapper.findAll('.voice-caption > p')).toHaveLength(2);
    emit({ phase }); await nextTick();
    expect(wrapper.find('.voice-caption').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('第一段。'); expect(wrapper.text()).not.toContain('第二段。');
  });

  it.each([
    ['GENERAL', 'connecting', 'loading', false],
    ['GENERAL', 'connected', 'connected', true],
    ['PHOTO', 'connecting', 'generating', true],
    ['PHOTO', 'connected', 'connected', true],
  ])('shows the current %s sentence while %s without changing call state or hiding it behind %s progress', async (entry, connectionState, phase, saving) => {
    initial = snapshot({ entry, connectionState, phase, saving, agentState: 2, muted: true,
      caption: '欢迎，我们从您刚才想起的那件事聊起。', captionSpeaker: 'assistant' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.find('[aria-label="准备图片语音访谈"]').exists()).toBe(false);
    expect(wrapper.get('.voice-caption').text()).toBe('欢迎，我们从您刚才想起的那件事聊起。');
    expect(wrapper.get('.voice-ring').classes()).toContain(connectionState === 'connecting' ? 'is-connecting' : 'is-thinking');
    emit({ agentState: 1 }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe('欢迎，我们从您刚才想起的那件事聊起。');
    expect(initial.connectionState).toBe(connectionState); expect(initial.muted).toBe(true);
    expect(controller.start).not.toHaveBeenCalled(); expect(controller.resume).not.toHaveBeenCalled(); expect(controller.pause).not.toHaveBeenCalled();
  });

  it.each(['connecting', 'connected'])('shows the speaking placeholder without inventing words while %s', async connectionState => {
    initial = snapshot({ phase: connectionState === 'connecting' ? 'loading' : 'connected', connectionState, saving: true, agentState: 3, caption: '  ', captionSpeaker: 'assistant' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.voice-caption').text()).toBe('小暖正在说话…');
    expect(wrapper.text()).not.toContain(initial.opening); expect(wrapper.text()).not.toContain(initial.question);
  });

  it.each(['user', '', 'unknown'])('never displays a %s caption as the AI sentence', async captionSpeaker => {
    initial = snapshot({ phase: 'connected', agentState: 1, caption: '用户刚才说出的私人内容。', captionSpeaker,
      captionSegments: [segment('00:00:01', '用户刚才说出的私人内容。')] });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.voice-caption').text()).toBe('小暖正在听您讲话');
    expect(wrapper.text()).not.toContain('用户刚才说出的私人内容。');
  });

  it.each([['paused', '已暂停，可以继续聊或补充照片。'], ['failed', '暂时没有接通小暖']])('hides old and late AI captions when the call becomes %s', async (connectionState, expected) => {
    initial = snapshot({ phase: 'connected', caption: '通话中的当前字幕。', captionSpeaker: 'assistant', agentState: 3,
      captionSegments: [segment('00:00:01', '通话中的当前字幕。')] });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.voice-caption').text()).toBe('通话中的当前字幕。');
    emit({ phase: connectionState === 'failed' ? 'error' : 'paused', connectionState }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe(expected);
    emit({ caption: '暂停或失败之后迟到的字幕。', captionSegments: [segment('00:00:04', '暂停或失败之后迟到的字幕。')] }); await nextTick();
    expect(wrapper.get('.voice-caption').text()).toBe(expected);
    expect(wrapper.text()).not.toContain('暂停或失败之后迟到的字幕。');
    expect(controller.start).not.toHaveBeenCalled(); expect(controller.resume).not.toHaveBeenCalled();
  });
});

describe('entry compatibility and voice-start rules', () => {
  it.each([
    ['new voice', '?new=1', 'navigate', '', false, 'GENERAL', true],
    ['reload', '?new=1', 'reload', '', false, 'GENERAL', false],
    ['browser history', '?new=1', 'back_forward', '', false, 'GENERAL', false],
    ['restored local session', '?new=1', 'navigate', 'saved-session', false, 'GENERAL', false],
    ['session URL', '?new=1&session_id=saved-session', 'navigate', '', false, 'GENERAL', false],
    ['ordinary entry', '', 'navigate', '', false, 'GENERAL', false],
    ['text entry', '?new=1&interaction=text', 'navigate', '', false, 'GENERAL', false],
    ['photo entry', '?new=1&entry=PHOTO', 'navigate', '', false, 'PHOTO', false],
    ['hidden document', '?new=1', 'navigate', '', true, 'GENERAL', false],
  ])('%s starts only when this is a visible fresh voice navigation', async (_, query, navigation, sessionId, hidden, entry, shouldStart) => {
    initial = snapshot({ sessionId, entry });
    performance.getEntriesByType.mockReturnValue([{ type: navigation }]);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
    render(query); await flushPromises();
    expect(controller.start).toHaveBeenCalledTimes(shouldStart ? 1 : 0);
    expect(controller.resume).not.toHaveBeenCalled();
    expect(createInterviewController).toHaveBeenCalledOnce();
    const rtcOptions = { onCaption: vi.fn() };
    handlers.createRtc(rtcOptions);
    expect(createRtc).toHaveBeenCalledExactlyOnceWith({ ...rtcOptions, captionDebug: false, acquireMicrophone: expect.any(Function), onLevel: expect.any(Function) });
    expect(handlers.checkEnvironment).toBe(checkEnvironment);
    await handlers.preflightMicrophone(); expect(preflightMicrophone).toHaveBeenCalledOnce();
    expect(handlers.storage).toBe(window.sessionStorage);
  });

  it.each([['1', true], ['0', false], ['true', false]])('enables caption diagnostics only for caption_debug=%s', async (value, enabled) => {
    render('?caption_debug=' + value); await flushPromises();
    const rtcOptions = { onCaption: vi.fn(), onCaptionClear: vi.fn(), onAgentState: vi.fn() };
    handlers.createRtc(rtcOptions);
    expect(createRtc).toHaveBeenCalledExactlyOnceWith({ ...rtcOptions, captionDebug: enabled, acquireMicrophone: expect.any(Function), onLevel: expect.any(Function) });
  });

  it('preserves the text entry, submits without auto-resume, and keeps one controller when changing to voice', async () => {
    const wrapper = render('?interaction=text&session_id=saved-session'); await flushPromises();
    expect(controller.initialize).toHaveBeenCalledWith({ sessionId: 'saved-session', entry: 'GENERAL', fresh: false, interaction: 'text' });
    expect(wrapper.text()).toContain('文字讲述');
    expect(wrapper.find('.voice-page').exists()).toBe(false);
    await wrapper.get('textarea').setValue('小时候住在河边。');
    await button(wrapper, '发送').trigger('click'); await flushPromises();
    expect(controller.submit).toHaveBeenCalledExactlyOnceWith({ text: '小时候住在河边。', autoResume: false });
    expect(wrapper.get('textarea').element.value).toBe('');
    await button(wrapper, '改用语音').trigger('click');
    expect(wrapper.find('.voice-page').exists()).toBe(true);
    expect(location.search).toBe('?session_id=saved-session');
    expect(createInterviewController).toHaveBeenCalledOnce();
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
  });

  it('preserves pending text when retrying it and never authorizes automatic voice', async () => {
    initial = snapshot({ pendingInput: { requestId: 'old-request', text: '没确认的那段回忆', mediaIds: [] } });
    const wrapper = render('?interaction=text'); await flushPromises();
    expect(wrapper.get('textarea').element.value).toBe('没确认的那段回忆');
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
    await button(wrapper, '重试这条回复').trigger('click');
    expect(controller.retryInput).toHaveBeenCalledExactlyOnceWith({ autoResume: false });
    expect(controller.submit).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    emit({ pendingInput: null, turns: [{ sequence_no: 1, user_text: '没确认的那段回忆', assistant_text: '确认保存后的回答。', response_state: 'GENERATED' }] });
    await nextTick();
    expect(wrapper.get('textarea').element.value).toBe('');
    expect(wrapper.get('textarea').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('.chat-messages').text()).toContain('没确认的那段回忆');
    expect(wrapper.get('.chat-messages').text()).toContain('确认保存后的回答。');
  });

  it('keeps initial PHOTO preparation separate and starts only after explicit upload-and-continue', async () => {
    initial = snapshot({ entry: 'PHOTO', turns: [], attachments: [{ id: 'photo-1', mediaId: 'media-1', state: 'uploaded' }] });
    const wrapper = render('?new=1&entry=PHOTO'); await flushPromises();
    expect(wrapper.find('.voice-page').exists()).toBe(false);
    expect(wrapper.text()).toContain('图片访谈');
    expect(controller.start).not.toHaveBeenCalled();
    await button(wrapper, '开始图片语音访谈').trigger('click');
    expect(controller.submit).toHaveBeenCalledExactlyOnceWith({ text: '', autoResume: true });
  });

  it.each(['upload', 'input'])('allows ending after the first PHOTO %s failure without submitting the failed photo again', async stage => {
    initial = snapshot({ entry: 'PHOTO', turns: [], phase: 'paused', errorStage: stage, notice: '这张照片暂时没有处理完成。',
      pendingInput: stage === 'input' ? { requestId: 'first-photo-input', text: '', mediaIds: ['first-photo'] } : null,
      attachments: [{ id: 'first-photo', mediaId: stage === 'input' ? 'first-photo' : '', state: stage === 'input' ? 'uploaded' : 'failed', error: stage === 'upload' ? '上传失败' : '' }],
    });
    const wrapper = render('?new=1&entry=PHOTO'); await flushPromises();
    expect(wrapper.text()).toContain('图片访谈');
    expect(button(wrapper, '不聊了').attributes('disabled')).toBeUndefined();
    await button(wrapper, '不聊了').trigger('click');
    expect(controller.finish).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
    expect(controller.retryInput).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });
});

describe('interview page lifecycle', () => {
  it('delegates hide/show and account changes to the controller without opening audio on return', async () => {
    initial = snapshot({ phase: 'connected', caption: '私人的字幕。', captionSpeaker: 'assistant', agentState: 3,
      captionSegments: [segment('00:00:01', '私人的字幕。')] });
    const wrapper = render('?session_id=session-a'); await flushPromises();
    await visibility(true);
    expect(controller.setVisible).toHaveBeenCalledWith(false);
    expect(wrapper.text()).not.toContain('私人的字幕。');
    await visibility(false);
    expect(controller.setVisible).toHaveBeenCalledWith(true);
    expect(controller.resume).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('manji:auth-changed')); await nextTick();
    expect(controller.authChanged).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Finterview.html%3Fsession_id%3Dsession-a', { replace: true });
    expect(wrapper.text()).not.toContain('私人的字幕。');
  });

  it('destroys on page exit once and ignores late state, session, and initialization events', async () => {
    const initializing = deferred();
    const originalFactory = createInterviewController.getMockImplementation();
    createInterviewController.mockImplementation(options => {
      const instance = originalFactory(options);
      instance.initialize.mockReturnValue(initializing.promise);
      return instance;
    });
    initial = snapshot({ sessionId: '' });
    const wrapper = render('?new=1'); await nextTick();
    window.dispatchEvent(new Event('pagehide')); await nextTick();
    expect(controller.setVisible).toHaveBeenCalledWith(false);
    expect(controller.destroy).toHaveBeenCalledOnce();
    handlers.onChange(snapshot({ phase: 'connected', caption: '页面退出后的旧字幕', captionSpeaker: 'assistant' }));
    handlers.onSession('late-session'); initializing.resolve(initial);
    await flushPromises();
    expect(wrapper.text()).not.toContain('页面退出后的旧字幕');
    expect(location.search).toBe('?new=1');
    expect(appState.setActiveSessionId).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(controller.destroy).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('manji:auth-changed'));
    expect(controller.authChanged).not.toHaveBeenCalled();
  });

  it('unmount removes observers, while successful session and organization callbacks update shared navigation state', async () => {
    const wrapper = render('?new=1&interaction=text'); await flushPromises();
    handlers.onSession('saved-session');
    expect(appState.setActiveSessionId).toHaveBeenCalledWith('saved-session');
    expect(location.search).toBe('?interaction=text&session_id=saved-session');
    emit({ phase: 'finishing', sessionId: 'saved-session' }); await nextTick();
    expect(appState.setOrganizationSessionId).toHaveBeenCalledWith('saved-session');
    expect(appState.removeActiveSessionId).toHaveBeenCalledWith('saved-session');
    expect(wrapper.get('a[href*="organizing.html"]').attributes('href')).toBe('./organizing.html?session_id=saved-session');
    wrapper.unmount(); expect(controller.destroy).toHaveBeenCalledOnce();
    const visibilityCalls = controller.setVisible.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('manji:auth-changed'));
    expect(controller.setVisible).toHaveBeenCalledTimes(visibilityCalls);
    expect(controller.authChanged).not.toHaveBeenCalled();
  });

  it('reloads a persisted browser page rather than reusing a destroyed microphone controller', async () => {
    render(); await flushPromises();
    const event = new Event('pageshow'); Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(controller.start).not.toHaveBeenCalled();
  });
});

describe('separate voice and photo entries', () => {
  it('shows idle as ready to start instead of pretending the microphone was paused', async () => {
    initial = snapshot({ connectionState: 'idle' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.text()).not.toContain('现在已暂停');
    expect(wrapper.text()).not.toContain('小暖正在听您讲话');
    expect(button(wrapper, '传张照片')).toBeUndefined();
    await button(wrapper, '开始通话').trigger('click');
    expect(controller.resume).toHaveBeenCalledOnce();
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it('shows the real connection error and reconnects once despite repeated clicks', async () => {
    initial = snapshot({ phase: 'error', connectionState: 'failed', connectionError: { code: 'RTC_JOIN_FAILED', message: '暂时无法连接语音服务，请重试。' }, errorStage: 'call', canRetryCall: true });
    const wrapper = render(); await flushPromises();
    expect(wrapper.text()).not.toContain('现在已暂停');
    expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法连接语音服务');
    const pending = deferred(); controller.resume.mockReturnValueOnce(pending.promise);
    const retry = button(wrapper, '重新连接');
    retry.element.dispatchEvent(new MouseEvent('click')); retry.element.dispatchEvent(new MouseEvent('click'));
    await nextTick();
    expect(controller.resume).toHaveBeenCalledOnce(); expect(retry.attributes('disabled')).toBeDefined();
    expect(controller.submit).not.toHaveBeenCalled();
    pending.resolve(); await flushPromises();
  });

  it('retries initialization then connects in the same user action', async () => {
    initial = snapshot({ initialized: false, phase: 'error', connectionState: 'failed', errorStage: 'initialize', notice: '访谈暂时没有打开。' });
    const wrapper = render(); await flushPromises();
    controller.initialize.mockImplementationOnce(async () => { emit({ initialized: true, phase: 'paused', connectionState: 'idle', errorStage: '' }); });
    await button(wrapper, '重新连接').trigger('click'); await flushPromises();
    expect(controller.initialize).toHaveBeenCalledTimes(2);
    expect(controller.resume).toHaveBeenCalledOnce();
  });

  it.each([
    ['generating', false, '小暖正在看照片…'],
    ['pausing', false, '正在暂停通话…'],
    ['paused', true, '正在暂停通话…'],
  ])('gives %s business progress priority over the connection label', async (phase, saving, expected) => {
    initial = snapshot({ phase, saving, connectionState: 'paused' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.voice-caption').text()).toBe(expected);
    expect(wrapper.get('[aria-label="暂停后的操作"]').findAll('button').map(node => node.text())).toEqual(['继续聊', '传张照片', '结束并整理', '下次聊']);
  });

  it('keeps paused voice actions without switching modes while stopped-call material is checked in the background', async () => {
    initial = snapshot({ phase: 'paused', connectionState: 'paused', isGuest: true,
      transportClosed: true, saving: true, materialState: 'WAITING_CALLBACK' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.voice-caption').text()).toBe('已暂停，可以继续聊或补充照片。');
    expect(wrapper.text()).not.toContain('正在保存');
    for (const label of ['继续聊', '传张照片']) expect(button(wrapper, label).attributes('disabled')).toBeUndefined();
    expect(button(wrapper, '改用文字讲述')).toBeUndefined();
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(controller.resume).not.toHaveBeenCalled();
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it.each(['restoredSession', 'restoredDraft'])('does not auto-start a restored %s even without a resolved session ID', async flag => {
    initial = snapshot({ sessionId: '', connectionState: 'idle', [flag]: true });
    render('?new=1&entry=GENERAL'); await flushPromises();
    expect(controller.start).not.toHaveBeenCalled(); expect(controller.resume).not.toHaveBeenCalled();
  });

  it('keeps initial PHOTO free of text fields and blocks starting until every selected photo is uploaded', async () => {
    initial = snapshot({ entry: 'PHOTO', connectionState: 'idle' });
    const wrapper = render('?new=1&entry=PHOTO'); await flushPromises();
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.get('input[type="file"]').attributes()).toHaveProperty('multiple');
    expect(button(wrapper, '开始图片语音访谈').attributes('disabled')).toBeDefined();
    emit({ attachments: [{ id: 'first', mediaId: 'first', state: 'uploaded' }, { id: 'second', state: 'failed', error: '上传失败' }] }); await nextTick();
    expect(button(wrapper, '开始图片语音访谈').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('上传失败');
    emit({ attachments: [{ id: 'first', mediaId: 'first', state: 'uploaded' }, { id: 'second', state: 'uploading' }] }); await nextTick();
    expect(button(wrapper, '开始图片语音访谈').attributes('disabled')).toBeDefined();
    expect(controller.submit).not.toHaveBeenCalled(); expect(controller.start).not.toHaveBeenCalled();
  });

  it('submits multiple initial photos once and explicitly authorizes voice without sending draft text', async () => {
    initial = snapshot({ entry: 'PHOTO', connectionState: 'idle', attachments: ['first', 'second'].map(id => ({ id, mediaId: id, state: 'uploaded' })) });
    const wrapper = render('?new=1&entry=PHOTO'); await flushPromises();
    expect(wrapper.findAll('.material-photo')).toHaveLength(2);
    const pending = deferred(); controller.submit.mockReturnValueOnce(pending.promise);
    const start = button(wrapper, '开始图片语音访谈');
    start.element.dispatchEvent(new MouseEvent('click')); start.element.dispatchEvent(new MouseEvent('click')); await nextTick();
    expect(controller.submit).toHaveBeenCalledExactlyOnceWith({ text: '', autoResume: true });
    expect(start.attributes('disabled')).toBeDefined();
    pending.resolve({ response_id: 'photo-reply' }); await flushPromises();
  });

  it('retries retained initial PHOTO media when the attachment list was already cleared', async () => {
    initial = snapshot({ entry: 'PHOTO', pendingInput: { requestId: 'saved-input', mediaIds: ['saved-photo'] }, attachments: [], errorStage: 'input', notice: '回复尚未确认。' });
    const wrapper = render('?entry=PHOTO'); await flushPromises();
    const retry = button(wrapper, '重试并开始图片语音访谈');
    expect(retry.attributes('disabled')).toBeUndefined();
    await retry.trigger('click');
    expect(controller.retryInput).toHaveBeenCalledExactlyOnceWith({ autoResume: true });
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it('does not treat failed photo history or a text-only pending input as a voice-ready PHOTO session', async () => {
    initial = snapshot({ entry: 'PHOTO', turns: [{ response_state: 'FAILED', media_ids: ['saved-photo'], assistant_text: '' }], pendingInput: { requestId: 'missing-photo', mediaIds: [] } });
    const wrapper = render('?entry=PHOTO'); await flushPromises();
    expect(wrapper.find('[aria-label="准备图片语音访谈"]').exists()).toBe(true);
    expect(button(wrapper, '重试并开始图片语音访谈').attributes('disabled')).toBeDefined();
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(controller.resume).not.toHaveBeenCalled(); expect(controller.retryInput).not.toHaveBeenCalled();
  });

  it('reconnects answered PHOTO audio without creating another photo reply', async () => {
    initial = snapshot({ entry: 'PHOTO', phase: 'error', connectionState: 'failed', connectionError: { code: 'RTC_JOIN_FAILED', message: '连接失败' }, canRetryCall: true,
      turns: [{ response_state: 'GENERATED', media_ids: ['saved-photo'], assistant_text: '照片里是什么地方？' }] });
    const wrapper = render('?entry=PHOTO'); await flushPromises();
    expect(wrapper.find('[aria-label="准备图片语音访谈"]').exists()).toBe(false);
    await button(wrapper, '重新连接').trigger('click');
    expect(controller.resume).toHaveBeenCalledOnce(); expect(controller.submit).not.toHaveBeenCalled(); expect(controller.retryInput).not.toHaveBeenCalled();
  });
});

describe('photo preview resource ownership inside the interview', () => {
  it('releases loaded image URLs while hidden and on unmount, and recreates them only on return', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:photo-before-hide').mockReturnValueOnce('blob:photo-after-show');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    initial = snapshot({ attachments: [{ id: 'photo', mediaId: 'private-photo', state: 'uploaded' }] });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.material-photo img').attributes('src')).toBe('blob:photo-before-hide');
    await visibility(true);
    expect(revoke).toHaveBeenCalledWith('blob:photo-before-hide'); expect(wrapper.find('.material-photo img').exists()).toBe(false);
    await visibility(false); await flushPromises();
    expect(create).toHaveBeenCalledTimes(2); expect(wrapper.get('.material-photo img').attributes('src')).toBe('blob:photo-after-show');
    wrapper.unmount(); expect(revoke).toHaveBeenCalledWith('blob:photo-after-show');
    expect(controller.destroy).toHaveBeenCalledOnce();
  });

  it('discards a photo fetch that finishes after the interview was unmounted', async () => {
    const pending = deferred(); api.getPhotoBlob.mockReturnValueOnce(pending.promise);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-photo');
    initial = snapshot({ attachments: [{ id: 'photo', mediaId: 'private-photo', state: 'uploaded' }] });
    const wrapper = render(); await flushPromises();
    expect(api.getPhotoBlob).toHaveBeenCalledWith('private-photo');
    wrapper.unmount(); pending.resolve(new Blob(['private image'])); await flushPromises();
    expect(create).not.toHaveBeenCalled(); expect(controller.destroy).toHaveBeenCalledOnce();
  });

  it('closes an open private-photo preview and releases its URL when the account changes', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-account-photo');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    initial = snapshot({ attachments: [{ id: 'photo', mediaId: 'private-photo', state: 'uploaded' }] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('.material-photo').trigger('click'); await flushPromises();
    const dialog = document.querySelector('dialog'); expect(dialog.open).toBe(true);
    window.dispatchEvent(new Event('manji:auth-changed')); await nextTick();
    expect(dialog.open).toBe(false); expect(document.querySelector('dialog')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:private-account-photo'); expect(wrapper.find('.material-photo').exists()).toBe(false);
  });
});
