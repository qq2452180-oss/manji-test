import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { h } from 'vue';
import ConnectedAccessGate from '../src/components/ConnectedAccessGate.vue';
import ConnectedLoginPage from '../src/pages/ConnectedLoginPage.vue';
import ConnectedUtilityPage from '../src/pages/ConnectedUtilityPage.vue';
import * as api from '../src/lib/api.js';
import { safeNext } from '../src/lib/login-helpers.js';
import { navigate } from '../src/lib/navigation.js';
import { ensureIdentity } from '../src/lib/workflow-api.js';

vi.mock('../src/lib/api.js', async original => ({
  ...(await original()), getCurrentUser: vi.fn(), loginAccount: vi.fn(), registerAccount: vi.fn(), restoreGuest: vi.fn(),
  sendSmsCode: vi.fn(), loginWithSms: vi.fn(),
}));
vi.mock('../src/lib/workflow-api.js', async original => ({ ...(await original()), ensureIdentity: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  history.replaceState(null, '', '/web/login.html?next=%2Fweb%2Fhistory.html%3Fsession_id%3D12');
});
async function fill(wrapper, { confirmation } = {}) {
  await wrapper.get('#account-username').setValue('my_account');
  await wrapper.get('#account-password').setValue('my-password');
  if (confirmation !== undefined) await wrapper.get('#account-confirm').setValue(confirmation);
}

const phone = '13800138000';
const sendButton = '[data-testid="send-code"]';

function chooseMode(wrapper, label) {
  const action = wrapper.findAll('button').find(button => label.test(button.text()));
  expect(action).toBeDefined();
  return action.trigger('click');
}

describe('connected SMS login', () => {
  it('validates the phone and code before calling either SMS endpoint', async () => {
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue('138');
    await wrapper.get(sendButton).trigger('click');
    expect(wrapper.get('#login-phone').attributes('aria-invalid')).toBe('true');
    expect(api.sendSmsCode).not.toHaveBeenCalled();
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get('#login-code').setValue('12');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('#login-code').attributes('aria-invalid')).toBe('true');
    expect(api.loginWithSms).not.toHaveBeenCalled();
  });

  it('uses the returned cooldown and clears the previous code when the phone changes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    api.sendSmsCode.mockResolvedValue({ retry_after: 17, expires_in: 300 });
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    expect(wrapper.find('#account-username').exists()).toBe(false);
    expect(wrapper.get('#login-code').attributes('autocomplete')).toBe('one-time-code');
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get(sendButton).trigger('click'); await flushPromises();
    expect(api.sendSmsCode).toHaveBeenCalledExactlyOnceWith(phone);
    expect(wrapper.get(sendButton).text()).toContain('17');
    expect(wrapper.get(sendButton).element.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(17_000); await flushPromises();
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    await wrapper.get('#login-code').setValue('012345');
    await wrapper.get('#login-phone').setValue('13900139000');
    expect(wrapper.get('#login-code').element.value).toBe('');
    expect(api.loginWithSms).not.toHaveBeenCalled();
  });

  it('allows a failed send to be retried without re-entering the phone', async () => {
    api.sendSmsCode.mockRejectedValueOnce(new api.ApiError('验证码发送失败，请稍后再试', { status: 503 }))
      .mockResolvedValueOnce({ retry_after: 60, expires_in: 300 });
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get(sendButton).trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('发送失败');
    expect(wrapper.get('#login-phone').element.value).toBe(phone);
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    await wrapper.get(sendButton).trigger('click'); await flushPromises();
    expect(wrapper.get(sendButton).text()).toContain('60');
    expect(api.sendSmsCode).toHaveBeenCalledTimes(2);
  });

  it('ignores the sending result for a phone that has changed', async () => {
    let accepted;
    api.sendSmsCode.mockReturnValueOnce(new Promise(resolve => { accepted = resolve; }));
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get(sendButton).trigger('click');
    expect(wrapper.get(sendButton).element.disabled).toBe(true);
    await wrapper.get('#login-phone').setValue('13900139000');
    accepted({ retry_after: 60, expires_in: 300 }); await flushPromises();
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('keeps the phone after a bad code and returns to the original record on success', async () => {
    api.loginWithSms.mockRejectedValueOnce(new api.ApiError('验证码错误或已失效，请重新确认', { status: 400 }))
      .mockResolvedValueOnce({});
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get('#login-code').setValue('999999');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('验证码');
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.get('#login-phone').element.value).toBe(phone);
    await wrapper.get('#login-code').setValue('012345');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.loginWithSms).toHaveBeenLastCalledWith(phone, '012345');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/web/history.html?session_id=12', { replace: true });
  });

  it('opens the home page when an existing guest chooses the independent phone account', async () => {
    api.setAuthToken('guest-token');
    api.getCurrentUser.mockResolvedValue({ id: 7, is_guest: true });
    api.loginWithSms.mockResolvedValue({});
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    expect(wrapper.find('#account-confirm').exists()).toBe(true);
    await chooseMode(wrapper, /手机/);
    expect(wrapper.text()).toContain('保留');
    expect(wrapper.text()).toContain('故事');
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get('#login-code').setValue('012345');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.loginWithSms).toHaveBeenCalledExactlyOnceWith(phone, '012345');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/web/index.html', { replace: true });
  });

  it('lets a verified member continue without sending a code', async () => {
    api.setAuthToken('member-token');
    api.getCurrentUser.mockResolvedValue({ id: 7, is_guest: false });
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    const link = wrapper.findAll('a').find(anchor => anchor.text().includes('继续使用'));
    expect(link.attributes('href')).toBe('/web/history.html?session_id=12');
    expect(api.sendSmsCode).not.toHaveBeenCalled();
  });
});

