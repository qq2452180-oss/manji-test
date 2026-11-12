import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ConnectedHomePage from '../src/pages/ConnectedHomePage.vue';
import ConnectedLibraryPage from '../src/pages/ConnectedLibraryPage.vue';
import ConnectedHistoryPage from '../src/pages/ConnectedHistoryPage.vue';
import ConnectedInterviewPage from '../src/pages/ConnectedInterviewPage.vue';
import ConnectedOrganizingPage from '../src/pages/ConnectedOrganizingPage.vue';
import ConnectedUtilityPage from '../src/pages/ConnectedUtilityPage.vue';
import { ApiError, getAuthToken, getCurrentUser, setAuthToken } from '../src/lib/api.js';
import * as api from '../src/lib/workflow-api.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/workflow-api.js', async importOriginal => ({ ...(await importOriginal()), getCatalog: vi.fn(), getHome: vi.fn(), getBiography: vi.fn(), getChapter: vi.fn(), getInterview: vi.fn(), ensureIdentity: vi.fn() }));
vi.mock('../src/lib/api.js', async importOriginal => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));
const catalog = { chapters: [{ id: 8, title: '数据库中的章节', sort_order: 1, topics: [{ id: 19, chapter_id: 8, title: '数据库中的话题', description: '围绕小时候住处的生活展开。', sort_order: 1 }] }] };
const unauthorized = () => new ApiError('登录状态已失效，请重新登录后继续。', { status: 401, code: 'AUTH_REQUIRED' });
beforeEach(() => {
  vi.resetAllMocks();
  api.getCatalog.mockResolvedValue(catalog);
  api.getHome.mockResolvedValue({ unfinished_interview: null, stories: [], topic_progress: [] });
  api.ensureIdentity.mockResolvedValue({ user_id: '1', is_guest: false });
  getCurrentUser.mockResolvedValue({ id: 1, user_id: 1, is_guest: false });
});

