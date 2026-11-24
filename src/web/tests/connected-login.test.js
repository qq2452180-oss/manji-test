import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { h } from 'vue';
import { webcrypto } from 'node:crypto';
import ConnectedAccessGate from '../src/components/ConnectedAccessGate.vue';
import ConnectedLoginPage from '../src/pages/ConnectedLoginPage.vue';
import ConnectedUtilityPage from '../src/pages/ConnectedUtilityPage.vue';
import * as api from '../src/lib/api.js';
import { safeNext } from '../src/lib/login-helpers.js';
import { navigate } from '../src/lib/navigation.js';
import { ensureIdentity } from '../src/lib/workflow-api.js';

vi.mock('../src/lib/api.js', async original => ({
  ...(await original()), getCurrentUser: vi.fn(), loginAccount: vi.fn(), registerAccount: vi.fn(), restoreGuest: vi.fn(),
  sendSmsCode: vi.fn(), getSmsCaptcha: vi.fn(), loginWithSms: vi.fn(), logout: vi.fn(),
}));
vi.mock('../src/lib/workflow-api.js', async original => ({ ...(await original()), ensureIdentity: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  api.getCurrentUser.mockRejectedValue(new api.ApiError('请登录', { status: 401 }));
  history.replaceState(null, '', '/web/login.html?next=%2Fweb%2Fhistory.html%3Fsession_id%3D12');
});
async function fill(wrapper, { confirmation } = {}) {
  await wrapper.get('#account-username').setValue('my_account');
  await wrapper.get('#account-password').setValue('my-password');
  if (confirmation !== undefined) await wrapper.get('#account-confirm').setValue(confirmation);
}

const phone = '13800138000';
const sendButton = '[data-testid="send-code"]';

async function sendAndSettle(wrapper) {
  const button = wrapper.get(sendButton);
  await button.trigger('click');
  await vi.waitFor(() => expect(button.text()).not.toBe('发送中…'));
}

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
    expect(wrapper.text()).not.toContain('账号密码登录');
    expect(wrapper.get('#login-code').attributes('autocomplete')).toBe('one-time-code');
    await wrapper.get('#login-phone').setValue(phone);
    await sendAndSettle(wrapper);
    expect(api.sendSmsCode).toHaveBeenCalledExactlyOnceWith(phone);
    expect(wrapper.get(sendButton).text()).toContain('17');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get(sendButton).element.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(17_000); await flushPromises();
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(283_000);
    expect(wrapper.get('[role="status"]').text()).toBe('上次发送的验证码已过期。');
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
    await sendAndSettle(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toContain('发送失败');
    expect(wrapper.get('#login-phone').element.value).toBe(phone);
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    await sendAndSettle(wrapper);
    expect(wrapper.get(sendButton).text()).toContain('60');
    expect(api.sendSmsCode).toHaveBeenCalledTimes(2);
  });

  it('counts down a server rejection without leaving a stale error when it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    api.sendSmsCode.mockRejectedValue(new api.ApiError('验证码请求过于频繁，请稍后再试', {
      status: 429, code: 'SMS_COOLDOWN', details: { retry_after: 12 },
    }));
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await sendAndSettle(wrapper);
    expect(wrapper.get(sendButton).text()).toContain('12 秒');
    expect(wrapper.text()).not.toContain('已发送至');
    await wrapper.get(sendButton).trigger('click');
    expect(api.sendSmsCode).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows the remaining resend time on refresh before a phone is entered and clears it at expiry', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      api.sendSmsCode.mockResolvedValue({ retry_after: 60, expires_in: 300 });
      const wrapper = mount(ConnectedLoginPage); await flushPromises();
      await wrapper.get('#login-phone').setValue(phone);
      await sendAndSettle(wrapper);
      wrapper.unmount();

      await vi.advanceTimersByTimeAsync(20_000);
      const refreshed = mount(ConnectedLoginPage); await flushPromises();
      expect(refreshed.get('#login-phone').element.value).toBe('');
      expect(refreshed.text()).toMatch(/上次.*40\s*秒/);
      expect(refreshed.text()).not.toContain('已发送至');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshed.text()).toMatch(/39\s*秒/);
      await vi.advanceTimersByTimeAsync(39_000);
      expect(refreshed.text()).not.toMatch(/\d+\s*秒/);
      expect(api.sendSmsCode).toHaveBeenCalledExactlyOnceWith(phone);
    } finally { vi.unstubAllGlobals(); }
  });

  it('uses the latest phone for the refresh hint and each entered phone for its own resend state', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      const secondPhone = '13900139000';
      api.sendSmsCode.mockResolvedValueOnce({ retry_after: 60, expires_in: 300 })
        .mockResolvedValueOnce({ retry_after: 15, expires_in: 300 });
      const wrapper = mount(ConnectedLoginPage); await flushPromises();
      await wrapper.get('#login-phone').setValue(phone);
      await sendAndSettle(wrapper);
      await wrapper.get('#login-phone').setValue(secondPhone);
      await sendAndSettle(wrapper);
      wrapper.unmount();

      const refreshed = mount(ConnectedLoginPage); await flushPromises();
      expect(refreshed.text()).toMatch(/上次.*15\s*秒/);
      await refreshed.get('#login-phone').setValue('13700137000');
      expect(refreshed.text()).not.toMatch(/\d+\s*秒/);
      expect(refreshed.get(sendButton).element.disabled).toBe(false);
      await refreshed.get('#login-phone').setValue(phone);
      await vi.waitFor(() => expect(refreshed.get(sendButton).text()).toMatch(/60\s*秒/));
      expect(refreshed.get(sendButton).element.disabled).toBe(true);
      await refreshed.get('#login-phone').setValue(secondPhone);
      await vi.waitFor(() => expect(refreshed.get(sendButton).text()).toMatch(/15\s*秒/));
      refreshed.unmount();

      await vi.advanceTimersByTimeAsync(15_000);
      const later = mount(ConnectedLoginPage); await flushPromises();
      expect(later.text()).not.toMatch(/\d+\s*秒/);
      await later.get('#login-phone').setValue(phone);
      await vi.waitFor(() => expect(later.get(sendButton).text()).toMatch(/45\s*秒/));
      expect(api.sendSmsCode).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('restores a phone quota deadline when the same phone is re-entered after refresh', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      const start = new Date(2026, 1, 3, 22, 55, 0);
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(start);
      api.sendSmsCode.mockRejectedValue(new api.ApiError('已达 24 小时发送上限', {
        status: 429, code: 'SMS_PHONE_LIMIT', details: { retry_after: 2 * 3600 },
      }));
      const wrapper = mount(ConnectedLoginPage); await flushPromises();
      await wrapper.get('#login-phone').setValue(phone);
      await wrapper.get(sendButton).trigger('click');
      await vi.waitFor(() => expect(wrapper.get(sendButton).text()).toBe('已达发送上限'));
      expect(wrapper.get('[role="status"]').text()).toContain('该手机号');
      expect(wrapper.get('[role="status"]').text()).toContain('2月4日');
      expect(JSON.stringify(sessionStorage)).not.toContain(phone);
      wrapper.unmount();
      const refreshed = mount(ConnectedLoginPage); await flushPromises();
      expect(refreshed.text()).toContain('2月4日');
      expect(refreshed.text()).toContain('00:55:');
      await refreshed.get('#login-phone').setValue('13900139000');
      expect(refreshed.get(sendButton).element.disabled).toBe(false);
      expect(refreshed.text()).not.toContain('2月4日');
      await refreshed.get('#login-phone').setValue(phone);
      await vi.waitFor(() => expect(refreshed.get(sendButton).element.disabled).toBe(true));
      expect(refreshed.get('[role="status"]').text()).toContain('00:55:');
      expect(refreshed.text()).not.toContain('已发送至');
      await refreshed.get('#login-code').setValue('012345');
      await refreshed.get('form').trigger('submit'); await flushPromises();
      expect(api.loginWithSms).toHaveBeenCalledExactlyOnceWith(phone, '012345');
      expect(api.sendSmsCode).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ['network limit', 429, 'SMS_IP_LIMIT', 3600],
    ['failed delivery with no retry delay', 503, 'SMS_DELIVERY_FAILED', 0],
  ])('does not show an older phone on refresh after a %s for the latest phone', async (_, status, code, retry_after) => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      api.sendSmsCode.mockResolvedValueOnce({ retry_after: 60, expires_in: 300 })
        .mockRejectedValueOnce(new api.ApiError('发送受限', { status, code, details: { retry_after } }));
      const wrapper = mount(ConnectedLoginPage); await flushPromises();
      await wrapper.get('#login-phone').setValue(phone);
      await sendAndSettle(wrapper);
      await wrapper.get('#login-phone').setValue('13900139000');
      await sendAndSettle(wrapper);
      wrapper.unmount();

      const refreshed = mount(ConnectedLoginPage); await flushPromises();
      expect(refreshed.text()).not.toMatch(/秒后|已达上限/);
      await refreshed.get('#login-phone').setValue(phone);
      await vi.waitFor(() => expect(refreshed.get(sendButton).text()).toContain('秒后重发'));
      expect(api.sendSmsCode).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('displays an IP limit deadline and rechecks the network after a refresh', async () => {
    api.sendSmsCode.mockRejectedValue(new api.ApiError('当前网络已达 24 小时发送上限', {
      status: 429, code: 'SMS_IP_LIMIT', details: { retry_after: 3600 },
    }));
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await sendAndSettle(wrapper);
    expect(wrapper.get(sendButton).text()).toBe('已达发送上限');
    expect(wrapper.get('[role="status"]').text()).toMatch(/当前网络.*可于/);
    wrapper.unmount();
    const refreshed = mount(ConnectedLoginPage); await flushPromises();
    await refreshed.get('#login-phone').setValue(phone);
    api.sendSmsCode.mockResolvedValue({ expires_in: 300, retry_after: 0 });
    await sendAndSettle(refreshed);
    expect(refreshed.get(sendButton).text()).toBe('重新获取');
    expect(refreshed.get(sendButton).element.disabled).toBe(false);
  });

  it('shows the daily limit reached by a successful send', async () => {
    api.sendSmsCode.mockResolvedValue({ expires_in: 300, retry_after: 80000, rate_limit_code: 'SMS_PHONE_LIMIT' });
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await sendAndSettle(wrapper);
    expect(wrapper.get(sendButton).text()).toBe('已达发送上限');
    expect(wrapper.get('[role="status"]').text()).toContain('该手机号近 24 小时');
  });

  it('honors the remaining delay after a provider failure without claiming delivery', async () => {
    api.sendSmsCode.mockRejectedValue(new api.ApiError('验证码发送失败', {
      status: 503, code: 'SMS_DELIVERY_FAILED', details: { retry_after: 41 },
    }));
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await sendAndSettle(wrapper);
    expect(wrapper.get(sendButton).text()).toContain('41 秒');
    expect(wrapper.get('[role="alert"]').text()).toContain('发送失败');
    expect(wrapper.text()).not.toContain('已发送至');
  });

  it('preserves the earlier code when a resend fails and reaches the phone quota', async () => {
    api.sendSmsCode.mockResolvedValueOnce({ expires_in: 300, retry_after: 0 })
      .mockRejectedValueOnce(new api.ApiError('验证码发送失败', {
        status: 503, code: 'SMS_DELIVERY_FAILED', details: { retry_after: 65000, rate_limit_code: 'SMS_PHONE_LIMIT' },
      }));
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await sendAndSettle(wrapper);
    await wrapper.get('#login-code').setValue('012345');
    await sendAndSettle(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toContain('发送失败');
    expect(wrapper.get(sendButton).text()).toBe('已达发送上限');
    expect(wrapper.get('#login-code').element.value).toBe('012345');
  });

  it('ignores the sending result for a phone that has changed', async () => {
    let accepted;
    api.sendSmsCode.mockReturnValueOnce(new Promise(resolve => { accepted = resolve; }));
    const wrapper = mount(ConnectedLoginPage); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get(sendButton).trigger('click');
    expect(wrapper.get(sendButton).element.disabled).toBe(true);
    await vi.waitFor(() => expect(api.sendSmsCode).toHaveBeenCalledOnce());
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
    expect(wrapper.text()).not.toContain('用原账号密码登录');
    await chooseMode(wrapper, /手机/);
    expect(wrapper.text()).not.toContain('账号密码登录');
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

describe('image verification for SMS resends', () => {
  const smsSent = { retry_after: 60, expires_in: 300 };
  const firstImage = { id: 'first', image: 'data:image/png;base64,AQ==' };
  const secondImage = { id: 'second', image: 'data:image/png;base64,Ag==' };
  const thirdImage = { id: 'third', image: 'data:image/png;base64,Aw==' };
  const imageSelector = 'img[alt="图片验证码"]';
  const answerSelector = '#login-captcha';
  const dialogSelector = 'dialog[open]';
  const closeSelector = 'button[aria-label="关闭"]';

  function challengeError(code, captcha) {
    return new api.ApiError(code === 'SMS_CAPTCHA_REQUIRED' ? '请输入图片验证码' : '图片验证码有误', {
      status: 400, code, details: { captcha },
    });
  }

  async function openChallenge(existingSmsCode = '') {
    api.sendSmsCode.mockRejectedValueOnce(challengeError('SMS_CAPTCHA_REQUIRED', firstImage));
    const wrapper = mount(ConnectedLoginPage, { attachTo: document.body }); await flushPromises();
    await wrapper.get('#login-phone').setValue(phone);
    await wrapper.get('#login-code').setValue(existingSmsCode);
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    await wrapper.get(sendButton).trigger('click');
    await vi.waitFor(() => expect(wrapper.get(dialogSelector).get(imageSelector).attributes('src')).toBe(firstImage.image));
    return wrapper;
  }

  it('sends twice directly, restores the second cooldown on refresh and opens the third challenge only on a click', async () => {
    vi.stubGlobal('crypto', webcrypto);
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      api.sendSmsCode.mockResolvedValueOnce(smsSent).mockResolvedValueOnce(smsSent)
        .mockRejectedValueOnce(challengeError('SMS_CAPTCHA_REQUIRED', firstImage));
      const wrapper = mount(ConnectedLoginPage); await flushPromises();
      await wrapper.get('#login-phone').setValue(phone);
      await sendAndSettle(wrapper);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wrapper.find(dialogSelector).exists()).toBe(false);
      await sendAndSettle(wrapper);
      expect(api.sendSmsCode.mock.calls).toEqual([[phone], [phone]]);
      wrapper.unmount();

      await vi.advanceTimersByTimeAsync(59_000);
      const refreshed = mount(ConnectedLoginPage, { attachTo: document.body }); await flushPromises();
      expect(refreshed.text()).toMatch(/上次.*1\s*秒/);
      await refreshed.get('#login-phone').setValue(phone);
      await vi.waitFor(() => expect(refreshed.get(sendButton).element.disabled).toBe(true));
      await refreshed.get(sendButton).trigger('click');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshed.get(sendButton).element.disabled).toBe(false);
      expect(refreshed.find(dialogSelector).exists()).toBe(false);
      expect(api.sendSmsCode).toHaveBeenCalledTimes(2);
      await refreshed.get(sendButton).trigger('click');
      await vi.waitFor(() => expect(refreshed.get(dialogSelector).get(imageSelector).attributes('src')).toBe(firstImage.image));
      const dialog = refreshed.get(dialogSelector);
      expect(document.getElementById(dialog.attributes('aria-labelledby'))?.textContent).toBe('图片验证码');
      expect(api.getSmsCaptcha).not.toHaveBeenCalled();
      expect(api.sendSmsCode).toHaveBeenCalledTimes(3);
      expect(refreshed.text()).not.toContain('已发送至');
    } finally { vi.unstubAllGlobals(); }
  });

  it('replaces a wrong challenge and sends using the answer for the manually refreshed image', async () => {
    const wrapper = await openChallenge('012345');
    api.sendSmsCode.mockRejectedValueOnce(challengeError('SMS_CAPTCHA_INVALID', secondImage))
      .mockResolvedValueOnce(smsSent);
    api.getSmsCaptcha.mockResolvedValueOnce(thirdImage);
    await wrapper.get(answerSelector).setValue('11');
    await wrapper.get(answerSelector).trigger('keydown.enter');
    expect(wrapper.get(answerSelector).attributes('aria-invalid')).toBe('true');
    expect(wrapper.get(dialogSelector).get('[role="alert"]').text()).toContain('4 位数字');
    expect(api.sendSmsCode).toHaveBeenCalledOnce();
    expect(api.loginWithSms).not.toHaveBeenCalled();
    await wrapper.get(answerSelector).setValue('1111');
    await chooseMode(wrapper, /验证并发送/); await flushPromises();
    expect(api.sendSmsCode).toHaveBeenLastCalledWith(phone, { id: firstImage.id, answer: '1111' });
    expect(wrapper.get(dialogSelector).get(imageSelector).attributes('src')).toBe(secondImage.image);
    expect(wrapper.get(dialogSelector).get('[role="alert"]').text()).toContain('图片验证码');
    expect(wrapper.get(answerSelector).element.value).toBe('');
    expect(wrapper.get('#login-code').element.value).toBe('012345');
    expect(wrapper.text()).not.toContain('秒后重发');

    await wrapper.get(answerSelector).setValue('2222');
    await chooseMode(wrapper, /换一张/); await flushPromises();
    expect(api.getSmsCaptcha).toHaveBeenCalledExactlyOnceWith(phone);
    expect(api.sendSmsCode).toHaveBeenCalledTimes(2);
    expect(wrapper.get(dialogSelector).get(imageSelector).attributes('src')).toBe(thirdImage.image);
    expect(wrapper.get(answerSelector).element.value).toBe('');
    await wrapper.get(answerSelector).setValue('0034');
    await chooseMode(wrapper, /验证并发送/); await flushPromises();
    expect(api.sendSmsCode).toHaveBeenLastCalledWith(phone, { id: thirdImage.id, answer: '0034' });
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    expect(wrapper.get(sendButton).text()).toContain('60 秒后重发');
    expect(wrapper.get('#login-code').element.value).toBe('');
  });

  it('returns to the SMS code already entered when the dialog is closed', async () => {
    const wrapper = await openChallenge('012345');
    api.loginWithSms.mockResolvedValueOnce({});
    await wrapper.get(dialogSelector).get(closeSelector).trigger('click');
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    expect(wrapper.get('#login-code').element.value).toBe('012345');
    expect(api.loginWithSms).not.toHaveBeenCalled();
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.loginWithSms).toHaveBeenCalledExactlyOnceWith(phone, '012345');
    expect(api.sendSmsCode).toHaveBeenCalledOnce();
  });

  it('dismisses on Escape, ignores the late image and lets the user request a fresh challenge', async () => {
    const wrapper = await openChallenge();
    let replace;
    api.getSmsCaptcha.mockReturnValueOnce(new Promise(resolve => { replace = resolve; }));
    await chooseMode(wrapper, /换一张/);
    // Browsers dispatch cancel on an open modal dialog when the user presses Escape.
    await wrapper.get(dialogSelector).trigger('cancel');
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    replace(secondImage); await flushPromises();
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    expect(api.sendSmsCode).toHaveBeenCalledOnce();
    api.sendSmsCode.mockRejectedValueOnce(challengeError('SMS_CAPTCHA_REQUIRED', thirdImage));
    await wrapper.get(sendButton).trigger('click');
    await vi.waitFor(() => expect(wrapper.get(dialogSelector).get(imageSelector).attributes('src')).toBe(thirdImage.image));
    expect(wrapper.get(answerSelector).element.value).toBe('');
    expect(api.sendSmsCode.mock.calls).toEqual([[phone], [phone]]);
  });

  it('discards a pending image replacement when switching phone numbers', async () => {
    const wrapper = await openChallenge();
    let replace;
    api.getSmsCaptcha.mockReturnValueOnce(new Promise(resolve => { replace = resolve; }));
    await chooseMode(wrapper, /换一张/);
    expect(api.getSmsCaptcha).toHaveBeenCalledExactlyOnceWith(phone);
    await wrapper.get(dialogSelector).get(closeSelector).trigger('click');
    const newPhone = '13900139000';
    await wrapper.get('#login-phone').setValue(newPhone);
    replace(secondImage); await flushPromises();
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    expect(wrapper.get(sendButton).element.disabled).toBe(false);
    api.sendSmsCode.mockResolvedValueOnce(smsSent);
    await sendAndSettle(wrapper);
    expect(api.sendSmsCode).toHaveBeenLastCalledWith(newPhone);
  });

  it('closes the image when the rolling window expires and waits for a click to send', async () => {
    const wrapper = await openChallenge();
    api.getSmsCaptcha.mockRejectedValueOnce(new api.ApiError('当前可直接获取短信验证码', {
      status: 409, code: 'SMS_CAPTCHA_NOT_REQUIRED',
    }));
    await chooseMode(wrapper, /换一张/); await flushPromises();
    expect(wrapper.find(dialogSelector).exists()).toBe(false);
    expect(api.sendSmsCode).toHaveBeenCalledOnce();
    api.sendSmsCode.mockResolvedValueOnce(smsSent);
    await sendAndSettle(wrapper);
    expect(api.sendSmsCode.mock.calls).toEqual([[phone], [phone]]);
  });
});

describe('connected account entry', () => {
  it('logs in from an existing password login link and returns to the original saved record', async () => {
    history.replaceState(null, '', '/web/login.html?mode=login&next=%2Fweb%2Fhistory.html%3Fsession_id%3D12');
    const wrapper = mount(ConnectedLoginPage);
    await flushPromises();
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
    api.logout.mockRejectedValueOnce(new Error('暂时无法连接')).mockImplementationOnce(async () => api.setAuthToken(''));
    await wrapper.get('button').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('暂时无法连接');
    expect(api.getAuthToken()).toBe('member-token');
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
