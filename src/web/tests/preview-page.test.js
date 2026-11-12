import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PreviewPage from '../src/pages/PreviewPage.vue';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';

const state = vi.hoisted(() => ({ token: 'member-token' }));
vi.mock('../src/lib/api.js', () => ({
  getAuthToken: vi.fn(() => state.token), getCurrentUser: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const wrappers = [];
const render = () => { const wrapper = mount(PreviewPage); wrappers.push(wrapper); return wrapper; };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function visibility(hidden) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
function expectClosed(wrapper) {
  expect(wrapper.find('.family-sheet').exists()).toBe(false);
  expect(wrapper.find('nav').exists()).toBe(false);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.token = 'member-token';
  history.replaceState({}, '', '/web2/preview.html?kind=family');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  api.getCurrentUser.mockReset().mockResolvedValue({ id: 'member', is_guest: false });
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

it('keeps family content and formal navigation hidden until membership is confirmed', async () => {
  const identity = deferred(); api.getCurrentUser.mockReturnValue(identity.promise);
  const wrapper = render();
  expectClosed(wrapper); expect(wrapper.get('[role="status"]').text()).toContain('确认');
  identity.resolve({ id: 'member', is_guest: false }); await flushPromises();
  expect(wrapper.get('.family-sheet').text()).toContain('家人功能后续开放');
  expect(wrapper.find('nav').exists()).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
});

it('sends guests to registration without exposing family navigation', async () => {
  api.getCurrentUser.mockResolvedValue({ id: 'guest', is_guest: true });
  const wrapper = render(); await flushPromises();
  expectClosed(wrapper);
  expect(navigate).toHaveBeenCalledWith('./login.html?trial=1&next=%2Fweb2%2Fpreview.html%3Fkind%3Dfamily', { replace: true });
});

it('requires login before loading identity for an anonymous visitor', async () => {
  state.token = '';
  const wrapper = render(); await flushPromises();
  expectClosed(wrapper); expect(api.getCurrentUser).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Fpreview.html%3Fkind%3Dfamily', { replace: true });
});

it.each([
  ['photo', './interview.html?new=1&entry=PHOTO'],
  ['text', './interview.html?new=1&interaction=text'],
  ['voice', './interview.html?new=1'],
])('waits for membership before the legacy %s redirect', async (kind, target) => {
  history.replaceState({}, '', '/web2/preview.html?kind=' + kind);
  const identity = deferred(); api.getCurrentUser.mockReturnValue(identity.promise);
  const wrapper = render(); await flushPromises();
  expectClosed(wrapper); expect(navigate).not.toHaveBeenCalled();
  identity.resolve({ id: 'member', is_guest: false }); await flushPromises();
  expect(navigate).toHaveBeenCalledWith(target, { replace: true });
  expectClosed(wrapper);
});

it('guards a legacy interview URL for a guest', async () => {
  history.replaceState({}, '', '/web2/preview.html?kind=photo');
  api.getCurrentUser.mockResolvedValue({ id: 'guest', is_guest: true });
  const wrapper = render(); await flushPromises();
  expectClosed(wrapper);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('./login.html?trial=1&next=%2Fweb2%2Fpreview.html%3Fkind%3Dphoto', { replace: true });
});

it('keeps failed identity checks closed and allows a successful retry', async () => {
  api.getCurrentUser.mockRejectedValueOnce(new Error('offline'));
  const wrapper = render(); await flushPromises();
  expectClosed(wrapper); expect(wrapper.get('[role="alert"]').text()).toContain('重试');
  expect(navigate).not.toHaveBeenCalled();
  await wrapper.get('button').trigger('click'); await flushPromises();
  expect(api.getCurrentUser).toHaveBeenCalledTimes(2);
  expect(wrapper.find('.family-sheet').exists()).toBe(true);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});

it('clears confirmed content while hidden and checks membership again when visible', async () => {
  const wrapper = render(); await flushPromises();
  expect(wrapper.find('nav').exists()).toBe(true);
  visibility(true); await flushPromises(); expectClosed(wrapper);
  api.getCurrentUser.mockResolvedValue({ id: 'guest', is_guest: true });
  visibility(false); await flushPromises(); expectClosed(wrapper);
  expect(api.getCurrentUser).toHaveBeenCalledTimes(2);
  expect(navigate).toHaveBeenCalledWith('./login.html?trial=1&next=%2Fweb2%2Fpreview.html%3Fkind%3Dfamily', { replace: true });
});

it.each(['hide', 'unmount', 'pagehide'])('discards a delayed legacy redirect after %s', async action => {
  history.replaceState({}, '', '/web2/preview.html?kind=photo');
  const identity = deferred(); api.getCurrentUser.mockReturnValue(identity.promise);
  const wrapper = render();
  if (action === 'hide') visibility(true);
  else if (action === 'unmount') wrapper.unmount();
  else window.dispatchEvent(new Event('pagehide'));
  identity.resolve({ id: 'member', is_guest: false }); await flushPromises();
  expect(navigate).not.toHaveBeenCalled();
  if (action !== 'unmount') expectClosed(wrapper);
});

it('discards an old guest result after an account change and verifies the new member', async () => {
  const old = deferred(), fresh = deferred();
  api.getCurrentUser.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const wrapper = render();
  state.token = 'new-member-token'; window.dispatchEvent(new Event('manji:auth-changed'));
  old.resolve({ id: 'old-guest', is_guest: true }); await flushPromises();
  expectClosed(wrapper); expect(navigate).not.toHaveBeenCalled();
  fresh.resolve({ id: 'new-member', is_guest: false }); await flushPromises();
  expect(wrapper.find('nav').exists()).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
});
