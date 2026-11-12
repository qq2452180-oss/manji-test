import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ConnectedOrganizingPage from '../src/pages/ConnectedOrganizingPage.vue';
import ConnectedStoryPage from '../src/pages/ConnectedStoryPage.vue';
import * as api from '../src/lib/workflow-api.js';

vi.mock('../src/lib/workflow-api.js', async importOriginal => ({
  ...await importOriginal(),
  ensureIdentity: vi.fn(), getInterview: vi.fn(), finishInterview: vi.fn(), getStory: vi.fn(),
}));
const topic = { id: '12', chapter_id: '3', title: '学过的一门手艺', description: '学手艺时的尝试。' };
const snapshot = { session_id: '41', status: 'interview_replied', messages: [], selected_topic: topic, save_pending: false };
const completed = { session_id: '41', status: 'completed', story_id: '81', title: '木工师傅', body: '第一段。\n\n第二段。', chapter_id: '3' };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function organizing() { history.replaceState(null, '', '/web/organizing.html?session_id=41'); return mount(ConnectedOrganizingPage); }
function story() { history.replaceState(null, '', '/web/story.html?story_id=81&session_id=999'); return mount(ConnectedStoryPage); }
let hidden;
beforeEach(() => {
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  sessionStorage.setItem('manji.auth_token', 'owner-a');
  api.ensureIdentity.mockResolvedValue({ user_id: '7', is_guest: true });
  api.getInterview.mockResolvedValue(snapshot);
  api.finishInterview.mockResolvedValue(completed);
  api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', body: '第一段。\n\n第二段。',
    source_session_id: '41', photo_layout: [], selected_topic: topic, active_supplement: null,
    source_sessions: [{ session_id: '41' }], version: 1 });
});

