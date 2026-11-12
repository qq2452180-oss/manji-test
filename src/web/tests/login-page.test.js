import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LoginPage from '../src/pages/LoginPage.vue';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';
import { markWelcomeShown, finishFirstVisit } from '../src/lib/first-visit.js';

const auth = vi.hoisted(() => ({ token: '' }));
vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(() => auth.token), getCurrentUser: vi.fn(), registerAccount: vi.fn(), loginAccount: vi.fn(), setAuthToken: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fillPhone = async (wrapper, phone = '13800138000') => wrapper.get('#login-phone').setValue(phone);
const sendCode = async wrapper => { await wrapper.get('[data-testid="send-code"]').trigger('click'); await flushPromises(); };
const alerts = wrapper => wrapper.findAll('[role="alert"]').map(node => node.text()).join(' ');
const visibility = async hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
};
const render = async () => { const wrapper = mount(LoginPage); await flushPromises(); return wrapper; };
const fakeTime = () => vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
const submit = async wrapper => { await wrapper.get('[data-testid="account-form"]').trigger('submit'); await flushPromises(); };
const guestPage = async () => { auth.token = 'guest-token'; api.getCurrentUser.mockResolvedValue({ id: 'guest-a', is_guest: true }); const wrapper = mount(LoginPage); await flushPromises(); return wrapper; };
beforeEach(() => {
  auth.token = ''; history.replaceState({}, '', '/web2/login.html');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  api.getCurrentUser.mockReset().mockResolvedValue({ id: 'member-a', is_guest: false });
  const complete = async () => { auth.token = 'member-token'; window.dispatchEvent(new Event('manji:auth-changed')); return { token: auth.token, user: { id: 'member-a', is_guest: false } }; };
  api.loginAccount.mockReset().mockImplementation(complete); api.registerAccount.mockReset().mockImplementation(complete);
});

