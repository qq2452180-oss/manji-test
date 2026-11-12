import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LoginPage from '../src/pages/LoginPage.vue';
import * as api from '../src/lib/api.js';
import { finishFirstVisit, firstVisitReturnUrl } from '../src/lib/first-visit.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/api.js', () => ({
  getAuthToken: vi.fn(() => 'existing-real-account-token'),
  getCurrentUser: vi.fn(),
  setAuthToken: vi.fn(),
}));
vi.mock('../src/lib/first-visit.js', () => ({ finishFirstVisit: vi.fn(), firstVisitReturnUrl: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const request = vi.fn();
const stored = () => ({ session: { ...sessionStorage }, local: { ...localStorage } });
const render = async () => { const page = mount(LoginPage); await flushPromises(); return page; };
const visibility = async hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
  await flushPromises();
};
let originalStorage;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_STATIC_PREVIEW', 'true');
  vi.stubGlobal('fetch', request);
  history.replaceState({}, '', '/html/login.html?debug=1&trial=1&next=%2Fweb2%2Findex.html');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  sessionStorage.setItem('manji.auth_token', 'existing-real-account-token');
  sessionStorage.setItem('manji.web2.welcome.flow.v1', 'existing-welcome-flow');
  localStorage.setItem('manji.web2.welcome.seen.v1', 'existing-welcome-marker');
  originalStorage = stored();
});

afterEach(() => {
  expect(api.getAuthToken).not.toHaveBeenCalled();
  expect(api.getCurrentUser).not.toHaveBeenCalled();
  expect(api.setAuthToken).not.toHaveBeenCalled();
  expect(finishFirstVisit).not.toHaveBeenCalled();
  expect(firstVisitReturnUrl).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(stored()).toEqual(originalStorage);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('static phone login isolation', () => {
  it('returns to the static map and hides real-account controls even with debug and protected next parameters', async () => {
    const page = await render();
    expect(page.get('a.login-back').text()).toContain('返回人生轨迹');
    expect(page.get('a.login-back').attributes('href')).toBe('./index.html');
    expect(page.get('[data-testid="send-code"]').element.disabled).toBe(false);
    expect(page.find('.member-account-note').exists()).toBe(false);
    expect(page.find('.guest-account-note').exists()).toBe(false);
    expect(page.find('.developer-login').exists()).toBe(false);
    expect(page.find('[data-testid="developer-login-form"]').exists()).toBe(false);
    expect(page.find('#login-token').exists()).toBe(false);
    page.unmount();
  });

  it('keeps the local phone/code flow through real-account events and tab hiding without consulting account state', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const page = await render();
    await page.get('#login-phone').setValue('13800138000');
    await page.get('[data-testid="send-code"]').trigger('click');
    expect(page.get('#demo-code-hint').text()).toContain('123456');
    expect(page.get('[data-testid="send-code"]').element.disabled).toBe(true);
    await page.get('#login-code').setValue('123456');
    window.dispatchEvent(new Event('manji:auth-changed'));
    await flushPromises();
    expect(page.get('#login-phone').element.value).toBe('13800138000');
    expect(page.get('#login-code').element.value).toBe('123456');
    await visibility(true);
    vi.setSystemTime(Date.now() + 65_000);
    await visibility(false);
    expect(page.get('[data-testid="send-code"]').element.disabled).toBe(false);
    await page.get('[data-testid="account-form"]').trigger('submit');
    await flushPromises();
    expect(page.get('[data-testid="login-success"]').text()).toContain('验证完成');
    expect(page.get('[data-testid="prototype-home"]').attributes('href')).toBe('./index.html?prototype=1');
    await page.get('[data-testid="restart-demo"]').trigger('click');
    expect(page.find('[data-testid="login-success"]').exists()).toBe(false);
    expect(page.get('#login-code').element.value).toBe('');
    expect(page.get('[data-testid="send-code"]').element.disabled).toBe(false);
    page.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still validates the phone and expiration locally and permits a fresh code after expiration', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const page = await render();
    await page.get('#login-phone').setValue('12345');
    await page.get('[data-testid="send-code"]').trigger('click');
    expect(page.get('#login-error').text()).toContain('手机号');
    await page.get('#login-phone').setValue('13800138000');
    await page.get('[data-testid="send-code"]').trigger('click');
    await vi.advanceTimersByTimeAsync(300_001);
    await page.get('#login-code').setValue('123456');
    await page.get('[data-testid="account-form"]').trigger('submit');
    expect(page.get('#login-error').text()).toContain('过期');
    expect(page.find('[data-testid="login-success"]').exists()).toBe(false);
    await page.get('[data-testid="send-code"]').trigger('click');
    await page.get('#login-code').setValue('123456');
    await page.get('[data-testid="account-form"]').trigger('submit');
    await flushPromises();
    expect(page.get('[data-testid="login-success"]').text()).toContain('验证完成');
    page.unmount();
  });
});