describe('connected organizing', () => {
  it.each([
    ['awaiting_first_input', null], ['interview_replied', null],
    ['reply_pending', 'interview'], ['writing_pending', 'writing'],
  ])('does not finish or offer repeated finish for a legacy topicless %s session', async (status, nextNode) => {
    api.getInterview.mockResolvedValue({ ...snapshot, status, next_node: nextNode, selected_topic: null });
    const page = organizing(); await flushPromises();
    expect(api.finishInterview).not.toHaveBeenCalled();
    expect(page.get('[data-testid="legacy-select-topic"]').attributes('href')).toBe('./index.html');
    expect(page.find('[data-testid="retry-organization"]').exists()).toBe(false);
    expect(location.search).toBe('?session_id=41');
    window.dispatchEvent(new Event('pageshow')); await flushPromises();
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it.each(['memory_update', 'summary'])('continues an already written topicless story pending %s', async nextNode => {
    api.getInterview.mockResolvedValue({ ...snapshot, status: 'writing_pending', next_node: nextNode, selected_topic: null });
    const page = organizing(); await flushPromises();
    expect(api.finishInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toBe('./story.html?story_id=81&session_id=41');
    expect(page.find('[data-testid="legacy-select-topic"]').exists()).toBe(false);
  });

  it('opens a completed topicless result without another finish', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, ...completed, selected_topic: null });
    const page = organizing(); await flushPromises();
    expect(api.finishInterview).not.toHaveBeenCalled();
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toBe('./story.html?story_id=81&session_id=41');
  });

  it('organizes an explicit global session and offers both saved results', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, selected_topic: null, interview_scope: 'global' });
    api.finishInterview.mockResolvedValue({ ...completed, chapter_id: null, interview_scope: 'global' });
    const page = organizing(); await flushPromises();
    expect(api.finishInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(page.find('[data-testid="legacy-select-topic"]').exists()).toBe(false);
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toBe('./story.html?story_id=81&session_id=41');
    expect(page.get('[data-testid="view-organized-biography"]').attributes('href')).toBe('./biography.html');
    expect(page.text()).toContain('可以查看故事和传记');
  });

  it('retries a failed global biography update on the same session', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, selected_topic: null, interview_scope: 'global' });
    const pending = deferred(); api.finishInterview.mockReturnValueOnce(pending.promise);
    const page = organizing(); await flushPromises();
    expect(page.get('h1').text()).toBe('正在整理这段讲述');
    pending.reject(new Error('故事已保存，传记尚未更新')); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('传记尚未更新');
    expect(page.find('[data-testid="view-organized-biography"]').exists()).toBe(false);
    expect(api.finishInterview).toHaveBeenCalledTimes(1);
    api.getInterview.mockResolvedValue({ ...completed, chapter_id: null, interview_scope: 'global' });
    await page.get('[data-testid="retry-organization"]').trigger('click'); await flushPromises();
    expect(api.finishInterview).toHaveBeenCalledTimes(2);
    expect(api.finishInterview).toHaveBeenLastCalledWith('41');
    expect(page.get('[data-testid="view-organized-biography"]').attributes('href')).toBe('./biography.html');
  });

  it('keeps the existing session link and does not create a guest when credentials are absent', async () => {
    sessionStorage.removeItem('manji.auth_token');
    const page = organizing(); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('登录原来的账号');
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.getInterview).not.toHaveBeenCalled();
    expect(api.finishInterview).not.toHaveBeenCalled();
    expect(location.search).toBe('?session_id=41');
  });

  it('reads first, finishes once, and does not poll while the synchronous finish is running', async () => {
    const pending = deferred(); api.finishInterview.mockReturnValue(pending.promise);
    const page = organizing(); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(api.finishInterview).toHaveBeenCalledExactlyOnceWith('41');
    expect(page.text()).toContain('正在整理这段讲述');
    window.dispatchEvent(new Event('pageshow')); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledTimes(1);
    pending.resolve(completed); await flushPromises();
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toBe('./story.html?story_id=81&session_id=41');
    expect(api.finishInterview).toHaveBeenCalledTimes(1);
  });

  it('shows an existing completed result without running finish again', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, ...completed });
    const page = organizing(); await flushPromises();
    expect(page.text()).toContain('已经整理好了');
    expect(api.finishInterview).not.toHaveBeenCalled();
  });

  it('requires a manual retry after failure and resumes by calling finish on the same session', async () => {
    api.finishInterview.mockRejectedValueOnce(new Error('故事已保存，摘要尚未完成'));
    const page = organizing(); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('摘要尚未完成');
    expect(api.finishInterview).toHaveBeenCalledTimes(1);
    api.getInterview.mockResolvedValueOnce({ ...snapshot, status: 'writing_pending', next_node: 'summary' });
    await page.get('[data-testid="retry-organization"]').trigger('click'); await flushPromises();
    expect(api.finishInterview).toHaveBeenCalledTimes(2);
    expect(api.finishInterview).toHaveBeenLastCalledWith('41');
    expect(page.find('[data-testid="view-organized-story"]').exists()).toBe(true);
  });

  it('requires an explicit rebase after a story version conflict and returns to the original story', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, target_story_id: '81' });
    api.finishInterview.mockRejectedValueOnce(Object.assign(new Error('故事已有更新'), { status: 409, code: 'STORY_VERSION_CONFLICT' }));
    const page = organizing(); await flushPromises();
    expect(page.get('.prototype-organizing-header a').attributes('href')).toBe('./story.html?story_id=81');
    expect(page.get('[data-testid="rebase-organization"]').text()).toBe('按最新故事重新整理');
    expect(page.find('[data-testid="retry-organization"]').exists()).toBe(false);
    api.getInterview.mockResolvedValue({ ...snapshot, status: 'revision_conflict', target_story_id: '81' });
    await page.get('[data-testid="rebase-organization"]').trigger('click'); await flushPromises();
    expect(api.finishInterview).toHaveBeenLastCalledWith('41', { rebase: true });
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toBe('./story.html?story_id=81&session_id=41');
  });

  it('does not automatically retry a persisted story version conflict on reload', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, status: 'revision_conflict', target_story_id: '81' });
    const page = organizing(); await flushPromises();
    expect(api.finishInterview).not.toHaveBeenCalled();
    expect(page.find('[data-testid="rebase-organization"]').exists()).toBe(true);
  });

  it('returns a pending reply to the interview instead of finishing incomplete material', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, status: 'reply_pending' });
    const page = organizing(); await flushPromises();
    expect(api.finishInterview).not.toHaveBeenCalled();
    expect(page.get('.prototype-organizing-action').attributes('href')).toBe('./interview.html?session_id=41');
  });

  it('ignores an in-flight result after auth change and does not expose its story link', async () => {
    const pending = deferred(); api.finishInterview.mockReturnValue(pending.promise);
    const page = organizing(); await flushPromises();
    sessionStorage.setItem('manji.auth_token', 'owner-b'); window.dispatchEvent(new Event('manji:auth-changed'));
    pending.resolve(completed); await flushPromises();
    expect(page.find('[data-testid="view-organized-story"]').exists()).toBe(false);
    expect(page.text()).not.toContain(topic.title);
    expect(page.text()).toContain('登录状态已变化');
  });

  it('waits for a hidden finish to settle, then reads the outcome without starting another finish', async () => {
    const pending = deferred(); api.finishInterview.mockReturnValue(pending.promise);
    const page = organizing(); await flushPromises();
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledTimes(1);
    api.getInterview.mockResolvedValueOnce({ ...snapshot, ...completed });
    pending.resolve(completed); await flushPromises();
    expect(api.getInterview).toHaveBeenCalledTimes(2);
    expect(api.finishInterview).toHaveBeenCalledTimes(1);
    expect(page.find('[data-testid="view-organized-story"]').exists()).toBe(true);
  });
});

