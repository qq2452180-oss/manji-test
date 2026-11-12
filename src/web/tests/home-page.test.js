// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import HomePage from '../src/pages/HomePage.vue';
import * as api from '../src/lib/api.js';
import * as pointers from '../src/lib/app-state.js';
import { navigate } from '../src/lib/navigation.js';

const data = vi.hoisted(() => ({ token: 'owner-a', active: [], organization: '' }));
vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(() => data.token), getCurrentUser: vi.fn(), getUnfinishedInterview: vi.fn(), getSession: vi.fn(), getOrganization: vi.fn(), readHomeData: vi.fn() }));
vi.mock('../src/lib/app-state.js', () => ({
  getActiveSessionIds: vi.fn(() => data.active), getOrganizationSessionId: vi.fn(() => data.organization),
  setActiveSessionId: vi.fn(id => { data.active = [id, ...data.active.filter(value => value !== id)]; }),
  setOrganizationSessionId: vi.fn(id => { data.organization = id; }), removeActiveSessionId: vi.fn(id => { data.active = data.active.filter(value => value !== id); }), setBiographyId: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));
const wrappers = [], deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const render = () => { const wrapper = mount(HomePage); wrappers.push(wrapper); return wrapper; };
beforeEach(() => {
  vi.clearAllMocks(); data.token = 'owner-a'; data.active = []; data.organization = '';
  window.history.replaceState({}, '', '/web2/index.html'); Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  api.getCurrentUser.mockReset().mockResolvedValue({ id: 'a', is_guest: false }); api.getSession.mockReset(); api.getOrganization.mockReset();
  api.getUnfinishedInterview.mockReset().mockResolvedValue({ session_id: null });
  api.readHomeData.mockReset().mockResolvedValue({ biography: { biography_id: 'book-a' }, stories: [] });
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

it('discovers a finishing draft before reading the organization pointer', async () => {
  const session = deferred(); data.active = ['session-a']; api.getSession.mockReturnValue(session.promise);
  api.getOrganization.mockResolvedValue({ session_id: 'session-a', status: 'RUNNING' });
  const wrapper = render(); await flushPromises(); expect(api.getOrganization).not.toHaveBeenCalled();
  session.resolve({ session_id: 'session-a', activity_state: 'FINISHING', status: 'ACTIVE' }); await flushPromises();
  expect(api.getOrganization).toHaveBeenCalledWith('session-a'); expect(pointers.removeActiveSessionId).toHaveBeenCalledWith('session-a');
  expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false); expect(wrapper.get('[data-testid="organization"]').text()).toContain('正在整理');
  await wrapper.get('[data-testid="organization"]').trigger('click'); expect(navigate).toHaveBeenCalledWith('./organizing.html?session_id=session-a');
});

it('does not remove or publish draft pointers after the account changed', async () => {
  const session = deferred(); data.active = ['old-session']; api.getSession.mockReturnValue(session.promise);
  const wrapper = render(); await flushPromises(); data.token = 'owner-b'; window.dispatchEvent(new Event('manji:auth-changed'));
  session.resolve({ session_id: 'old-session', activity_state: 'FINISHING', status: 'ACTIVE' }); await flushPromises();
  expect(pointers.setOrganizationSessionId).not.toHaveBeenCalled(); expect(pointers.removeActiveSessionId).not.toHaveBeenCalled();
  expect(pointers.setBiographyId).not.toHaveBeenCalled(); expect(api.getOrganization).not.toHaveBeenCalled();
  expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false);
});

it('retains a draft on network failure but removes a confirmed missing session', async () => {
  data.active = ['missing', 'uncertain']; api.getSession.mockRejectedValueOnce({ status: 404 }).mockRejectedValueOnce(new Error('offline'));
  const wrapper = render(); await flushPromises();
  expect(pointers.removeActiveSessionId).toHaveBeenCalledTimes(1); expect(pointers.removeActiveSessionId).toHaveBeenCalledWith('missing');
  expect(data.active).toEqual(['uncertain']); expect(wrapper.text()).toContain('记录仍然保留');
});

it('shows the latest five stories and gives legacy drafts one history link', async () => {
  data.active = ['legacy']; api.getSession.mockResolvedValue({ session_id: 'legacy', status: 'ACTIVE', flow_version: 'legacy', mode: 'PHOTO', opening_assistant_text: '最初的开场', turns: [{ assistant_text: '之前讲到的事' }, { assistant_text: '上次讲到的事' }] });
  api.readHomeData.mockResolvedValue({ biography: { biography_id: 'book-a' }, stories: Array.from({ length: 7 }, (_, index) => ({ story_id: 'story-' + index, current_version: { title: '故事 ' + index, created_at: '2026-09-30' } })) });
  const wrapper = render(); await flushPromises();
  expect(wrapper.findAll('.recent-story')).toHaveLength(5);
  const draft = wrapper.get('[data-testid="draft"]'), links = draft.findAll('a');
  expect(links).toHaveLength(1); expect(links[0].text()).toBe('查看历史');
  expect(links[0].attributes('href')).toBe('./history.html?session_id=legacy');
  expect(draft.text()).not.toContain('继续聊'); expect(draft.text()).not.toContain('查看记录');
  expect(draft.text()).toContain('上次讲到的事'); expect(draft.text()).not.toContain('之前讲到的事'); expect(draft.text()).not.toContain('最初的开场');
  await wrapper.findAll('.recent-story')[0].trigger('click'); expect(navigate).toHaveBeenCalledWith('./story.html?story_id=story-0');
});

it('clears private stories when hidden and discards responses from a page that has left', async () => {
  const home = deferred(); api.readHomeData.mockReturnValue(home.promise); const wrapper = render(); await flushPromises();
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
  home.resolve({ biography: { biography_id: 'private-book' }, stories: [{ story_id: 'secret', current_version: { title: '私人故事' } }] }); await flushPromises();
  expect(wrapper.text()).not.toContain('私人故事'); expect(pointers.setBiographyId).not.toHaveBeenCalled();
  wrapper.unmount(); window.dispatchEvent(new Event('manji:auth-changed')); expect(navigate).not.toHaveBeenCalled();
});

it('opens the welcome page before calling APIs when there is no identity', async () => {
  data.token = ''; render(); await flushPromises();
  expect(api.getCurrentUser).not.toHaveBeenCalled(); expect(api.readHomeData).not.toHaveBeenCalled(); expect(api.getSession).not.toHaveBeenCalled();
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('./welcome.html', { replace: true });
});

it('sends an authenticated guest to registration without loading member data', async () => {
  api.getCurrentUser.mockResolvedValue({ id: 'guest-a', is_guest: true });
  render(); await flushPromises();
  expect(navigate).toHaveBeenCalledWith('./login.html?trial=1&next=%2Fweb2%2Findex.html', { replace: true });
  expect(api.readHomeData).not.toHaveBeenCalled(); expect(api.getSession).not.toHaveBeenCalled();
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
});

it('keeps one accessible photo entry after recent content while loading, after errors, and when empty', async () => {
  const home = deferred(); api.readHomeData.mockReturnValueOnce(home.promise);
  const wrapper = render(); await flushPromises();
  const expectPhotoEntry = () => {
    const entries = wrapper.findAll('main a[href*="new=1"]');
    expect(entries).toHaveLength(1);
    const entry = entries[0], recent = wrapper.get('.recent-content');
    expect(entry.classes()).toContain('photo-interview-card');
    expect(entry.attributes('aria-label') || entry.text()).toBe('图片访谈');
    expect(entry.attributes('href')).toBe('./interview.html?new=1&entry=PHOTO');
    expect(entry.isVisible()).toBe(true); expect(entry.attributes('aria-disabled')).not.toBe('true');
    expect(entry.element.closest('[aria-hidden="true"]')).toBeNull();
    for (const decoration of entry.findAll('svg')) expect(decoration.element.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(recent.element.contains(entry.element)).toBe(false);
    expect(recent.element.compareDocumentPosition(entry.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  };
  expect(wrapper.get('.recent-content').text()).toContain('正在翻开你的故事'); expectPhotoEntry();
  home.reject(new Error('暂时无法读取故事。')); await flushPromises();
  expect(wrapper.get('.recent-content').text()).toContain('暂时无法读取故事'); expectPhotoEntry();
  await wrapper.get('.recent-content .paper-link').trigger('click'); await flushPromises();
  expect(wrapper.get('.recent-content .empty-stories').exists()).toBe(true); expectPhotoEntry();
  expect(wrapper.get('nav a[aria-label="小暖"]').attributes('href')).toBe('./interview.html?new=1&entry=GENERAL');
  expect(wrapper.text()).not.toContain('打字聊'); expect(wrapper.text()).not.toContain('和小暖聊聊');
});

it.each([
  ['GENERAL', '欢迎接着讲那时候的事。', '欢迎接着讲那时候的事。'],
  ['PHOTO', '', '上次的讲述已保存，可以从停下的地方接着讲。'],
])('keeps both continuation links and the new photo entry available for a %s draft', async (mode, opening, preview) => {
  data.active = ['unfinished'];
  api.getSession.mockResolvedValue({ session_id: 'unfinished', status: 'ACTIVE', activity_state: 'PAUSED', flow_version: 'interview', mode, opening_assistant_text: opening, turns: [] });
  const wrapper = render(); await flushPromises();
  const draft = wrapper.get('[data-testid="draft"]'), links = draft.findAll('a');
  expect(links.map(link => [link.text(), link.attributes('href')])).toEqual([
    ['查看记录', './history.html?session_id=unfinished'],
    ['继续聊', './interview.html?session_id=unfinished&resume=1'],
  ]);
  for (const link of links) expect(link.attributes('href')).not.toContain('new=1');
  expect(draft.text()).toContain(preview); expect(draft.text()).toContain(mode === 'PHOTO' ? '照片访谈' : '对话访谈');
  const entry = wrapper.get('main a[href="./interview.html?new=1&entry=PHOTO"]');
  expect(entry.attributes('aria-label') || entry.text()).toBe('图片访谈'); expect(entry.isVisible()).toBe(true);
});

it('recovers the same account session after closing the browser and logging in without local pointers', async () => {
  data.active = ['paused-session'];
  api.getUnfinishedInterview.mockResolvedValue({ session_id: 'paused-session' });
  api.getSession.mockResolvedValue({ session_id: 'paused-session', status: 'ACTIVE', activity_state: 'PAUSED', flow_version: 'interview', mode: 'GENERAL', turns: [] });
  const initial = render(); await flushPromises(); initial.unmount();
  data.active = []; data.organization = ''; sessionStorage.clear(); localStorage.clear(); data.token = 'owner-a-new-login';
  const restored = render(); await flushPromises();
  const continueLink = restored.get('.draft-card-continue');
  expect(continueLink.attributes('href')).toBe('./interview.html?session_id=paused-session&resume=1');
  expect(continueLink.attributes('href')).not.toContain('new=1');
  expect(api.getSession).toHaveBeenNthCalledWith(1, 'paused-session');
  expect(api.getSession).toHaveBeenNthCalledWith(2, 'paused-session');
  expect(api.getUnfinishedInterview).toHaveBeenCalledTimes(2);
  expect(pointers.setActiveSessionId).toHaveBeenLastCalledWith('paused-session');
  expect(pointers.removeActiveSessionId).not.toHaveBeenCalled();
  expect(data.active).toEqual(['paused-session']);
});

it('prioritizes the account saved session over an older local pointer without querying it twice', async () => {
  data.active = ['older-session', 'latest-session'];
  api.getUnfinishedInterview.mockResolvedValue({ session_id: 'latest-session' });
  api.getSession.mockResolvedValue({ session_id: 'latest-session', status: 'ACTIVE', activity_state: 'PAUSED', flow_version: 'interview', turns: [] });
  const wrapper = render(); await flushPromises();
  expect(api.getSession).toHaveBeenCalledOnce(); expect(api.getSession).toHaveBeenCalledWith('latest-session');
  expect(wrapper.get('.draft-card-continue').attributes('href')).toBe('./interview.html?session_id=latest-session&resume=1');
  expect(data.active).toEqual(['latest-session', 'older-session']);
});

it('shows no continuation when the account has no unfinished interview and no local pointer', async () => {
  const wrapper = render(); await flushPromises();
  expect(api.getUnfinishedInterview).toHaveBeenCalledOnce(); expect(api.getSession).not.toHaveBeenCalled();
  expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false);
  expect(wrapper.find('.draft-retry').exists()).toBe(false); expect(pointers.setActiveSessionId).not.toHaveBeenCalled();
});

it.each([
  ['FINISHED', 'COMPLETED'], ['FINISHED', 'ACTIVE'],
])('does not continue a session that became %s/%s after discovery', async (activity_state, status) => {
  data.active = ['finished-session'];
  api.getUnfinishedInterview.mockResolvedValue({ session_id: 'finished-session' });
  api.getSession.mockResolvedValue({ session_id: 'finished-session', status, activity_state, flow_version: 'interview' });
  const wrapper = render(); await flushPromises();
  expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false);
  expect(api.getSession).toHaveBeenCalledOnce(); expect(pointers.removeActiveSessionId).toHaveBeenCalledWith('finished-session');
  expect(pointers.setActiveSessionId).not.toHaveBeenCalled();
});

it('routes a newly discovered finishing interview to its organization progress', async () => {
  api.getUnfinishedInterview.mockResolvedValue({ session_id: 'finishing-session' });
  api.getSession.mockResolvedValue({ session_id: 'finishing-session', status: 'ACTIVE', activity_state: 'FINISHING', flow_version: 'interview' });
  api.getOrganization.mockResolvedValue({ session_id: 'finishing-session', status: 'RUNNING' });
  const wrapper = render(); await flushPromises();
  expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false);
  expect(pointers.setOrganizationSessionId).toHaveBeenCalledWith('finishing-session');
  expect(api.getOrganization).toHaveBeenCalledWith('finishing-session');
  expect(wrapper.get('[data-testid="organization"]').text()).toContain('正在整理');
});

it('retains local records on discovery failure and retries the saved account session', async () => {
  data.active = ['retained-session'];
  api.getUnfinishedInterview.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ session_id: 'retained-session' });
  api.getSession.mockResolvedValue({ session_id: 'retained-session', status: 'ACTIVE', activity_state: 'PAUSED', flow_version: 'interview', turns: [] });
  const wrapper = render(); await flushPromises();
  expect(wrapper.text()).toContain('记录仍然保留'); expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false);
  expect(data.active).toEqual(['retained-session']); expect(pointers.removeActiveSessionId).not.toHaveBeenCalled();
  expect(api.getSession).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  await wrapper.get('.draft-retry').trigger('click'); await flushPromises();
  expect(api.getUnfinishedInterview).toHaveBeenCalledTimes(2);
  expect(wrapper.get('.draft-card-continue').attributes('href')).toBe('./interview.html?session_id=retained-session&resume=1');
  expect(wrapper.find('.draft-retry').exists()).toBe(false);
});

it.each(['account change', 'hide', 'unmount'])('discards unfinished discovery after %s without persisting or exposing old account data', async event => {
  const discovery = deferred(); api.getUnfinishedInterview.mockReturnValue(discovery.promise);
  const wrapper = render(); await flushPromises(); expect(api.getUnfinishedInterview).toHaveBeenCalledOnce();
  if (event === 'account change') { data.token = 'owner-b'; window.dispatchEvent(new Event('manji:auth-changed')); }
  else if (event === 'hide') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }
  else wrapper.unmount();
  discovery.resolve({ session_id: 'private-session' }); await flushPromises();
  expect(api.getSession).not.toHaveBeenCalled(); expect(pointers.setActiveSessionId).not.toHaveBeenCalled();
  expect(pointers.removeActiveSessionId).not.toHaveBeenCalled(); expect(pointers.setOrganizationSessionId).not.toHaveBeenCalled();
  expect(pointers.setBiographyId).not.toHaveBeenCalled(); expect(data.active).toEqual([]);
  if (event !== 'unmount') expect(wrapper.find('[data-testid="draft"]').exists()).toBe(false);
});
