import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ConnectedInterviewPage from '../src/pages/ConnectedInterviewPage.vue';
import * as api from '../src/lib/workflow-api.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/workflow-api.js', async importOriginal => ({
  ...await importOriginal(),
  ensureIdentity: vi.fn(), getCatalog: vi.fn(), getStory: vi.fn(), startInterview: vi.fn(),
  getInterview: vi.fn(), submitText: vi.fn(), retryInterview: vi.fn(), finishInterview: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

const topic = { id: '12', chapter_id: '3', title: '学过的一门手艺', description: '学手艺时的尝试，以及记得的人和事。' };
const opening = { id: 1, role: 'assistant', content: '您刚才选的这门手艺，是怎么开始学的？', image_ids: [] };
const answer = { id: 2, role: 'user', content: '那年我跟着师傅学木工。', image_ids: [] };
const reply = { id: 3, role: 'assistant', content: '您说起师傅时，想起的是哪件事？', image_ids: [] };
const session = (messages = [opening], extra = {}) => ({ session_id: '41', status: 'awaiting_first_input',
  messages, selected_topic: topic, resume_mode: 'text', save_pending: false, next_node: null, ...extra });
const globalOpening = { ...opening, content: '最近有没有想起来的一段往事？' };
const globalSession = (messages = [globalOpening], extra = {}) => session(messages, { selected_topic: null, interview_scope: 'global', ...extra });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function open(search = '?topic_id=12&chapter_id=3') {
  const params = new URLSearchParams(search); params.set('interaction', 'text');
  history.replaceState(null, '', '/web/interview.html?' + params); return mount(ConnectedInterviewPage);
}
async function resume(page) { await flushPromises(); await page.get('[data-testid="start-text-interview"]').trigger('click'); await flushPromises(); }
let hidden;
beforeEach(() => {
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  sessionStorage.setItem('manji.auth_token', 'owner-a');
  api.ensureIdentity.mockResolvedValue({ user_id: '7', is_guest: false });
  api.getCatalog.mockResolvedValue({ chapters: [{ id: '3', title: '青年生活', topics: [topic] }] });
  api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', selected_topic: topic, active_supplement: null });
  api.getInterview.mockResolvedValue(session());
  api.startInterview.mockResolvedValue({ session_id: '41', status: 'awaiting_first_input', opening_text: opening.content });
  api.retryInterview.mockResolvedValue({ session_id: '41', status: 'interview_replied', assistant_text: reply.content });
  api.submitText.mockResolvedValue({ session_id: '41', status: 'interview_replied', assistant_text: reply.content });
});

describe('connected story supplementation', () => {
  it('shows the target story and only starts a bound supplement after an explicit click', async () => {
    api.getInterview.mockResolvedValue(session([opening], { target_story_id: '81' }));
    const page = open('?topic_id=12&chapter_id=3&story_id=81'); await flushPromises();
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(false);
    expect(page.get('[data-testid="supplement-target"]').text()).toContain('补充《木工师傅》');
    expect(page.get('.prototype-interview-back').attributes('href')).toBe('./story.html?story_id=81');
    expect(page.get('[data-testid="start-text-interview"]').text()).toBe('文字讲述');
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.getCatalog).not.toHaveBeenCalled();
    await page.get('[data-testid="start-text-interview"]').trigger('click'); await flushPromises();
    expect(api.startInterview).toHaveBeenCalledExactlyOnceWith('12', { resumeMode: 'text', targetStoryId: '81' });
    expect(new URLSearchParams(location.search).get('story_id')).toBe('81');
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
  });

  it('resumes the existing supplement with its draft when returning from the story', async () => {
    api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', selected_topic: topic,
      active_supplement: { session_id: '41', status: 'in_progress' } });
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'interview_replied', target_story_id: '81' }));
    sessionStorage.setItem('manji.connected.draft.41', JSON.stringify({ owner: 'owner-a', text: '后来还发生了一件事。' }));
    const page = open('?topic_id=12&story_id=81'); await flushPromises();
    expect(page.get('textarea').element.value).toBe('后来还发生了一件事。');
    expect(page.get('textarea').element.disabled).toBe(true);
    expect(page.get('[data-testid="start-text-interview"]').text()).toBe('文字讲述');
    await page.get('[data-testid="start-text-interview"]').trigger('click'); await flushPromises();
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(page.get('textarea').element.disabled).toBe(false);
  });

  it('restores the target from the server snapshot even when the URL only has a session ID', async () => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'interview_replied', target_story_id: '81' }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.get('.prototype-interview-back').attributes('href')).toBe('./story.html?story_id=81');
    expect(page.get('[data-testid="supplement-target"]').text()).toContain('木工师傅');
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./organizing.html?session_id=41&story_id=81');
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('preserves the target and failed opening session on retry', async () => {
    api.startInterview.mockRejectedValueOnce(Object.assign(new Error('首问生成失败'), { sessionId: '41' }));
    api.getInterview.mockResolvedValue(session([opening], { target_story_id: '81' }));
    const page = open('?topic_id=12&story_id=81'); await resume(page);
    expect(location.search).toContain('story_id=81');
    expect(location.search).toContain('session_id=41');
    await page.get('[data-testid="retry-reply"]').trigger('click'); await flushPromises();
    expect(api.retryInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(api.startInterview).toHaveBeenCalledTimes(1);
  });

  it('rejects a session belonging to a different target story', async () => {
    api.getInterview.mockResolvedValue(session([opening], { target_story_id: '82' }));
    const page = open('?session_id=41&story_id=81'); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('不一致');
    expect(page.find('textarea').exists()).toBe(false);
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('does not create a new identity to supplement an existing story', async () => {
    sessionStorage.removeItem('manji.auth_token');
    const page = open('?topic_id=12&story_id=81'); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('登录原来的账号');
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.getStory).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('routes pending post-processing back to organization before starting a supplement', async () => {
    api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', selected_topic: topic,
      pending_processing: { session_id: '40' } });
    const page = open('?topic_id=12&story_id=81'); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./organizing.html?session_id=40&story_id=81');
    expect(api.startInterview).not.toHaveBeenCalled();
    page.unmount();
  });

  it.each(['writing_pending', 'revision_conflict', 'completed'])('shows only the result path for a supplement in %s', async status => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status, target_story_id: '81', story_id: status === 'completed' ? '81' : undefined }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.find('textarea').exists()).toBe(false);
    expect(page.find('[data-testid="start-text-interview"]').exists()).toBe(false);
    expect(page.find('[data-testid="start-voice-interview"]').exists()).toBe(false);
    expect(page.get('[data-testid="interview-result"]').attributes('href')).toBe(status === 'completed'
      ? './story.html?story_id=81&session_id=41' : './organizing.html?session_id=41&story_id=81');
  });
});