describe('phone login prototype', () => {
  it('returns an anonymous visitor to welcome even when trial or a protected next URL is supplied', async () => {
    history.replaceState({}, '', '/web2/login.html?trial=1&next=%2Fweb2%2Findex.html');
    const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.get('a.login-back').attributes('href')).toBe('./welcome.html');
    expect(wrapper.get('a.login-back').text()).toContain('返回欢迎页');
    expect(wrapper.find('.member-account-note').exists()).toBe(false);
  });

  it('only offers an experience preview after confirming a guest identity', async () => {
    auth.token = 'guest-token'; const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
    const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.find('a.login-back').exists()).toBe(false);
    pending.resolve({ id: 'guest-a', is_guest: true }); await flushPromises();
    expect(wrapper.get('a.login-back').attributes('href')).toBe('./biography.html');
    expect(wrapper.get('a.login-back').text()).toContain('返回体验预览');
    expect(wrapper.get('.guest-account-note').text()).toContain('体验');
  });

  it('does not infer guest access from a trial flag after the credential expires', async () => {
    history.replaceState({}, '', '/web2/login.html?trial=1'); auth.token = 'expired';
    api.getCurrentUser.mockImplementation(async () => { auth.token = ''; throw { status: 401 }; });
    const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.find('a.login-back').exists()).toBe(false);
    expect(wrapper.find('.guest-account-note').exists()).toBe(false);
  });

  it('explains an existing signed-in session instead of presenting its return as a login bypass', async () => {
    history.replaceState({}, '', '/web2/login.html?trial=1'); auth.token = 'member-token';
    api.getCurrentUser.mockResolvedValue({ id: 'member-a', is_guest: false, username: 'xiaoli' });
    const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.get('.member-account-note').text()).toContain('您已登录：xiaoli');
    expect(wrapper.get('.member-account-note a').attributes('href')).toBe('/web2/');
    expect(wrapper.get('a.login-back').text()).toContain('已登录账号');
    expect(wrapper.find('#login-confirmation').exists()).toBe(false);
  });

  it('removes the signed-in return destination when the current account is cleared', async () => {
    auth.token = 'member-token'; const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.find('.member-account-note').exists()).toBe(true);
    auth.token = ''; window.dispatchEvent(new Event('manji:auth-changed')); await flushPromises();
    expect(wrapper.find('.member-account-note').exists()).toBe(false);
    expect(wrapper.find('a.login-back').exists()).toBe(false);
  });

  it('keeps a first-time visitor on the account form after welcome has been shown', async () => {
    markWelcomeShown();
    const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.find('a.login-back').exists()).toBe(false);
    expect(wrapper.get('[data-testid="account-form"]').exists()).toBe(true);
  });

  it('does not offer a welcome link that would loop a returning anonymous visitor back to login', async () => {
    markWelcomeShown(); finishFirstVisit();
    const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.find('a.login-back').exists()).toBe(false);
    expect(wrapper.get('[data-testid="account-form"]').exists()).toBe(true);
  });

  it('does not show a member response that arrives after the login page is hidden', async () => {
    auth.token = 'member-token'; const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
    const wrapper = mount(LoginPage); await flushPromises();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    pending.resolve({ id: 'member-a', is_guest: false, username: 'private-name' }); await flushPromises();
    expect(wrapper.find('.member-account-note').exists()).toBe(false);
    expect(wrapper.find('a.login-back').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('private-name');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(wrapper.get('.member-account-note').text()).toContain('private-name');
  });

  it('clears an already verified account prompt when the page becomes hidden', async () => {
    auth.token = 'member-token'; const wrapper = mount(LoginPage); await flushPromises();
    expect(wrapper.find('.member-account-note').exists()).toBe(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(wrapper.find('.member-account-note').exists()).toBe(false);
    expect(wrapper.find('a.login-back').exists()).toBe(false);
  });

  it('shows phone and code fields without passwords or developer controls', async () => {
    const wrapper = await render();
    expect(wrapper.get('#login-phone').attributes('type')).toBe('tel');
    expect(wrapper.get('#login-phone').attributes('inputmode')).toBe('numeric');
    expect(wrapper.get('#login-code').attributes('autocomplete')).toBe('one-time-code');
    expect(wrapper.find('#login-password').exists()).toBe(false);
    expect(wrapper.find('.account-modes').exists()).toBe(false);
    expect(wrapper.find('.developer-login').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('原型');
    expect(wrapper.text()).toContain('验证码显示在本页，无需查看短信。');
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it.each(['', '12345', '12800138000'])('rejects an invalid phone before issuing a demo code: %s', async phone => {
    const wrapper = await render(); await fillPhone(wrapper, phone); await sendCode(wrapper);
    expect(alerts(wrapper)).toMatch(/手机|号码/);
    expect(wrapper.get('[data-testid="send-code"]').text()).not.toContain('60');
    expect(api.loginAccount).not.toHaveBeenCalled(); expect(api.registerAccount).not.toHaveBeenCalled();
  });

  it('shows the demo code and permits another request only after 60 seconds', async () => {
    fakeTime();
    const wrapper = await render(); await fillPhone(wrapper); await sendCode(wrapper);
    expect(wrapper.text()).toContain('本次验证码');
    expect(wrapper.text()).toContain('123456');
    expect(wrapper.get('[data-testid="send-code"]').text()).toContain('60');
    expect(wrapper.get('[data-testid="send-code"]').element.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(wrapper.get('[data-testid="send-code"]').text()).toContain('1');
    await sendCode(wrapper);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="send-code"]').element.disabled).toBe(false);
    await sendCode(wrapper);
    expect(wrapper.get('[data-testid="send-code"]').text()).toContain('60');
  });

  it('uses elapsed time when returning from a background tab', async () => {
    fakeTime();
    const wrapper = await render(); await fillPhone(wrapper); await sendCode(wrapper);
    await visibility(true); vi.setSystemTime(Date.now() + 65_000); await visibility(false);
    expect(wrapper.get('[data-testid="send-code"]').element.disabled).toBe(false);
  });

  it('requires requesting a code before accepting even the known demo code', async () => {
    const wrapper = await render(); await fillPhone(wrapper);
    await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(alerts(wrapper)).toMatch(/获取|验证码/);
    expect(wrapper.find('[data-testid="login-success"]').exists()).toBe(false);
    expect(api.setAuthToken).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['', '123', '654321'])('rejects an empty, short or incorrect code and supports correction: %s', async code => {
    const wrapper = await render(); await fillPhone(wrapper); await sendCode(wrapper);
    await wrapper.get('#login-code').setValue(code); await submit(wrapper);
    expect(alerts(wrapper)).toMatch(/验证码/);
    expect(wrapper.find('[data-testid="login-success"]').exists()).toBe(false);
    await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(wrapper.get('[data-testid="login-success"]').text()).toContain('验证完成');
    expect(api.loginAccount).not.toHaveBeenCalled(); expect(api.registerAccount).not.toHaveBeenCalled();
    expect(api.setAuthToken).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });

  it('invalidates the code when the phone changes and permits a fresh request', async () => {
    const wrapper = await render(); await fillPhone(wrapper); await sendCode(wrapper);
    await wrapper.get('#login-code').setValue('123456'); await fillPhone(wrapper, '13900139000');
    expect(wrapper.get('#login-code').element.value).toBe('');
    expect(wrapper.get('[data-testid="send-code"]').element.disabled).toBe(false);
    await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(wrapper.find('[data-testid="login-success"]').exists()).toBe(false);
    await sendCode(wrapper); await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(wrapper.get('[data-testid="login-success"]').text()).toContain('验证完成');
  });

  it('expires the code after five minutes and permits a new code', async () => {
    fakeTime();
    const wrapper = await render(); await fillPhone(wrapper); await sendCode(wrapper);
    await vi.advanceTimersByTimeAsync(300_001);
    await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(alerts(wrapper)).toMatch(/过期|失效/);
    expect(wrapper.find('[data-testid="login-success"]').exists()).toBe(false);
    await sendCode(wrapper); await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(wrapper.get('[data-testid="login-success"]').text()).toContain('验证完成');
  });

  it('demonstrates success without changing a real guest or saving the phone and code', async () => {
    const wrapper = await guestPage();
    const sessionBefore = { ...sessionStorage }, localBefore = { ...localStorage };
    await fillPhone(wrapper); await sendCode(wrapper); await wrapper.get('#login-code').setValue('123456'); await submit(wrapper);
    expect(wrapper.get('[data-testid="login-success"]').text()).toContain('验证完成');
    expect(wrapper.get('[data-testid="prototype-home"]').attributes('href')).toBe('./index.html?prototype=1');
    expect(auth.token).toBe('guest-token'); expect(api.setAuthToken).not.toHaveBeenCalled();
    expect(api.loginAccount).not.toHaveBeenCalled(); expect(api.registerAccount).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect({ ...sessionStorage }).toEqual(sessionBefore); expect({ ...localStorage }).toEqual(localBefore);
    await wrapper.get('[data-testid="restart-demo"]').trigger('click');
    expect(wrapper.find('[data-testid="login-success"]').exists()).toBe(false);
    expect(wrapper.get('#login-code').element.value).toBe('');
    expect(wrapper.get('[data-testid="send-code"]').element.disabled).toBe(false);
  });

  it('retains safe return links for an already verified member', async () => {
    auth.token = 'member-token';
    history.replaceState({}, '', '/web2/login.html?next=https%3A%2F%2Foutside.test%2F');
    const wrapper = await render();
    expect(wrapper.get('.member-account-note a').attributes('href')).toBe('/web2/index.html');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps identity failures retryable without changing the account', async () => {
    auth.token = 'guest-token'; api.getCurrentUser.mockRejectedValueOnce({ code: 'NETWORK_ERROR' });
    const wrapper = await render();
    expect(wrapper.get('.account-check-error').text()).toContain('重试');
    expect(wrapper.get('.account-submit').element.disabled).toBe(true);
    api.getCurrentUser.mockResolvedValue({ id: 'guest-a', is_guest: true });
    await wrapper.get('.account-check-error button').trigger('click'); await flushPromises();
    expect(wrapper.get('.account-submit').element.disabled).toBe(false);
    expect(auth.token).toBe('guest-token'); expect(api.setAuthToken).not.toHaveBeenCalled();
  });

  it('does not display a stale verified member after another account is selected', async () => {
    auth.token = 'old-token'; const pending = deferred(); api.getCurrentUser.mockReturnValueOnce(pending.promise);
    const wrapper = await render();
    auth.token = 'new-token'; api.getCurrentUser.mockResolvedValue({ id: 'new', is_guest: false, username: 'current-account' });
    window.dispatchEvent(new Event('manji:auth-changed')); await flushPromises();
    pending.resolve({ id: 'old', is_guest: false, username: 'private-old-account' }); await flushPromises();
    expect(wrapper.text()).toContain('current-account'); expect(wrapper.text()).not.toContain('private-old-account');
  });

  it('cleans up the countdown when leaving the page', async () => {
    fakeTime();
    const wrapper = await render(); await fillPhone(wrapper); await sendCode(wrapper);
    expect(vi.getTimerCount()).toBeGreaterThan(0); wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(navigate).not.toHaveBeenCalled(); expect(api.setAuthToken).not.toHaveBeenCalled();
  });
});
