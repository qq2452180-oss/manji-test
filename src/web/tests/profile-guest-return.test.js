import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProfilePage from '../src/pages/ProfilePage.vue';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/api.js', () => ({
  getAuthToken: vi.fn(), getCurrentUser: vi.fn(), getPhotoBlob: vi.fn(),
  hasPreviousGuest: vi.fn(), restoreGuest: vi.fn(), logout: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  history.replaceState({}, '', '/web2/profile.html');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  api.getAuthToken.mockReturnValue('member-token');
  api.getCurrentUser.mockResolvedValue({ id: 'member', username: 'xiaoli', is_guest: false });
  api.hasPreviousGuest.mockReturnValue(true);
});

it('shows the account name and returns to the preserved guest only after successful verification', async () => {
  let resolve;
  api.restoreGuest.mockReturnValue(new Promise(done => { resolve = done; }));
  const wrapper = mount(ProfilePage);
  await flushPromises();
  expect(wrapper.get('.identity-name').text()).toBe('xiaoli');
  await wrapper.get('.previous-guest').trigger('click');
  expect(wrapper.get('.previous-guest').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.logout-link').attributes('disabled')).toBeDefined();
  expect(navigate).not.toHaveBeenCalled();
  resolve({ user: { id: 'guest', is_guest: true } });
  await flushPromises();
  expect(navigate).toHaveBeenCalledWith('./biography.html', { replace: true });
});

it('retains the member page and offers retry when the guest check cannot connect', async () => {
  api.restoreGuest.mockRejectedValue(new Error('暂时无法连接，请重试。'));
  const wrapper = mount(ProfilePage);
  await flushPromises();
  await wrapper.get('.previous-guest').trigger('click');
  await flushPromises();
  expect(wrapper.get('.identity-name').text()).toBe('xiaoli');
  expect(wrapper.get('[role="alert"]').text()).toContain('无法连接');
  expect(wrapper.get('.previous-guest').attributes('disabled')).toBeUndefined();
  expect(navigate).not.toHaveBeenCalled();
});

it('does not redirect a delayed restore after the page has been left', async () => {
  let resolve;
  api.restoreGuest.mockReturnValue(new Promise(done => { resolve = done; }));
  const wrapper = mount(ProfilePage);
  await flushPromises();
  await wrapper.get('.previous-guest').trigger('click');
  wrapper.unmount();
  resolve({ user: { id: 'guest', is_guest: true } });
  await flushPromises();
  expect(navigate).not.toHaveBeenCalled();
});

it('returns to the verified guest story preview when a hidden restore finishes and the page is shown again', async () => {
  let resolve;
  api.restoreGuest.mockReturnValue(new Promise(done => { resolve = done; }));
  const wrapper = mount(ProfilePage); await flushPromises();
  await wrapper.get('.previous-guest').trigger('click');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  api.getAuthToken.mockReturnValue('restored-guest-token');
  window.dispatchEvent(new Event('manji:auth-changed'));
  resolve({ user: { id: 'guest', is_guest: true } }); await flushPromises();
  expect(wrapper.find('nav').exists()).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
  expect(navigate).toHaveBeenCalledExactlyOnceWith('./biography.html', { replace: true });
  expect(api.getCurrentUser).toHaveBeenCalledOnce();
});

it('discards a hidden guest return destination if the account changes again', async () => {
  let resolve;
  api.restoreGuest.mockReturnValue(new Promise(done => { resolve = done; }));
  const wrapper = mount(ProfilePage); await flushPromises();
  await wrapper.get('.previous-guest').trigger('click');
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  api.getAuthToken.mockReturnValue('restored-guest-token');
  window.dispatchEvent(new Event('manji:auth-changed'));
  resolve({ user: { id: 'guest', is_guest: true } }); await flushPromises();
  api.getAuthToken.mockReturnValue('another-member-token');
  window.dispatchEvent(new Event('manji:auth-changed'));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
  expect(navigate).not.toHaveBeenCalled();
  expect(wrapper.find('nav').exists()).toBe(true);
  expect(api.getCurrentUser).toHaveBeenCalledTimes(2);
});

it('redirects a guest to registration without exposing the member profile', async () => {
  api.getCurrentUser.mockResolvedValue({ id: 'guest', is_guest: true });
  const wrapper = mount(ProfilePage);
  await flushPromises();
  expect(wrapper.find('.previous-guest').exists()).toBe(false);
  expect(wrapper.find('.identity-card').exists()).toBe(false);
  expect(wrapper.find('nav').exists()).toBe(false);
  expect(navigate).toHaveBeenCalledWith('./login.html?trial=1&next=%2Fweb2%2Fprofile.html', { replace: true });
});
