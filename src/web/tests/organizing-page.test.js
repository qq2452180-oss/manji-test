import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import OrganizingPage from '../src/pages/OrganizingPage.vue';
import * as api from '../src/lib/api.js';
import * as state from '../src/lib/app-state.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(), getCurrentUser: vi.fn(), getOrganization: vi.fn(), retryOrganization: vi.fn() }));
vi.mock('../src/lib/app-state.js', () => ({ setOrganizationSessionId: vi.fn(), clearOrganizationSessionId: vi.fn(), removeActiveSessionId: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const render = () => mount(OrganizingPage);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const button = (wrapper, label) => wrapper.findAll('button').find(node => node.text() === label);
async function poll() { await vi.advanceTimersByTimeAsync(2500); await flushPromises(); }
async function visibility(hidden) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
  await nextTick();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  history.replaceState(null, '', '/web2/organizing.html?session_id=session-1');
  api.getAuthToken.mockReturnValue('test-token');
  api.getCurrentUser.mockResolvedValue({ user_id: 'test-user' });
});

describe('Vue story organization progress', () => {
  it('returns a guest result to the existing story preview without suggesting member home access', async () => {
    api.getCurrentUser.mockResolvedValue({ id: 'guest', is_guest: true });
    api.getOrganization.mockResolvedValue({ status: 'SUCCEEDED', story_id: 'trial-story', title: '第一篇故事' });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.quiet-action').text()).toBe('返回体验预览');
    expect(wrapper.get('.quiet-action').attributes('href')).toBe('./biography.html');
    expect(wrapper.find('a[href="./index.html"]').exists()).toBe(false);
    expect(wrapper.get('a.primary-action').attributes('href')).toBe('./story.html?id=trial-story');
  });

  it('polls while final material is saving, then treats no material as terminal without retrying', async () => {
    api.getOrganization.mockResolvedValueOnce({ status: 'FINISHING', phase: 'FINISHING' }).mockResolvedValue({ status: 'FAILED', error_code: 'NO_MATERIAL', retry_allowed: false });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('working');
    expect(wrapper.text()).toContain('正在确认最后的文字');
    await poll();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('empty');
    expect(wrapper.text()).toContain('下次再接着聊');
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(state.clearOrganizationSessionId).toHaveBeenCalledOnce();
    expect(state.removeActiveSessionId).toHaveBeenCalledWith('session-1');
    await poll();
    expect(api.getOrganization).toHaveBeenCalledTimes(2);
    expect(api.retryOrganization).not.toHaveBeenCalled();
  });

  it.each(['MATERIAL_WAITING', 'MATERIAL_CONFLICT', 'MATERIAL_DELAYED', 'REVISING'])('does not expose a previous successful story or material retry while %s', async phase => {
    api.getOrganization.mockResolvedValue({ status: 'SUCCEEDED', phase, story_id: 'old-story', title: '旧结果', material_revision: 2, retry_allowed: true });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('working');
    expect(wrapper.find('a[href*="story.html"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('旧结果');
    expect(button(wrapper, '查看整理结果').attributes('disabled')).toBeDefined();
    expect(button(wrapper, '重试核对')).toBeUndefined();
    expect(api.retryOrganization).not.toHaveBeenCalled();
  });

  it.each(['phase', 'error_code'])('polls delayed material every 30 seconds using %s and shows recovery without a retry click', async field => {
    api.getOrganization.mockResolvedValueOnce({ status: 'FINISHING', [field]: 'MATERIAL_DELAYED', material_revision: 2 })
      .mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'recovered-story', title: '自动恢复后的故事', material_revision: 3 });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('working');
    expect(wrapper.text()).toContain('通话已结束，整理暂未完成，已有记录已保留，系统会自动继续处理。');
    expect(button(wrapper, '重试核对')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(29999); await flushPromises();
    expect(api.getOrganization).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('done');
    expect(wrapper.text()).toContain('自动恢复后的故事');
    expect(api.retryOrganization).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 408, 429, 503])('resumes progress polling automatically after a temporary error with status %s', async status => {
    api.getOrganization.mockRejectedValueOnce(Object.assign(new Error('暂时连接不上后端'), { status }))
      .mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'recovered-story', title: '恢复后的故事' });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('working');
    expect(wrapper.text()).toContain('系统会自动继续查询');
    await vi.advanceTimersByTimeAsync(29999); await flushPromises();
    expect(api.getOrganization).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('done');
    expect(wrapper.text()).toContain('恢复后的故事');
    expect(api.retryOrganization).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 422])('stops polling when the server rejects the progress request with status %s', async status => {
    api.getOrganization.mockRejectedValue(Object.assign(new Error('无法查看该记录'), { status }));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('error');
    await vi.advanceTimersByTimeAsync(60000); await flushPromises();
    expect(api.getOrganization).toHaveBeenCalledOnce();
  });

  it('ignores an older revision arriving later and links only to the up-to-date successful story', async () => {
    api.getOrganization.mockResolvedValueOnce({ status: 'SUCCEEDED', phase: 'REVISING', story_id: 'old', material_revision: 3 })
      .mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'stale', title: '过期结果', material_revision: 2 })
      .mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'new/result', title: '当前故事', material_revision: 3, error_code: 'STORY_REVISION_AVAILABLE' });
    const wrapper = render();
    await flushPromises();
    await poll();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('working');
    expect(wrapper.text()).not.toContain('过期结果');
    expect(wrapper.find('a[href*="story.html"]').exists()).toBe(false);
    await poll();
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('done');
    expect(wrapper.get('a.primary-action').attributes('href')).toBe('./story.html?id=new%2Fresult');
    expect(wrapper.text()).toContain('当前故事');
    expect(wrapper.text()).toContain('您修改过的内容已保留');
    expect(state.removeActiveSessionId).toHaveBeenCalledWith('session-1');
  });

  it('retries a failed job only after an explicit click and disables repeat submission', async () => {
    api.getOrganization.mockResolvedValue({ status: 'FAILED', error_message: '稍后可以重新整理' });
    const pending = deferred();
    api.retryOrganization.mockReturnValue(pending.promise);
    const wrapper = render();
    await flushPromises();
    await poll();
    expect(api.getOrganization).toHaveBeenCalledOnce();
    expect(api.retryOrganization).not.toHaveBeenCalled();
    await button(wrapper, '重新整理').trigger('click');
    await flushPromises();
    expect(api.retryOrganization).toHaveBeenCalledWith('session-1');
    expect(wrapper.get('[data-phase]').attributes('data-phase')).toBe('working');
    expect(button(wrapper, '刷新进度').attributes('disabled')).toBeDefined();
    pending.resolve({ status: 'SUCCEEDED', story_id: 'new-story', title: '重试后的故事' });
    await flushPromises();
    expect(wrapper.text()).toContain('重试后的故事');
    expect(api.retryOrganization).toHaveBeenCalledOnce();
  });

  it('keeps a non-retryable material issue visible without presenting the retry button', async () => {
    api.getOrganization.mockResolvedValue({ status: 'SUCCEEDED', phase: 'MATERIAL_CONFLICT', retry_allowed: false, error_message: '材料已经保存，请稍候核对' });
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain('材料已经保存，请稍候核对');
    expect(button(wrapper, '重试核对')).toBeUndefined();
    expect(button(wrapper, '刷新进度')).toBeDefined();
  });

  it('clears private results while hidden, cancels polling, and ignores late results after account change', async () => {
    api.getOrganization.mockResolvedValueOnce({ status: 'SUCCEEDED', story_id: 'private-story', title: '私人故事标题' });
    const pending = deferred();
    api.getOrganization.mockReturnValueOnce(pending.promise);
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain('私人故事标题');
    await visibility(true);
    expect(wrapper.text()).not.toContain('私人故事标题');
    expect(wrapper.find('a[href*="story.html"]').exists()).toBe(false);
    await poll();
    expect(api.getOrganization).toHaveBeenCalledOnce();
    await visibility(false);
    await flushPromises();
    api.getAuthToken.mockReturnValue('other-token');
    window.dispatchEvent(new Event('manji:auth-changed'));
    pending.resolve({ status: 'SUCCEEDED', story_id: 'late-story', title: '不应显示的旧账户结果' });
    await flushPromises();
    expect(wrapper.text()).not.toContain('不应显示的旧账户结果');
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Forganizing.html%3Fsession_id%3Dsession-1', { replace: true });
    await visibility(false);
    await poll();
    expect(api.getOrganization).toHaveBeenCalledTimes(2);
  });

  it('does not poll after the document leaves', async () => {
    api.getOrganization.mockResolvedValue({ status: 'RUNNING' });
    const wrapper = render();
    await flushPromises();
    window.dispatchEvent(new Event('pagehide'));
    await nextTick();
    await poll();
    expect(api.getOrganization).toHaveBeenCalledOnce();
    expect(wrapper.find('a[href*="story.html"]').exists()).toBe(false);
  });
});