describe('connected account entry', () => {
  it('logs in through the existing helper and returns to the original saved record', async () => {
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    await chooseMode(wrapper, /^账号密码登录$/);
    await fill(wrapper);
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.loginAccount).toHaveBeenCalledExactlyOnceWith('my_account', 'my-password');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/web/history.html?session_id=12', { replace: true });
    expect(api.registerAccount).not.toHaveBeenCalled();
  });

  it('defaults a guest to registering the same identity and returns to the original page', async () => {
    api.setAuthToken('guest-token');
    api.getCurrentUser.mockResolvedValue({ id: 7, is_guest: true });
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    expect(wrapper.text()).toContain('都会保留在你的账号里');
    await fill(wrapper, { confirmation: 'my-password' });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.registerAccount).toHaveBeenCalledExactlyOnceWith('my_account', 'my-password');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/web/history.html?session_id=12', { replace: true });
  });

  it('does not register when confirmation differs', async () => {
    history.replaceState(null, '', '/web/login.html?mode=register');
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises(); await fill(wrapper, { confirmation: 'different' });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('两次输入的密码不一致');
    expect(api.registerAccount).not.toHaveBeenCalled();
  });

  it('preserves the guest after bad credentials and explains existing-account separation', async () => {
    api.setAuthToken('guest-token');
    api.getCurrentUser.mockResolvedValue({ id: 7, is_guest: true });
    api.loginAccount.mockRejectedValue(new api.ApiError('账号或密码不正确', { status: 401 }));
    history.replaceState(null, '', '/web/login.html?mode=login&next=%2Fweb%2Fhistory.html%3Fsession_id%3D12');
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises(); await fill(wrapper);
    expect(wrapper.text()).toContain('旧记录不会自动合并');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('账号或密码不正确');
    expect(api.getAuthToken()).toBe('guest-token');
    expect(navigate).not.toHaveBeenCalled();
    api.loginAccount.mockResolvedValue({});
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.loginAccount).toHaveBeenLastCalledWith('my_account', 'my-password');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/web/index.html', { replace: true });
  });

  it('offers login after registration succeeds but automatic login fails', async () => {
    history.replaceState(null, '', '/web/login.html?mode=register');
    api.registerAccount.mockRejectedValue(new api.ApiError('账号已创建，请登录。', { code: 'REGISTRATION_LOGIN_REQUIRED' }));
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises(); await fill(wrapper, { confirmation: 'my-password' });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.find('#account-confirm').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain('账号已创建');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('waits for identity verification and allows retry on a network failure', async () => {
    api.setAuthToken('guest-token');
    api.getCurrentUser.mockRejectedValueOnce(new Error('暂时无法连接'));
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法连接');
    api.getCurrentUser.mockResolvedValue({ id: 7, is_guest: true });
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises();
    expect(wrapper.find('#account-confirm').exists()).toBe(true);
  });

  it('ignores a late login result after leaving the page', async () => {
    history.replaceState(null, '', '/web/login.html?mode=login');
    let finish;
    api.loginAccount.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises(); await fill(wrapper);
    await wrapper.get('form').trigger('submit');
    wrapper.unmount(); finish({}); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('signs out a member through the access gate without returning to a guest experience', async () => {
    history.replaceState(null, '', '/web/profile.html');
    api.setAuthToken('member-token');
    api.getCurrentUser.mockResolvedValue({ id: 7, is_guest: false });
    ensureIdentity.mockResolvedValue({ user_id: 7, is_guest: false });
    const wrapper = mount(ConnectedAccessGate, { slots: { default: () => h(ConnectedUtilityPage) } });
    await flushPromises();
    expect(wrapper.text()).toContain('已登录');
    expect(wrapper.text()).not.toContain('注册并保留我的故事');
    expect(wrapper.find('[data-testid="restart-experience"]').exists()).toBe(false);
    ensureIdentity.mockRejectedValue(new api.ApiError('请先登录', { status: 401 }));
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(api.getAuthToken()).toBe('');
    expect(wrapper.findComponent(ConnectedUtilityPage).exists()).toBe(false);
    expect(api.restoreGuest).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./login.html?next=%2Fweb%2Fprofile.html', { replace: true });
  });
});

describe('connected login return address', () => {
  it.each(['https://outside.test/web/index.html', '//outside.test/web/index.html', '/api/auth/me', '/web/login.html', '/web2/story.html', '/web/../api/home', '/web/story.html\n'])('rejects an unsafe or unsupported next address: %s', value => {
    expect(safeNext(value, 'http://localhost', '/web/')).toBe('/web/index.html');
  });
  it('accepts only the connected page and keeps its query', () => {
    expect(safeNext('/web/interview.html?session_id=12&mode=voice', 'http://localhost', '/web/')).toBe('/web/interview.html?session_id=12&mode=voice');
    expect(safeNext('/web2/history.html', 'http://localhost')).toBe('/web2/history.html');
  });
});
