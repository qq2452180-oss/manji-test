import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import HistoryPage from '../src/pages/HistoryPage.vue';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(), getCurrentUser: vi.fn(), getSession: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const photo = { props: ['mediaId'], template: '<button class="material-photo" :data-media-id="mediaId">照片</button>' };
const render = () => mount(HistoryPage, { global: { stubs: { PrivatePhoto: photo } } });
const session = overrides => ({ session_id: 'session-1', flow_version: 'interview', status: 'ACTIVE', mode: 'GENERAL', started_at: '2026-10-08T12:00:00', turns: [], ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function visibility(hidden) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
  await nextTick();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  history.replaceState(null, '', '/web2/history.html?session_id=session-1');
  api.getAuthToken.mockReturnValue('test-token');
  api.getCurrentUser.mockResolvedValue({ user_id: 'test-user' });
});

describe('Vue saved interview history', () => {
  it('shows every restored resume question at its original call boundary', async () => {
    api.getSession.mockResolvedValue(session({ resume_openings: [
      { call_id: 'first-resume', text: '后来去了哪里？', created_at: '2026-10-19T10:00:00.000100Z' },
      { call_id: 'second-resume', text: '接着讲讲那份工作？', created_at: '2026-10-19T11:00:00.000100Z' },
    ], turns: [
      { turn_id: 'answer-1', sequence_no: 1, user_text: '后来去城里。', assistant_text: '去做什么？',
        realtime_call_id: 'first-resume', call_started_at: '2026-10-19T10:00:00.000100Z', created_at: '2026-10-19T10:00:05Z' },
      { turn_id: 'answer-2', sequence_no: 2, user_text: '在码头工作。', assistant_text: '码头是什么样？',
        realtime_call_id: 'second-resume', call_started_at: '2026-10-19T11:00:00.000100Z', created_at: '2026-10-19T11:00:05Z' },
    ] }));
    const wrapper = render(); await flushPromises();
    expect(wrapper.findAll('.chat-bubble').map(node => node.text())).toEqual([
      '后来去了哪里？', '后来去城里。', '去做什么？', '接着讲讲那份工作？', '在码头工作。', '码头是什么样？',
    ]);
    wrapper.unmount();
  });

  it('shows only saved turns in sequence, preserving image-only turns and uncertain RTC playback', async () => {
    api.getSession.mockResolvedValue(session({ opening_assistant_text: '从哪里说起？', turns: [
      { turn_id: 'second', sequence_no: 2, user_text: '后来的经历', assistant_text: '后来的回复' },
      { turn_id: 'foreign', session_id: 'another-session', sequence_no: 0, user_text: '其他会话的秘密' },
      { turn_id: 'first', sequence_no: 1, user_text: '', photos: [{ media_id: 'photo-2' }, { media_id: 'photo-1' }], media_ids: ['photo-1'], assistant_text: '照片里是谁？', response_state: 'GENERATED', realtime_call_id: 'call-1' },
    ] }));
    const wrapper = render();
    await flushPromises();
    const messages = wrapper.findAll('.chat-message');
    expect(messages).toHaveLength(5);
    expect(messages[0].text()).toContain('从哪里说起？');
    expect(messages[1].classes()).toContain('from-user');
    expect(messages[1].find('.chat-bubble').exists()).toBe(false);
    expect(messages[1].findAll('.material-photo').map(node => node.attributes('data-media-id'))).toEqual(['photo-2', 'photo-1']);
    expect(messages[2].text()).toContain('照片里是谁？');
    expect(messages[2].text()).toContain('回复已生成，播放情况未确认');
    expect(messages[3].text()).toContain('后来的经历');
    expect(wrapper.text()).not.toContain('其他会话的秘密');
    expect(wrapper.get('.transcript-footnote').text()).toContain('已经保存');
  });

  it.each([
    [{ status: 'ACTIVE', flow_version: 'interview' }, '继续聊', './interview.html?session_id=session-1'],
    [{ status: 'COMPLETED', flow_version: 'interview' }, '查看整理结果', './organizing.html?session_id=session-1'],
    [{ status: 'ACTIVE', activity_state: 'FINISHING', flow_version: 'interview' }, '查看整理结果', './organizing.html?session_id=session-1'],
    [{ status: 'ACTIVE', flow_version: 'legacy' }, null, null],
  ])('offers only the appropriate next step for %j', async (state, label, href) => {
    api.getSession.mockResolvedValue(session(state));
    const wrapper = render();
    await flushPromises();
    const links = wrapper.findAll('.paper-footer a');
    if (label) {
      expect(links[0].text()).toBe(label);
      expect(links[0].attributes('href')).toBe(href);
      expect(links).toHaveLength(2);
    } else {
      expect(links).toHaveLength(1);
      expect(links[0].text()).toBe('返回首页');
    }
  });

  it('rejects a response for another session and retries without exposing its text', async () => {
    api.getSession.mockResolvedValueOnce(session({ session_id: 'other', opening_assistant_text: '不该出现' })).mockResolvedValueOnce(session({ opening_assistant_text: '我的记录' }));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain('访谈记录不完整');
    expect(wrapper.text()).not.toContain('不该出现');
    await wrapper.get('button.paper-link').trigger('click');
    await flushPromises();
    expect(api.getSession).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('我的记录');
  });

  it('clears saved photos and text when hidden, then ignores a pending response after the account changes', async () => {
    api.getSession.mockResolvedValueOnce(session({ turns: [{ turn_id: 't1', user_text: '私人讲述', media_ids: ['private-photo'] }] }));
    const pending = deferred();
    api.getSession.mockReturnValueOnce(pending.promise);
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain('私人讲述');
    expect(wrapper.find('.material-photo').exists()).toBe(true);
    await visibility(true);
    expect(wrapper.text()).not.toContain('私人讲述');
    expect(wrapper.find('.material-photo').exists()).toBe(false);
    await visibility(false);
    await flushPromises();
    api.getAuthToken.mockReturnValue('other-token');
    window.dispatchEvent(new Event('manji:auth-changed'));
    pending.resolve(session({ opening_assistant_text: '迟到的私人记录' }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('迟到的私人记录');
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Fhistory.html%3Fsession_id%3Dsession-1', { replace: true });
    await visibility(false);
    await flushPromises();
    expect(api.getSession).toHaveBeenCalledTimes(2);
  });

  it('requires login before requesting private session history', async () => {
    api.getAuthToken.mockReturnValue(null);
    render();
    await flushPromises();
    expect(api.getCurrentUser).not.toHaveBeenCalled();
    expect(api.getSession).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Fhistory.html%3Fsession_id%3Dsession-1', { replace: true });
  });

  it('discards an initial history response completed in a hidden tab and fetches again when visible', async () => {
    const pending = deferred();
    api.getSession.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(session({ status: 'COMPLETED', opening_assistant_text: '重新加载的记录' }));
    const wrapper = render();
    await flushPromises();
    await visibility(true);
    pending.resolve(session({ opening_assistant_text: '不该展示的迟到记录', turns: [{ media_ids: ['hidden-photo'] }] }));
    await flushPromises();
    expect(wrapper.find('.chat-message').exists()).toBe(false);
    expect(wrapper.find('.material-photo').exists()).toBe(false);
    expect(wrapper.get('.transcript-meta').text()).toBe('');
    expect(wrapper.findAll('.paper-footer a')).toHaveLength(1);
    await visibility(false);
    await flushPromises();
    expect(wrapper.text()).toContain('重新加载的记录');
    expect(wrapper.findAll('.paper-footer a')[0].text()).toBe('查看整理结果');
  });
});