describe('connected story', () => {
  it('reads a global story and its transcript without constructing a chapter link', async () => {
    api.getStory.mockResolvedValue({ story_id: '81', title: '聊起旧日生活', body: '一段已保存的回忆。',
      chapter_id: null, selected_topic: null, source_session_id: '41', source_sessions: [{ session_id: '41' }] });
    const page = story(); await flushPromises();
    expect(page.text()).toContain('一段已保存的回忆。');
    expect(page.get('.prototype-story-back').attributes('href')).toBe('./index.html');
    expect(page.get('[data-testid="story-answers"]').attributes('href')).toBe('./history.html?session_id=41');
    expect(page.find('a[href*="chapter_id="]').exists()).toBe(false);
  });

  it('sends a story without a selected topic back to the catalog instead of starting free talk', async () => {
    api.getInterview.mockResolvedValue({ ...snapshot, selected_topic: null });
    api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', body: '第一段。', chapter_id: '3', source_session_id: '41', photo_layout: [] });
    const page = story(); await flushPromises();
    expect(page.text()).toContain('第一段。');
    expect(page.find('[data-testid="continue-topic"]').exists()).toBe(false);
    expect(page.get('[data-testid="select-story-topic"]').attributes('href')).toBe('./index.html?chapter_id=3');
    expect(page.get('[data-testid="story-answers"]').attributes('href')).toBe('./history.html?session_id=41');
  });

  it('does not create another identity to read an existing story without credentials', async () => {
    sessionStorage.removeItem('manji.auth_token');
    const page = story(); await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain('登录原来的账号');
    expect(api.ensureIdentity).not.toHaveBeenCalled();
    expect(api.getStory).not.toHaveBeenCalled();
    expect(location.search).toContain('story_id=81');
  });

  it('renders real paragraphs without sample images and links the server source and selected topic', async () => {
    const page = story(); await flushPromises();
    expect(api.getStory).toHaveBeenCalledExactlyOnceWith('81');
    expect(api.getInterview).not.toHaveBeenCalled();
    expect(page.get('h1').text()).toBe('木工师傅');
    expect(page.findAll('[data-testid="story-paragraph"]').map(item => item.text())).toEqual(['第一段。', '第二段。']);
    expect(page.find('img').exists()).toBe(false);
    expect(page.get('[data-testid="story-answers"]').attributes('href')).toBe('./history.html?session_id=41');
    expect(page.get('[data-testid="continue-topic"]').attributes('href')).toBe('./interview.html?topic_id=12&chapter_id=3&story_id=81');
    expect(page.get('[data-testid="continue-topic"]').text()).toContain('继续补充');
    expect(page.get('[data-testid="story-answers"]').text()).toBe('查看讲述记录');
  });

  it('respects an explicitly empty source list instead of linking an unavailable original source', async () => {
    api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', body: '保留的正文。',
      selected_topic: null, source_session_id: '41', source_sessions: [] });
    const page = story(); await flushPromises();
    expect(page.text()).toContain('保留的正文。');
    expect(page.find('[data-testid="story-answers"]').exists()).toBe(false);
  });

  it('keeps reading and supplementation independent of source snapshot availability', async () => {
    api.getInterview.mockRejectedValue(new Error('访谈暂不可用'));
    const page = story(); await flushPromises();
    expect(page.text()).toContain('第一段。');
    expect(page.find('[data-testid="story-answers"]').exists()).toBe(true);
    expect(page.find('[data-testid="continue-topic"]').exists()).toBe(true);
    expect(api.getInterview).not.toHaveBeenCalled();
  });

  it.each([
    ['in_progress', './interview.html?topic_id=12&chapter_id=3&session_id=42&story_id=81', '继续补充'],
    ['organizing', './organizing.html?session_id=42&story_id=81', '继续整理补充'],
  ])('resumes a saved %s supplement and retains all source transcripts', async (status, href, label) => {
    api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', body: '第一段。', selected_topic: topic,
      active_supplement: { session_id: '42', status }, source_sessions: [{ session_id: '41' }, { session_id: '40' }] });
    const page = story(); await flushPromises();
    expect(page.get('[data-testid="continue-topic"]').attributes('href')).toBe(href);
    expect(page.get('[data-testid="continue-topic"]').text()).toContain(label);
    expect(page.findAll('[data-testid="story-answers"]').map(link => link.attributes('href')))
      .toEqual(['./history.html?session_id=41', './history.html?session_id=40']);
  });

  it('continues pending post-processing while leaving the saved story readable', async () => {
    api.getStory.mockResolvedValue({ story_id: '81', title: '木工师傅', body: '已保存的正文。',
      selected_topic: topic, pending_processing: { session_id: '41' } });
    const page = story(); await flushPromises();
    expect(page.text()).toContain('已保存的正文。');
    expect(page.get('[data-testid="continue-topic"]').attributes('href')).toBe('./organizing.html?session_id=41&story_id=81');
    expect(page.get('[data-testid="continue-topic"]').text()).toContain('继续整理');
  });

  it('clears private story content on account change and ignores late reads', async () => {
    const pending = deferred(); api.getStory.mockReturnValue(pending.promise);
    const page = story(); await flushPromises();
    sessionStorage.setItem('manji.auth_token', 'owner-b'); window.dispatchEvent(new Event('manji:auth-changed'));
    pending.resolve({ title: '旧账号私密故事', body: '旧账号正文' }); await flushPromises();
    expect(page.text()).not.toContain('旧账号');
    expect(page.find('[data-testid="story-answers"]').exists()).toBe(false);
    expect(page.text()).toContain('登录状态已变化');
  });

  it('removes an already displayed story and its browser title when the account changes', async () => {
    const page = story(); await flushPromises();
    expect(document.title).toBe('慢记 · 木工师傅');
    sessionStorage.setItem('manji.auth_token', 'owner-b'); window.dispatchEvent(new Event('manji:auth-changed'));
    await flushPromises();
    expect(page.text()).not.toContain('木工师傅');
    expect(page.text()).not.toContain('第一段。');
    expect(document.title).toBe('慢记 · 故事');
  });
});