describe('connected catalog and saved writing', () => {
  it('reads the public database catalog and sends its IDs through the existing topic view', async () => {
    const wrapper = mount(ConnectedHomePage);
    await flushPromises();
    expect(wrapper.text()).toContain('数据库中的章节');
    expect(wrapper.text()).toContain('围绕小时候住处的生活展开。');
    expect(wrapper.get('.prototype-nav-xiaonuan').attributes('href')).toBe('./interview.html');
    expect(wrapper.text()).not.toContain('聊聊这一章');
    expect(api.getHome).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="topic-19"]').trigger('click');
    const url = new URL(navigate.mock.calls[0][0], 'http://localhost/web/');
    expect(url.searchParams.get('topic_id')).toBe('19');
    expect(url.searchParams.get('chapter_id')).toBe('8');
    expect(url.searchParams.has('content_id')).toBe(false);
  });

  it('retries an unavailable catalog without loading demo topics', async () => {
    api.getCatalog.mockRejectedValueOnce(new Error('目录暂时无法读取'));
    const wrapper = mount(ConnectedHomePage);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('目录暂时无法读取');
    expect(wrapper.find('[data-testid="topic-19"]').exists()).toBe(false);
    await wrapper.get('button.connected-retry').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="topic-19"]').exists()).toBe(true);
  });

  it('marks told topics from the complete progress index and removes homepage shortcut sections', async () => {
    setAuthToken('test-owner');
    api.getHome.mockResolvedValue({ unfinished_interview: { session_id: '12', preview: '上次聊到的地方' },
      stories: Array.from({ length: 5 }, (_, index) => ({ story_id: 90 + index, title: '最近的故事' })),
      topic_progress: [{ topic_id: 19, chapter_id: 8, status: 'told', story_id: 31, session_id: null }] });
    const wrapper = mount(ConnectedHomePage);
    await flushPromises();
    expect(wrapper.get('[data-testid="topic-19"]').text()).toContain('已讲述');
    for (const text of ['最近的故事', '接着上次聊', '接着整理上次的故事', '上次聊到的地方']) expect(wrapper.text()).not.toContain(text);
    expect(wrapper.find('.connected-saved').exists()).toBe(false);
    await wrapper.get('[data-testid="topic-19"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./story.html?story_id=31');
  });

  it('discards a late private home response after identity changes', async () => {
    setAuthToken('test-owner');
    let resolve;
    api.getHome.mockReturnValue(new Promise(done => { resolve = done; }));
    const wrapper = mount(ConnectedHomePage);
    await flushPromises();
    setAuthToken('');
    resolve({ topic_progress: [{ topic_id: 19, chapter_id: 8, status: 'told', story_id: 31 }] });
    await flushPromises();
    expect(wrapper.text()).not.toContain('已讲述');
    await wrapper.get('[data-testid="topic-19"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./interview.html?topic_id=19&chapter_id=8');
  });

  it('reloads a pending public catalog after identity changes without leaving the spinner active', async () => {
    setAuthToken('old-owner');
    let resolve;
    api.getCatalog.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    api.getHome.mockResolvedValue({ topic_progress: [{ topic_id: 19, chapter_id: 8, status: 'told', story_id: 32 }] });
    const wrapper = mount(ConnectedHomePage);
    expect(wrapper.get('[role="status"]').text()).toContain('正在读取');
    setAuthToken('new-owner');
    await flushPromises();
    expect(api.getCatalog).toHaveBeenCalledTimes(2);
    expect(api.getHome).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('已讲述');
    resolve({ chapters: [] });
    await flushPromises();
    expect(wrapper.find('[data-testid="topic-19"]').exists()).toBe(true);
    expect(api.getHome).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['in_progress', null, './interview.html?topic_id=19&chapter_id=8&session_id=12'],
    ['organizing', null, './organizing.html?session_id=12'],
    ['in_progress', 31, './story.html?story_id=31'],
    ['organizing', 31, './story.html?story_id=31'],
    ['not_started', null, './interview.html?topic_id=19&chapter_id=8'],
  ])('routes topic progress %s with story %s through the topic row', async (status, storyId, expected) => {
    setAuthToken('test-owner');
    api.getHome.mockResolvedValue({ topic_progress: [{ topic_id: 19, chapter_id: 8, status, story_id: storyId, session_id: status === 'not_started' ? null : 12 }] });
    const wrapper = mount(ConnectedHomePage);
    await flushPromises();
    expect(wrapper.text().includes('已讲述')).toBe(Boolean(storyId));
    await wrapper.get('[data-testid="topic-19"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('does not start a new interview while progress is loading or unavailable, then retries', async () => {
    setAuthToken('test-owner');
    let reject;
    api.getHome.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const wrapper = mount(ConnectedHomePage); await flushPromises();
    expect(wrapper.get('[data-testid="topic-19"]').element.disabled).toBe(true);
    await wrapper.get('[data-testid="topic-19"]').trigger('click');
    expect(navigate).not.toHaveBeenCalled();
    reject(new Error('进度暂不可用')); await flushPromises();
    expect(wrapper.get('[data-testid="topic-19"]').element.disabled).toBe(true);
    await wrapper.get('button.connected-retry').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="topic-19"]').element.disabled).toBe(false);
  });

  it('reloads the told marker when returning from a completed story', async () => {
    setAuthToken('test-owner');
    const wrapper = mount(ConnectedHomePage); await flushPromises();
    expect(wrapper.text()).not.toContain('已讲述');
    api.getHome.mockResolvedValue({ topic_progress: [{ topic_id: 19, chapter_id: 8, status: 'told', story_id: 31 }] });
    window.dispatchEvent(new Event('pageshow')); await flushPromises();
    expect(wrapper.text()).toContain('已讲述');
    await wrapper.get('[data-testid="topic-19"]').trigger('click');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./story.html?story_id=31');
  });

  it('keeps the public catalog usable and returns to its chapter after login on a home 401', async () => {
    setAuthToken('expired-owner');
    history.replaceState(null, '', '/web/index.html?chapter_id=8');
    api.getHome.mockRejectedValue(unauthorized());
    const wrapper = mount(ConnectedHomePage);
    await flushPromises();
    expect(wrapper.find('[data-testid="topic-19"]').exists()).toBe(true);
    const login = new URL(wrapper.get('[role="alert"] a').attributes('href'), location.href);
    expect(login.pathname).toBe('/web/login.html');
    expect(login.searchParams.get('next')).toBe('/web/index.html?chapter_id=8');
    expect(wrapper.get('[role="alert"] a').text()).toBe('重新登录后继续');
    expect(getAuthToken()).toBe('expired-owner');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', ' \n '])('shows an empty biography instead of chapter stories when its body is %j', async body => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/biography.html');
    api.getBiography.mockResolvedValue({ body, chapters: [{ chapter_id: 8, title: '青年', story_count: 1 }] });
    api.getChapter.mockResolvedValue({ chapter: { chapter_id: 8, title: '青年' }, stories: [{ story_id: 31, title: '真实成文', body: '第一段真实内容。\n\n第二段真实内容。' }] });
    const wrapper = mount(ConnectedLibraryPage);
    await flushPromises();
    expect(api.getChapter).not.toHaveBeenCalled();
    expect(wrapper.get('.prototype-library-empty').text()).toContain('那些值得记下的日子，会在这里慢慢汇成你的传记。');
    expect(wrapper.find('[data-testid="biography-manuscript"]').exists()).toBe(false);
    expect(wrapper.find('.prototype-chapter-story').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('真实成文');
    expect(wrapper.text()).not.toContain('第一段真实内容。');
  });

  it('renders the saved whole biography without reloading chapter stories and clears it on account change', async () => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/biography.html');
    api.getBiography.mockResolvedValue({ body: '融合后的童年回忆。\n\n后来进城工作的经历。',
      chapters: [{ chapter_id: 8, title: '青年', story_count: 1 }] });
    const wrapper = mount(ConnectedLibraryPage); await flushPromises();
    expect(wrapper.get('[data-testid="biography-manuscript"]').text()).toContain('融合后的童年回忆。');
    expect(wrapper.findAll('.prototype-draft-paragraph').map(item => item.text()))
      .toEqual(['融合后的童年回忆。', '后来进城工作的经历。']);
    expect(api.getChapter).not.toHaveBeenCalled();
    setAuthToken(''); await flushPromises();
    expect(wrapper.find('[data-testid="biography-manuscript"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('融合后的童年回忆。');
  });

  it.each(['', '?chapter_id=abc', '?chapter_id=0', '?chapter_id=-1', '?chapter_id=9007199254740992', '?chapter_id=8&chapter_id=9'])('shows a safe error for an invalid anonymous chapter link: %s', async query => {
    history.replaceState(null, '', `/web/chapter.html${query}`);
    const wrapper = mount(ConnectedLibraryPage);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('章节链接无效');
    expect(wrapper.get('[role="alert"] a').attributes('href')).toBe('./index.html');
    expect(api.getChapter).not.toHaveBeenCalled();
    expect(api.getBiography).not.toHaveBeenCalled();
  });

  it('normalizes a chapter ID before reading it or generating its empty-state link', async () => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/chapter.html?chapter_id=0008');
    api.getChapter.mockResolvedValue({ chapter: { chapter_id: '8', title: '青年' }, stories: [] });
    const wrapper = mount(ConnectedLibraryPage);
    await flushPromises();
    expect(api.getChapter).toHaveBeenCalledWith('8');
    expect(wrapper.get('.prototype-library-empty a').attributes('href')).toBe('./index.html?chapter_id=8');
    expect(wrapper.get('.prototype-library-empty a').text()).toBe('选一个话题');
  });

  it('shows existing chapter stories without a separate chapter interview entrance', async () => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/chapter.html?chapter_id=8');
    api.getChapter.mockResolvedValue({ chapter: { chapter_id: '8', title: '青年' }, stories: [{ story_id: 31, title: '学手艺', body: '学手艺的经历。' }] });
    const wrapper = mount(ConnectedLibraryPage);
    await flushPromises();
    expect(wrapper.text()).not.toContain('聊聊这一章');
    expect(wrapper.text()).toContain('学手艺的经历。');
  });

  it('offers login recovery on a biography 401 without changing identity', async () => {
    setAuthToken('expired-owner');
    history.replaceState(null, '', '/web/biography.html');
    api.getBiography.mockRejectedValue(unauthorized());
    const wrapper = mount(ConnectedLibraryPage);
    await flushPromises();
    const login = new URL(wrapper.get('[role="alert"] a').attributes('href'), location.href);
    expect(login.pathname).toBe('/web/login.html');
    expect(login.searchParams.get('next')).toBe('/web/biography.html');
    expect(getAuthToken()).toBe('expired-owner');
  });

  it('offers only login recovery for an expired profile without replacing the identity', async () => {
    setAuthToken('expired-owner');
    window.sessionStorage.setItem('manji.workflow.session', '12');
    history.replaceState(null, '', '/web/profile.html?session_id=12');
    getCurrentUser.mockRejectedValue(unauthorized());
    const wrapper = mount(ConnectedUtilityPage);
    await flushPromises();
    expect(wrapper.text()).toContain('登录原来的账号找回记录');
    expect(getAuthToken()).toBe('expired-owner');
    expect(window.sessionStorage.getItem('manji.workflow.session')).toBe('12');
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.find('.connected-saved a[href="./interview.html"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="restart-experience"]').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    const login = new URL(wrapper.get('[role="alert"] a').attributes('href'), location.href);
    expect(login.pathname).toBe('/web/login.html');
    expect(login.searchParams.get('next')).toBe('/web/profile.html?session_id=12');
    expect(api.ensureIdentity).not.toHaveBeenCalled();
  });

  it('preserves the current identity on a temporary profile error and offers retry', async () => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/profile.html');
    getCurrentUser.mockRejectedValueOnce(new Error('暂时无法连接'));
    const wrapper = mount(ConnectedUtilityPage);
    await flushPromises();
    expect(wrapper.find('[data-testid="restart-experience"]').exists()).toBe(false);
    await wrapper.get('button.connected-retry').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(getAuthToken()).toBe('test-owner');
  });

  it('reads saved messages and offers continuation for the same session', async () => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/history.html?session_id=12');
    api.getInterview.mockResolvedValue({ session_id: '12', status: 'interview_replied', selected_topic: { title: '小时候的家' }, messages: [{ id: '1', role: 'assistant', content: '想从哪里聊起？' }, { id: '2', role: 'user', content: '我记得门口那条河。' }] });
    const wrapper = mount(ConnectedHistoryPage);
    await flushPromises();
    expect(api.getInterview).toHaveBeenCalledWith('12');
    expect(wrapper.text()).toContain('我记得门口那条河。');
    expect(wrapper.get('a.prototype-history-action').attributes('href')).toContain('session_id=12');
  });

  it('routes a history list session with pending processing back to organizing', async () => {
    setAuthToken('test-owner');
    history.replaceState(null, '', '/web/history.html');
    api.getHome.mockResolvedValue({ unfinished_interview: { session_id: '12', preview: '等着整理的讲述', needs_processing: true }, stories: [] });
    const wrapper = mount(ConnectedHistoryPage);
    await flushPromises();
    expect(wrapper.get('a[href="./organizing.html?session_id=12"]').text()).toContain('继续整理');
    expect(wrapper.find('a[href="./interview.html?session_id=12"]').exists()).toBe(false);
  });

  it('offers login recovery on a saved history 401 without changing identity', async () => {
    setAuthToken('expired-owner');
    history.replaceState(null, '', '/web/history.html?session_id=12');
    api.getInterview.mockRejectedValue(unauthorized());
    const wrapper = mount(ConnectedHistoryPage);
    await flushPromises();
    const login = new URL(wrapper.get('[role="alert"] a').attributes('href'), location.href);
    expect(login.pathname).toBe('/web/login.html');
    expect(login.searchParams.get('next')).toBe('/web/history.html?session_id=12');
    expect(getAuthToken()).toBe('expired-owner');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    [ConnectedLibraryPage, '/web/biography.html'],
    [ConnectedHistoryPage, '/web/history.html?session_id=12'],
  ])('offers login to read existing anonymous records without starting a guest', async (component, path) => {
    history.replaceState(null, '', path);
    const wrapper = mount(component);
    await flushPromises();
    const link = wrapper.findAll('a').find(item => item.text() === '登录查看已有记录');
    expect(new URL(link.attributes('href'), location.href).searchParams.get('next')).toBe(path);
    expect(getAuthToken()).toBe('');
    expect(api.getBiography).not.toHaveBeenCalled();
    expect(api.getInterview).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    [ConnectedInterviewPage, '/web/interview.html?session_id=12&interaction=text'],
    [ConnectedOrganizingPage, '/web/organizing.html?session_id=12&story_id=31'],
  ])('keeps an existing workflow page as the login return destination after 401', async (component, path) => {
    setAuthToken('expired-owner');
    history.replaceState(null, '', path);
    api.getInterview.mockRejectedValue(unauthorized());
    const wrapper = mount(component);
    await flushPromises();
    const link = wrapper.get('[role="alert"] a');
    expect(link.text()).toBe('重新登录后继续');
    expect(new URL(link.attributes('href'), location.href).searchParams.get('next')).toBe(path);
    expect(getAuthToken()).toBe('expired-owner');
    expect(navigate).not.toHaveBeenCalled();
  });
});
