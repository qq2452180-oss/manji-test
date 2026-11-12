import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import HomePage from '../src/pages/HomePage.vue';
import ProfilePage from '../src/pages/ProfilePage.vue';
import ProfileEditPage from '../src/pages/ProfileEditPage.vue';
import { requireUser } from '../src/composables/page.js';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';
import { markWelcomeShown, finishFirstVisit } from '../src/lib/first-visit.js';

const identity = vi.hoisted(() => ({ token: 'guest-token' }));
vi.mock('../src/lib/api.js', () => ({
  getAuthToken: vi.fn(() => identity.token), getCurrentUser: vi.fn(), getPhotoBlob: vi.fn(),
  readHomeData: vi.fn(), getUnfinishedInterview: vi.fn(), getSession: vi.fn(), getOrganization: vi.fn(),
  hasPreviousGuest: vi.fn(() => false), restoreGuest: vi.fn(), logout: vi.fn(),
  uploadPhoto: vi.fn(), updateProfile: vi.fn(),
}));
vi.mock('../src/lib/app-state.js', () => ({
  getActiveSessionIds: vi.fn(() => []), getOrganizationSessionId: vi.fn(() => ''),
  setOrganizationSessionId: vi.fn(), setActiveSessionId: vi.fn(), removeActiveSessionId: vi.fn(), setBiographyId: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));
const pages = [[HomePage, 'index.html'], [ProfilePage, 'profile.html'], [ProfileEditPage, 'profile-edit.html']];
const wrappers = [];
const render = (component, path) => {
  history.replaceState({}, '', '/web2/' + path);
  const wrapper = mount(component); wrappers.push(wrapper); return wrapper;
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hasMemberUI = wrapper => wrapper.find('nav, .profile-menu, .identity-card, .photo-entry, .name-field, a[href*="interview.html"], a[href*="profile-edit.html"]').exists();

beforeEach(() => {
  vi.clearAllMocks(); identity.token = 'guest-token';
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  api.getCurrentUser.mockReset().mockResolvedValue({ id: 'guest', is_guest: true, avatar_media_id: 'guest-avatar' });
  api.readHomeData.mockReset().mockResolvedValue({ biography: { biography_id: 'book' }, stories: [] });
  api.getUnfinishedInterview.mockReset().mockResolvedValue({ session_id: null });
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

it.each(pages)('does not render member controls before verification or for a guest: %s %s', async (component, path) => {
  const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
  const wrapper = render(component, path + '?from=kept');
  expect(hasMemberUI(wrapper)).toBe(false);
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
  pending.resolve({ id: 'guest', is_guest: true, avatar_media_id: 'guest-avatar' }); await flushPromises();
  expect(hasMemberUI(wrapper)).toBe(false);
  expect(navigate).toHaveBeenCalledWith('./login.html?trial=1&next=' + encodeURIComponent('/web2/' + path + '?from=kept'), { replace: true });
  expect(api.readHomeData).not.toHaveBeenCalled(); expect(api.getPhotoBlob).not.toHaveBeenCalled();
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
  expect(api.uploadPhoto).not.toHaveBeenCalled(); expect(api.updateProfile).not.toHaveBeenCalled();
});

it('keeps the first anonymous homepage visit at the public welcome entry', async () => {
  identity.token = '';
  const wrapper = render(HomePage, 'index.html'); await flushPromises();
  expect(navigate).toHaveBeenCalledWith('./welcome.html', { replace: true });
  expect(api.getCurrentUser).not.toHaveBeenCalled(); expect(api.readHomeData).not.toHaveBeenCalled();
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
  expect(hasMemberUI(wrapper)).toBe(false);
});

it('continues an anonymous homepage visit to login after welcome has been shown', async () => {
  identity.token = ''; markWelcomeShown();
  const wrapper = render(HomePage, 'index.html'); await flushPromises();
  expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Findex.html', { replace: true });
  expect(hasMemberUI(wrapper)).toBe(false);
});

it('sends a returning anonymous homepage visitor to login instead of welcome', async () => {
  identity.token = ''; markWelcomeShown(); finishFirstVisit();
  const wrapper = render(HomePage, 'index.html'); await flushPromises();
  expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Findex.html', { replace: true });
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
  expect(hasMemberUI(wrapper)).toBe(false);
});

it.each([[HomePage, 'index.html'], [ProfilePage, 'profile.html']])('waits for visibility before checking a member page: %s %s', async (component, path) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  const wrapper = render(component, path); await flushPromises();
  expect(api.getCurrentUser).not.toHaveBeenCalled(); expect(hasMemberUI(wrapper)).toBe(false);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
  await flushPromises(); expect(api.getCurrentUser).toHaveBeenCalledOnce();
  expect(hasMemberUI(wrapper)).toBe(false);
});

it.each(pages)('keeps member controls hidden after an identity lookup failure: %s %s', async (component, path) => {
  api.getCurrentUser.mockRejectedValue(new Error('offline'));
  const wrapper = render(component, path); await flushPromises();
  expect(hasMemberUI(wrapper)).toBe(false); expect(navigate).not.toHaveBeenCalled();
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
  expect(wrapper.text()).toMatch(/重试|重新确认/);
});

it.each(pages)('does not redirect after leaving while guest verification is pending: %s %s', async (component, path) => {
  const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
  const wrapper = render(component, path); wrapper.unmount();
  pending.resolve({ id: 'guest', is_guest: true }); await flushPromises();
  expect(navigate).not.toHaveBeenCalled(); expect(api.readHomeData).not.toHaveBeenCalled();
  expect(api.getUnfinishedInterview).not.toHaveBeenCalled();
});

it('hides homepage controls on hide and discards old member verification', async () => {
  const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
  const wrapper = render(HomePage, 'index.html');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
  pending.resolve({ id: 'member', is_guest: false }); await flushPromises();
  expect(hasMemberUI(wrapper)).toBe(false); expect(api.readHomeData).not.toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
  await flushPromises(); expect(wrapper.find('nav').exists()).toBe(true);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
  await flushPromises(); expect(hasMemberUI(wrapper)).toBe(false);
});

it('clears verified homepage controls as soon as the account changes', async () => {
  api.getCurrentUser.mockResolvedValue({ id: 'member', is_guest: false });
  const wrapper = render(HomePage, 'index.html'); await flushPromises();
  expect(wrapper.find('nav').exists()).toBe(true);
  identity.token = 'guest-token-2'; window.dispatchEvent(new Event('manji:auth-changed')); await flushPromises();
  expect(hasMemberUI(wrapper)).toBe(false);
});

it('preserves requireUser access for the existing first guest experience and result pages', async () => {
  const user = await requireUser();
  expect(user.is_guest).toBe(true); expect(navigate).not.toHaveBeenCalled();
});
