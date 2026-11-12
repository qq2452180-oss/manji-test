// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LoginPage from '../src/pages/LoginPage.vue';
import ProfilePage from '../src/pages/ProfilePage.vue';
import ProfileEditPage from '../src/pages/ProfileEditPage.vue';
import PreviewPage from '../src/pages/PreviewPage.vue';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';

const auth = vi.hoisted(() => ({ token: 'owner-a' }));
vi.mock('../src/lib/api.js', () => ({
  getAuthToken: vi.fn(() => auth.token), setAuthToken: vi.fn(value => { auth.token = value; window.dispatchEvent(new Event('manji:auth-changed')); }),
  getCurrentUser: vi.fn(), getPhotoBlob: vi.fn(), uploadPhoto: vi.fn(), updateProfile: vi.fn(), logout: vi.fn(),
  hasPreviousGuest: vi.fn(() => false), restoreGuest: vi.fn(), registerAccount: vi.fn(), loginAccount: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const wrappers = [];
const render = component => { const wrapper = mount(component); wrappers.push(wrapper); return wrapper; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function choose(wrapper, selector, file) {
  const input = wrapper.get(selector);
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
  await input.trigger('change'); await flushPromises();
}
beforeEach(() => {
  vi.clearAllMocks(); auth.token = 'owner-a';
  window.history.replaceState({}, '', '/web2/profile.html');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  URL.createObjectURL = vi.fn(() => 'blob:current'); URL.revokeObjectURL = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  api.getCurrentUser.mockReset().mockResolvedValue({ id: 'a', display_name: '原来的名字' });
  api.getPhotoBlob.mockReset().mockResolvedValue(new Blob(['avatar']));
  api.uploadPhoto.mockReset().mockResolvedValue({ id: 'uploaded-avatar' });
  api.updateProfile.mockReset().mockResolvedValue({});
  api.logout.mockReset().mockImplementation(async () => { auth.token = ''; window.dispatchEvent(new Event('manji:auth-changed')); });
  api.hasPreviousGuest.mockReturnValue(false);
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

describe('local login', () => {
  it('offers the phone login prototype without showing developer credentials', async () => {
    history.replaceState(null, '', '/web2/login.html');
    auth.token = ''; const wrapper = render(LoginPage); await flushPromises();
    expect(wrapper.get('.login-back').attributes('href')).toBe('./welcome.html');
    expect(wrapper.find('.developer-login').exists()).toBe(false);
    expect(wrapper.get('[data-testid="account-form"]').text()).toContain('登录慢记');
    expect(wrapper.text()).not.toContain('即将开放');
  });
  it('takes a completed trial back to its story collection without creating another identity', async () => {
    history.replaceState(null, '', '/web2/login.html?trial=1');
    api.getCurrentUser.mockResolvedValue({ id: 'guest', is_guest: true });
    const wrapper = render(LoginPage); await flushPromises();
    expect(wrapper.get('.login-back').attributes('href')).toBe('./biography.html');
    expect(api.setAuthToken).not.toHaveBeenCalled();
    expect(wrapper.get('#login-phone').exists()).toBe(true);
    expect(wrapper.find('#login-password').exists()).toBe(false);
  });
  it('reads multiple accounts locally and preserves the approved return query', async () => {
    auth.token = ''; window.history.replaceState({}, '', '/web2/login.html?debug=1&next=%2Fweb2%2Fstory.html%3Fstory_id%3Dsaved');
    const wrapper = render(LoginPage), first = 'a'.repeat(43), second = 'b'.repeat(43);
    await choose(wrapper, '[data-testid="login-file"]', { size: 100, text: async () => JSON.stringify([{ label: '甲', token: first }, { label: '乙', token: second }]) });
    expect(wrapper.get('#login-token').element.value).toBe(first);
    await wrapper.get('select').setValue('1');
    expect(wrapper.get('#login-token').element.value).toBe(second);
    await wrapper.get('[data-testid="developer-login-form"]').trigger('submit'); await flushPromises();
    expect(api.uploadPhoto).not.toHaveBeenCalled();
    expect(api.setAuthToken).toHaveBeenCalledWith(second);
    expect(navigate).toHaveBeenCalledWith('/web2/story.html?story_id=saved', { replace: true });
    expect(wrapper.get('#login-token').element.value).toBe('');
  });
  it('rejects an oversized file and sends an external return URL to the local home', async () => {
    auth.token = ''; window.history.replaceState({}, '', '/web2/login.html?debug=1&return=https%3A%2F%2Foutside.test%2F');
    const wrapper = render(LoginPage), read = vi.fn();
    await choose(wrapper, '[data-testid="login-file"]', { size: 65537, text: read });
    expect(read).not.toHaveBeenCalled(); expect(wrapper.get('[role="alert"]').text()).toContain('没有找到');
    await wrapper.get('#login-token').setValue('a'.repeat(43));
    await wrapper.get('[data-testid="developer-login-form"]').trigger('submit'); await flushPromises();
    expect(navigate).toHaveBeenCalledWith('/web2/index.html', { replace: true });
  });
  it('does not allow a slower previous file to replace the selected account', async () => {
    history.replaceState({}, '', '/web2/login.html?debug=1');
    const old = deferred(), wrapper = render(LoginPage);
    await choose(wrapper, '[data-testid="login-file"]', { size: 10, text: () => old.promise });
    await choose(wrapper, '[data-testid="login-file"]', { size: 10, text: async () => JSON.stringify({ token: 'b'.repeat(43) }) });
    old.resolve(JSON.stringify({ token: 'a'.repeat(43) })); await flushPromises();
    expect(wrapper.get('#login-token').element.value).toBe('b'.repeat(43));
  });
  it('does not redirect when a login response arrives after leaving', async () => {
    history.replaceState({}, '', '/web2/login.html?debug=1');
    const response = deferred(); api.getCurrentUser.mockReturnValue(response.promise);
    const wrapper = render(LoginPage); await wrapper.get('#login-token').setValue('a'.repeat(43));
    await wrapper.get('[data-testid="developer-login-form"]').trigger('submit'); wrapper.unmount();
    response.resolve({ id: 'a' }); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('clears an expired credential and distinguishes it from a network error', async () => {
    history.replaceState({}, '', '/web2/login.html?debug=1');
    api.getCurrentUser.mockRejectedValue({ status: 401 }); const wrapper = render(LoginPage);
    await wrapper.get('#login-token').setValue('a'.repeat(43)); await wrapper.get('[data-testid="developer-login-form"]').trigger('submit'); await flushPromises();
    expect(auth.token).toBe(''); expect(wrapper.get('[role="alert"]').text()).toContain('已失效'); expect(navigate).not.toHaveBeenCalled();
  });
});

describe('profile privacy and editing', () => {
  it('redirects an anonymous profile to login without exposing member navigation', async () => {
    auth.token = ''; const wrapper = render(ProfilePage); await flushPromises();
    expect(api.getCurrentUser).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Fprofile.html', { replace: true });
    expect(wrapper.find('.identity-card').exists()).toBe(false);
    expect(wrapper.find('nav').exists()).toBe(false);
  });
  it('rejects a delayed avatar from the previous account', async () => {
    const image = deferred(); api.getCurrentUser.mockResolvedValueOnce({ id: 'a', display_name: '甲的名字', avatar_media_id: 'old-photo' }).mockResolvedValueOnce({ id: 'b', display_name: '乙的名字' });
    api.getPhotoBlob.mockReturnValue(image.promise); const wrapper = render(ProfilePage); await flushPromises();
    auth.token = 'owner-b'; window.dispatchEvent(new Event('manji:auth-changed')); await flushPromises();
    image.resolve(new Blob(['private-old'])); await flushPromises();
    expect(wrapper.text()).toContain('乙的名字'); expect(wrapper.text()).not.toContain('甲的名字');
    expect(wrapper.find('img').exists()).toBe(false); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('returns to login after a failed remote logout with the local token already cleared', async () => {
    api.logout.mockImplementation(async () => { auth.token = ''; throw new Error('offline'); });
    const wrapper = render(ProfilePage); await flushPromises();
    await wrapper.get('.logout-link').trigger('click'); await flushPromises();
    expect(auth.token).toBe(''); expect(navigate).toHaveBeenCalledWith('./login.html', { replace: true });
    expect(wrapper.text()).not.toContain('原来的名字');
  });
  it('reuses an uploaded avatar when profile saving needs a retry', async () => {
    api.updateProfile.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const wrapper = render(ProfileEditPage); await flushPromises();
    const file = new File(['image'], 'portrait.jpg', { type: 'image/jpeg' });
    await choose(wrapper, '[data-testid="avatar-file"]', file);
    await wrapper.get('#display-name').setValue('新名字'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('没有保存成功');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(api.uploadPhoto).toHaveBeenCalledTimes(1); expect(api.updateProfile).toHaveBeenCalledTimes(2);
    expect(api.updateProfile).toHaveBeenLastCalledWith({ display_name: '新名字', avatar_media_id: 'uploaded-avatar' });
    expect(navigate).toHaveBeenCalledWith('./profile.html?saved=1', { replace: true });
  });
  it('does not attach an uploaded avatar after the account changes', async () => {
    const upload = deferred(); api.uploadPhoto.mockReturnValue(upload.promise);
    const wrapper = render(ProfileEditPage); await flushPromises();
    await choose(wrapper, '[data-testid="avatar-file"]', new File(['image'], 'portrait.png', { type: 'image/png' }));
    await wrapper.get('form').trigger('submit'); auth.token = 'owner-b'; window.dispatchEvent(new Event('manji:auth-changed'));
    upload.resolve({ id: 'old-account-photo' }); await flushPromises();
    expect(api.updateProfile).not.toHaveBeenCalled(); expect(wrapper.find('form').exists()).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
  it('keeps unsaved name and selected photo when returning from another tab or native picker', async () => {
    const wrapper = render(ProfileEditPage); await flushPromises();
    await wrapper.get('#display-name').setValue('还没保存的名字');
    await choose(wrapper, '[data-testid="avatar-file"]', new File(['image'], 'portrait.jpg', { type: 'image/jpeg' }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(wrapper.get('#display-name').element.value).toBe('还没保存的名字'); expect(wrapper.get('img').attributes('src')).toBe('blob:current');
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1); expect(api.uploadPhoto).not.toHaveBeenCalled();
  });
  it('counts name limits by Unicode characters and prevents duplicate saving', async () => {
    const saving = deferred(); api.updateProfile.mockReturnValue(saving.promise);
    const wrapper = render(ProfileEditPage); await flushPromises();
    await wrapper.get('#display-name').setValue('😀'.repeat(33)); await wrapper.get('form').trigger('submit');
    expect(api.updateProfile).not.toHaveBeenCalled(); expect(wrapper.get('[role="alert"]').text()).toContain('32');
    await wrapper.get('#display-name').setValue('😀'.repeat(32)); await wrapper.get('form').trigger('submit'); await wrapper.get('form').trigger('submit');
    expect(api.updateProfile).toHaveBeenCalledTimes(1); saving.resolve({}); await flushPromises();
  });
  it('does not render a profile or create an image after unmount', async () => {
    const response = deferred(); api.getCurrentUser.mockReturnValue(response.promise);
    const wrapper = render(ProfileEditPage); wrapper.unmount(); response.resolve({ id: 'a', avatar_media_id: 'private-photo' }); await flushPromises();
    expect(api.getPhotoBlob).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('family preview compatibility', () => {
  it('shows the family placeholder only after member verification', async () => {
    window.history.replaceState({}, '', '/web2/preview.html?kind=family'); const wrapper = render(PreviewPage);
    expect(wrapper.text()).not.toContain('家人功能后续开放');
    await flushPromises();
    expect(wrapper.text()).toContain('家人功能后续开放'); expect(api.getCurrentUser).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
  });
  it.each([['photo', '&entry=PHOTO'], ['text', '&interaction=text'], ['voice', '']])('preserves the old %s entry', async (kind, suffix) => {
    window.history.replaceState({}, '', '/web2/preview.html?kind=' + kind); render(PreviewPage); await flushPromises();
    expect(navigate).toHaveBeenCalledWith('./interview.html?new=1' + suffix, { replace: true });
  });
});