describe('connected text interview', () => {
  it.each([
    ['awaiting_first_input', null], ['interview_replied', null],
    ['reply_pending', 'interview'], ['writing_pending', 'writing'],
  ])('keeps a legacy topicless %s session and its draft read-only', async (status, nextNode) => {
    sessionStorage.setItem('manji.connected.draft.41', JSON.stringify({ owner: 'owner-a', text: '尚未提交的旧草稿', error: '', pendingInput: null }));
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status, next_node: nextNode, selected_topic: null }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
    expect(page.get('textarea').element.value).toBe('尚未提交的旧草稿');
    expect(page.get('textarea').element.readOnly).toBe(true);
    expect(page.get('textarea').element.disabled).toBe(false);
    expect(page.get('[data-testid="legacy-select-topic"]').attributes('href')).toBe('./index.html');
    for (const action of ['start-voice-interview', 'start-text-interview', 'send-answer', 'finish-interview', 'retry-reply', 'interview-result']) {
      expect(page.find(`[data-testid="${action}"]`).exists()).toBe(false);
    }
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.submitText).not.toHaveBeenCalled();
    expect(api.retryInterview).not.toHaveBeenCalled();
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it.each(['memory_update', 'summary'])('keeps organization available for a topicless story pending %s', async nextNode => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'writing_pending', next_node: nextNode, selected_topic: null }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.get('[data-testid="interview-result"]').attributes('href')).toBe('./organizing.html?session_id=41');
    expect(page.find('[data-testid="legacy-select-topic"]').exists()).toBe(false);
    expect(page.find('textarea').exists()).toBe(false);
  });

  it('keeps a completed topicless story accessible', async () => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'completed', story_id: '81', selected_topic: null }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.get('[data-testid="interview-result"]').attributes('href')).toBe('./story.html?story_id=81&session_id=41');
    expect(page.find('[data-testid="legacy-select-topic"]').exists()).toBe(false);
  });

  it.each(['', '?chapter_id=3'])('shows the global entrance or disabled chapter choices without starting a session at %s', async search => {
    sessionStorage.removeItem('manji.auth_token');
    const page = open(search); await flushPromises();
    if (search) {
      expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(true);
      expect(page.get('h1').text()).toBe('青年生活');
    } else {
      expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(false);
      expect(page.get('h1').text()).toBe('和小暖聊聊');
      expect(page.get('.prototype-interview-label').text()).toBe('全局访谈');
    }
    expect(document.title).toBe(search ? '慢记 · 青年生活' : '慢记 · 和小暖聊聊');
    expect(page.get('.prototype-interview-back').attributes('href'))
      .toBe(search ? './index.html?chapter_id=3' : './index.html');
    expect(page.find('[data-testid="select-topic"]').exists()).toBe(false);
    expect(page.get('[data-testid="start-text-interview"]').element.disabled).toBe(Boolean(search));
    expect(page.get('[data-testid="start-voice-interview"]').element.disabled).toBe(Boolean(search));
    expect(page.get('[data-testid="start-text-interview"]').text()).toBe(search ? '文字访谈' : '文字讲述');
    expect(page.get('[data-testid="start-voice-interview"]').text()).toBe(search ? '语音访谈' : '语音讲述');
    expect(page.text()).not.toContain(topic.title);
    expect(page.find('textarea').exists()).toBe(false);
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(Boolean(search));
    if (search) expect(api.getCatalog).toHaveBeenCalled();
    else expect(api.getCatalog).not.toHaveBeenCalled();
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('starts a global text interview, exchanges two turns, and restores the same conversation after refresh', async () => {
    api.getInterview.mockResolvedValue(globalSession());
    const page = open(''); await flushPromises();
    expect(api.startInterview).not.toHaveBeenCalled();
    await resume(page);
    expect(api.startInterview).toHaveBeenCalledExactlyOnceWith(undefined, { resumeMode: 'text' });
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
    expect(page.get('h1').text()).toBe('和小暖聊聊');
    expect(page.get('.prototype-interview-label').text()).toBe('全局访谈');
    expect(page.get('textarea').element.readOnly).toBe(false);

    const messages = [globalOpening];
    for (const [text, response] of [
      [answer.content, reply.content],
      ['师傅第一次让我独立做了一张椅子。', '那张椅子做完时，您是什么心情？'],
    ]) {
      await page.get('textarea').setValue(text);
      messages.push({ id: messages.length + 1, role: 'user', content: text },
        { id: messages.length + 2, role: 'assistant', content: response });
      api.getInterview.mockResolvedValue(globalSession([...messages], { status: 'interview_replied' }));
      await page.get('[data-testid="send-answer"]').trigger('click'); await flushPromises();
      expect(api.submitText).toHaveBeenLastCalledWith('41', text);
      expect(page.get('textarea').element.value).toBe('');
      expect(page.text()).toContain(response);
    }
    expect(api.submitText).toHaveBeenCalledTimes(2);
    expect(page.get('[data-testid="finish-interview"]').element.disabled).toBe(false);
    await page.get('textarea').setValue('后来我还做过一张桌子。');
    await page.get('[data-testid="pause-interview"]').trigger('click');
    expect(page.get('textarea').element.disabled).toBe(true);
    page.unmount();

    const restored = open('?session_id=41'); await flushPromises();
    expect(restored.get('h1').text()).toBe('和小暖聊聊');
    expect(document.title).toBe('慢记 · 和小暖聊聊');
    expect(restored.get('.prototype-interview-label').text()).toBe('全局访谈');
    expect(restored.findAll('[data-testid="message"]')).toHaveLength(5);
    expect(restored.get('textarea').element.value).toBe('后来我还做过一张桌子。');
    expect(restored.get('textarea').element.readOnly).toBe(false);
    expect(restored.get('[data-testid="finish-interview"]').element.disabled).toBe(true);
    await resume(restored);
    expect(restored.get('textarea').element.disabled).toBe(false);
    expect(api.startInterview).toHaveBeenCalledTimes(1);
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it('keeps an existing session readable when its older snapshot has no selected topic', async () => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'interview_replied', selected_topic: null }));
    const page = open('?session_id=41'); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
    expect(page.get('h1').text()).toBe('讲述');
    expect(page.find('[data-testid="select-topic"]').exists()).toBe(false);
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it.each([false, true])('reloads the selected topic after the initial catalog read is hidden (return before response: %s)', async returnBeforeResponse => {
    sessionStorage.removeItem('manji.auth_token');
    const pending = deferred(); api.getCatalog.mockReturnValueOnce(pending.promise);
    const page = open(); await flushPromises();
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    if (returnBeforeResponse) {
      hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
      expect(api.getCatalog).toHaveBeenCalledTimes(1);
    }
    pending.resolve({ chapters: [{ id: '3', title: '旧目录响应', topics: [{ ...topic, title: '过期的话题标题' }] }] });
    await flushPromises();
    if (!returnBeforeResponse) {
      expect(api.getCatalog).toHaveBeenCalledTimes(1);
      hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    }
    expect(api.getCatalog).toHaveBeenCalledTimes(2);
    expect(document.title).toBe(`慢记 · ${topic.title}`);
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(true);
    expect(page.get('h1').text()).toBe(topic.title);
    expect(page.text()).toContain(topic.description);
    expect(page.text()).not.toContain('过期的话题标题');
    expect(page.get('[data-testid="start-text-interview"]').element.disabled).toBe(false);
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('only reads the catalog on arrival and creates exactly once after an explicit start', async () => {
    const pending = deferred(); api.startInterview.mockReturnValue(pending.promise);
    const page = open(); await flushPromises();
    expect(page.get('[data-testid="interview-entry-choice"]').findAll('button').map(button => button.text()))
      .toEqual(['语音访谈', '文字访谈']);
    expect(page.findAll('button')).toHaveLength(2);
    expect(page.get('h1').text()).toBe(topic.title);
    expect(page.text()).toContain(topic.description);
    expect(page.find('textarea').exists()).toBe(false);
    expect(page.find('[data-testid="finish-interview"]').exists()).toBe(false);
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
    const button = page.get('[data-testid="start-text-interview"]').element;
    button.click(); button.click(); await flushPromises();
    expect(api.startInterview).toHaveBeenCalledExactlyOnceWith('12', { resumeMode: 'text' });
    pending.resolve({ session_id: '41', status: 'awaiting_first_input', opening_text: opening.content });
    await flushPromises();
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
    expect(page.get('[data-testid="message"]').text()).toContain(opening.content);
  });

  it('keeps the failed opening session and retries it instead of creating another', async () => {
    api.startInterview.mockRejectedValueOnce(Object.assign(new Error('首问生成失败，请重试'), { sessionId: '41' }));
    const page = open(); await flushPromises();
    await page.get('[data-testid="start-text-interview"]').trigger('click'); await flushPromises();
    expect(location.search).toContain('session_id=41');
    expect(page.get('[role="alert"]').text()).toContain('首问生成失败');
    await page.get('[data-testid="retry-reply"]').trigger('click'); await flushPromises();
    expect(api.retryInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(api.startInterview).toHaveBeenCalledTimes(1);
    expect(page.text()).toContain(opening.content);
  });

  it('renders server history after refresh, retains a draft, and pauses without a server mutation', async () => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'interview_replied' }));
    const page = open('?session_id=41'); await resume(page);
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
    await page.get('textarea').setValue('还有一件事想接着说。');
    await page.get('[data-testid="pause-interview"]').trigger('click');
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(false);
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
    expect(page.get('textarea').element.value).toBe('还有一件事想接着说。');
    expect(page.get('textarea').element.disabled).toBe(true);
    expect(api.submitText).not.toHaveBeenCalled();
    page.unmount();
    const restored = open('?session_id=41'); await flushPromises();
    expect(restored.find('[data-testid="interview-entry-choice"]').exists()).toBe(true);
    expect(restored.find('textarea').exists()).toBe(false);
    expect(restored.find('[data-testid="message"]').exists()).toBe(false);
    expect(restored.find('[data-testid="finish-interview"]').exists()).toBe(false);
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.41')).text).toBe('还有一件事想接着说。');
    await resume(restored);
    expect(restored.get('textarea').element.value).toBe('还有一件事想接着说。');
    expect(restored.get('textarea').element.disabled).toBe(false);
    expect(restored.findAll('[data-testid="message"]')).toHaveLength(3);
    expect(api.startInterview).not.toHaveBeenCalled();
  });

  it('reconciles a timed-out input with saved history and never resends it', async () => {
    const page = open('?session_id=41'); await resume(page);
    await page.get('textarea').setValue(answer.content);
    api.submitText.mockRejectedValueOnce(Object.assign(new Error('请求超时'), { code: 'REQUEST_TIMEOUT' }));
    api.getInterview.mockResolvedValueOnce(session([opening, answer, reply], { status: 'interview_replied' }));
    await page.get('[data-testid="send-answer"]').trigger('click'); await flushPromises();
    expect(api.submitText).toHaveBeenCalledExactlyOnceWith('41', answer.content);
    expect(page.get('textarea').element.value).toBe('');
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
    expect(page.find('[role="alert"]').exists()).toBe(false);
    expect(api.retryInterview).not.toHaveBeenCalled();
  });

  it('retries a saved pending turn without appending the user text again', async () => {
    const page = open('?session_id=41'); await resume(page);
    await page.get('textarea').setValue(answer.content);
    api.submitText.mockRejectedValueOnce(new Error('回复失败'));
    api.getInterview.mockResolvedValueOnce(session([opening, answer], { status: 'reply_pending', next_node: 'interview' }));
    await page.get('[data-testid="send-answer"]').trigger('click'); await flushPromises();
    expect(page.get('textarea').element.value).toBe('');
    api.getInterview.mockResolvedValueOnce(session([opening, answer, reply], { status: 'interview_replied' }));
    await page.get('[data-testid="retry-reply"]').trigger('click'); await flushPromises();
    expect(api.submitText).toHaveBeenCalledTimes(1);
    expect(api.retryInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
  });

  it('shows the safe model-account error after confirming the global answer was saved and retries without resending', async () => {
    api.getInterview.mockResolvedValue(globalSession());
    const page = open('?session_id=41'); await resume(page);
    await page.get('textarea').setValue(answer.content);
    const detail = '模型账户暂不可用，请检查账户状态或余额后重试。';
    api.submitText.mockRejectedValueOnce(Object.assign(new Error(detail), {
      code: 'MODEL_ACCOUNT_UNAVAILABLE', status: 503,
    }));
    api.getInterview.mockResolvedValueOnce(globalSession([globalOpening, answer], {
      status: 'reply_pending', next_node: 'interview',
    }));
    await page.get('[data-testid="send-answer"]').trigger('click'); await flushPromises();
    expect(page.get('[role="alert"]').text()).toBe(`文字已收到并保存。${detail}`);
    expect(page.get('textarea').element.value).toBe('');
    expect(page.findAll('[data-testid="message"]')).toHaveLength(2);

    api.getInterview.mockResolvedValueOnce(globalSession([globalOpening, answer, reply], {
      status: 'interview_replied',
    }));
    await page.get('[data-testid="retry-reply"]').trigger('click'); await flushPromises();
    expect(api.submitText).toHaveBeenCalledExactlyOnceWith('41', answer.content);
    expect(api.retryInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(page.findAll('[data-testid="message"]')).toHaveLength(3);
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('keeps uncertain text and blocks another send until a fresh read succeeds', async () => {
    const page = open('?session_id=41'); await resume(page);
    await page.get('textarea').setValue(answer.content);
    api.submitText.mockRejectedValueOnce(new Error('请求超时'));
    api.getInterview.mockRejectedValueOnce(new Error('暂时无法连接'));
    await page.get('[data-testid="send-answer"]').trigger('click'); await flushPromises();
    expect(page.get('textarea').element.value).toBe(answer.content);
    expect(page.get('[data-testid="send-answer"]').element.disabled).toBe(true);
    expect(page.get('[role="alert"]').text()).toContain('先重新读取记录');
    api.getInterview.mockResolvedValueOnce(session([opening, answer, reply], { status: 'interview_replied' }));
    await page.get('[data-testid="refresh-interview"]').trigger('click'); await flushPromises();
    expect(page.get('textarea').element.value).toBe('');
    expect(api.submitText).toHaveBeenCalledTimes(1);
  });

  it('restores an uncertain input warning and pending input together with the draft', async () => {
    const pendingInput = { text: answer.content, ids: [String(opening.id)] };
    const warning = '尚未确认这段文字已保存，请核对记录后再发送。';
    sessionStorage.setItem('manji.connected.draft.41', JSON.stringify({ owner: 'owner-a',
      text: answer.content, error: warning, pendingInput }));
    const page = open('?session_id=41'); await flushPromises();
    expect(page.find('[data-testid="interview-entry-choice"]').exists()).toBe(true);
    expect(page.find('textarea').exists()).toBe(false);
    expect(page.get('[role="alert"]').text()).toBe(warning);
    const saved = JSON.parse(sessionStorage.getItem('manji.connected.draft.41'));
    expect(saved.text).toBe(answer.content);
    expect(saved.pendingInput).toEqual(pendingInput);
    expect(saved.error).toBe(warning);
    await resume(page);
    expect(page.get('textarea').element.value).toBe(answer.content);
    expect(api.submitText).not.toHaveBeenCalled();
  });

  it('navigates to organizing without sending a finish request from the departing page', async () => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], { status: 'interview_replied' }));
    const page = open('?session_id=41'); await resume(page);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./organizing.html?session_id=41');
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it('only organizes a global interview after the explicit end-and-organize action', async () => {
    api.getInterview.mockResolvedValue(globalSession([globalOpening, answer, reply], { status: 'interview_replied' }));
    const page = open('?session_id=41'); await resume(page);
    await page.get('[data-testid="pause-interview"]').trigger('click');
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow')); await flushPromises();
    expect(api.finishInterview).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./organizing.html?session_id=41');
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it.each(['writing', 'memory_update', 'summary'])('offers only continued organization for an ended session pending %s', async nextNode => {
    api.getInterview.mockResolvedValue(session([opening, answer, reply], {
      status: 'writing_pending', next_node: nextNode, story_id: nextNode === 'writing' ? undefined : '81',
    }));
    const page = open('?session_id=41'); await flushPromises();
    const result = page.get('[data-testid="interview-result"]');
    expect(result.text()).toBe('继续整理');
    expect(result.attributes('href')).toBe('./organizing.html?session_id=41');
    expect(page.find('textarea').exists()).toBe(false);
    expect(page.find('[data-testid="send-answer"]').exists()).toBe(false);
    expect(page.find('[data-testid="start-text-interview"]').exists()).toBe(false);
    expect(page.find('[data-testid="start-voice-interview"]').exists()).toBe(false);
    expect(api.submitText).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it('does not show an old reply after the account changes', async () => {
    const page = open('?session_id=41'); await resume(page);
    const pending = deferred(); api.submitText.mockReturnValueOnce(pending.promise);
    await page.get('textarea').setValue(answer.content);
    await page.get('[data-testid="send-answer"]').trigger('click');
    sessionStorage.setItem('manji.auth_token', 'owner-b'); window.dispatchEvent(new Event('manji:auth-changed'));
    pending.resolve({ session_id: '41', assistant_text: '旧账号的私密内容' }); await flushPromises();
    expect(page.text()).not.toContain(opening.content);
    expect(page.text()).not.toContain('旧账号的私密内容');
    expect(page.find('textarea').exists()).toBe(false);
    expect(page.text()).toContain('登录状态已变化');
  });

  it('does not apply a hidden or unmounted response and requires reconciliation on return', async () => {
    const page = open('?session_id=41'); await resume(page);
    const pending = deferred(); api.submitText.mockReturnValueOnce(pending.promise);
    await page.get('textarea').setValue(answer.content);
    await page.get('[data-testid="send-answer"]').trigger('click');
    const previousReads = api.getInterview.mock.calls.length;
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    pending.resolve({ session_id: '41', assistant_text: '迟到的回复' }); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledTimes(previousReads);
    expect(page.text()).not.toContain('迟到的回复');
    api.getInterview.mockResolvedValueOnce(session([opening, answer, reply], { status: 'interview_replied' }));
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(page.text()).toContain(reply.content);
    expect(page.get('textarea').element.value).toBe('');
    page.unmount();
    window.dispatchEvent(new Event('pageshow')); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledTimes(previousReads + 1);
  });

  it('requires login when starting a new interview without a token', async () => {
    sessionStorage.removeItem('manji.auth_token');
    const page = open(); await flushPromises();
    await page.get('[data-testid="start-text-interview"]').trigger('click'); await flushPromises();
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(page.get('[role="alert"]').text()).toContain('登录原来的账号');
    expect(page.get('a[href*="login.html"]').attributes('href')).toContain('next=');
  });

  it('does not create a guest identity when reopening an existing session without a token', async () => {
    sessionStorage.removeItem('manji.auth_token');
    const page = open('?session_id=41'); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('登录原来的账号');
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.getInterview).not.toHaveBeenCalled();
    expect(api.startInterview).not.toHaveBeenCalled();
    expect(new URLSearchParams(location.search).get('session_id')).toBe('41');
    await page.get('[data-testid="start-text-interview"]').trigger('click'); await flushPromises();
    expect(api.ensureIdentity).not.toHaveBeenCalled();
  });
});
