import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { navigate } from '../src/lib/navigation.js';

const identity = vi.hoisted(() => ({ token: '' }));
vi.mock('../src/lib/api.js', () => ({
  getAuthToken: vi.fn(() => identity.token),
  getCurrentUser: vi.fn(),
  startGuest: vi.fn(),
  getGuestTrial: vi.fn(),
}));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const member = { id: 'member-a', is_guest: false };
const guest = { id: 'guest-a', is_guest: true };
let entry, api;

beforeEach(async () => {
  identity.token = '';
  window.localStorage.clear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.resetModules();
  api = await import('../src/lib/api.js');
  api.getCurrentUser.mockReset().mockResolvedValue(member);
  api.startGuest.mockReset();
  api.getGuestTrial.mockReset();
  entry = await import('../src/lib/first-visit.js');
});

describe('first visit and returning visitor routing', () => {
  it('sends a new anonymous browser to the welcome page without creating or verifying an identity', async () => {
    expect(entry.hasSeenWelcome()).toBe(false);
    expect(entry.firstVisitReturnUrl()).toBe('./welcome.html');
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'welcome' });
    expect(api.getCurrentUser).not.toHaveBeenCalled();
    expect(api.startGuest).not.toHaveBeenCalled();
  });

  it('continues to login after refresh or back navigation following the welcome page', async () => {
    entry.markWelcomeShown();
    vi.resetModules();
    entry = await import('../src/lib/first-visit.js');
    expect(entry.hasSeenWelcome()).toBe(true);
    expect(entry.firstVisitReturnUrl()).toBe('');
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login' });
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('routes a later anonymous visit to login while retaining the browser welcome marker', async () => {
    entry.markWelcomeShown();
    entry.finishFirstVisit();
    vi.resetModules();
    entry = await import('../src/lib/first-visit.js');
    expect(entry.hasSeenWelcome()).toBe(true);
    expect(entry.firstVisitReturnUrl()).toBe('');
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login' });
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('uses the persistent welcome marker when the tab session has ended', async () => {
    entry.markWelcomeShown();
    window.sessionStorage.clear();
    vi.resetModules();
    entry = await import('../src/lib/first-visit.js');
    expect(entry.hasSeenWelcome()).toBe(true);
    expect(entry.firstVisitReturnUrl()).toBe('');
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login' });
  });

  it('waits for a member to be verified before resolving home, even in a browser with no welcome marker', async () => {
    identity.token = 'member-token';
    const pending = deferred();
    api.getCurrentUser.mockReturnValue(pending.promise);
    const resolved = vi.fn();
    const result = entry.resolveEntry().then(value => { resolved(value); return value; });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(api.getCurrentUser).toHaveBeenCalledWith({ redirectOnUnauthorized: false });
    pending.resolve(member);
    expect(await result).toMatchObject({ destination: 'home', user: member, token: 'member-token' });
    expect(api.startGuest).not.toHaveBeenCalled();
  });

  it('sends an existing guest to login even if the removed choice screen was previously open', async () => {
    window.sessionStorage.setItem('manji.web2.welcome.flow.v1', 'choosing');
    identity.token = 'guest-token';
    api.getCurrentUser.mockResolvedValue(guest);
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login', user: guest, token: 'guest-token' });
    expect(api.startGuest).not.toHaveBeenCalled();
  });

  it('sends a previously prepared guest to login after refresh', async () => {
    identity.token = 'guest-token';
    api.getCurrentUser.mockResolvedValue(guest);
    window.sessionStorage.setItem('manji.web2.welcome.flow.v1', 'guest:' + guest.id);
    vi.resetModules();
    entry = await import('../src/lib/first-visit.js');
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login', user: guest, token: 'guest-token' });
    expect(api.startGuest).not.toHaveBeenCalled();
  });

  it.each(['choosing', 'guest:guest-a'])('routes an anonymous visitor with a legacy %s marker to login', async marker => {
    window.sessionStorage.setItem('manji.web2.welcome.flow.v1', marker);
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login' });
    expect(entry.firstVisitReturnUrl()).toBe('');
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('routes a confirmed expired credential to login after the API clears it', async () => {
    entry.markWelcomeShown();
    identity.token = 'expired-token';
    api.getCurrentUser.mockImplementation(async () => {
      identity.token = '';
      throw { status: 401 };
    });
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login' });
    expect(api.startGuest).not.toHaveBeenCalled();
  });

  it('preserves the current credential and exposes a network failure for an explicit retry', async () => {
    identity.token = 'member-token';
    const failure = { code: 'NETWORK_ERROR' };
    api.getCurrentUser.mockRejectedValueOnce(failure);
    await expect(entry.resolveEntry()).rejects.toBe(failure);
    expect(identity.token).toBe('member-token');
    expect(api.startGuest).not.toHaveBeenCalled();
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'home', user: member });
  });

  it('discards verification from an old account even if an account change notification was missed', async () => {
    identity.token = 'guest-token';
    const pending = deferred();
    api.getCurrentUser.mockReturnValue(pending.promise);
    const result = entry.resolveEntry();
    identity.token = 'member-token';
    pending.resolve(guest);
    expect(await result).toBeNull();
  });

  it('discards a late authorization failure after the active account has changed', async () => {
    identity.token = 'expired-token';
    const pending = deferred();
    api.getCurrentUser.mockReturnValue(pending.promise);
    const result = entry.resolveEntry();
    identity.token = 'member-token';
    pending.reject({ status: 401 });
    expect(await result).toBeNull();
  });

  it.each(['success', 'failure'])('discards a late %s after the caller becomes inactive', async outcome => {
    identity.token = 'member-token';
    let active = true;
    const pending = deferred();
    api.getCurrentUser.mockReturnValue(pending.promise);
    const result = entry.resolveEntry({ isCurrent: () => active });
    active = false;
    if (outcome === 'success') pending.resolve(member);
    else pending.reject({ code: 'NETWORK_ERROR' });
    expect(await result).toBeNull();
  });

  it('does not resolve a destination for an already inactive caller', async () => {
    identity.token = 'member-token';
    expect(await entry.resolveEntry({ isCurrent: () => false })).toBeNull();
  });

  it('links directly to login when browser storage is unavailable', async () => {
    const unavailable = () => { throw new DOMException('Storage disabled', 'SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(unavailable);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(unavailable);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(unavailable);
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'welcome' });
    expect(() => entry.markWelcomeShown()).not.toThrow();
    expect(entry.firstVisitStartUrl()).toBe('./login.html?next=%2Fweb2%2Findex.html');
    expect(api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('does not treat a legacy intro parameter as a completed welcome visit', async () => {
    history.replaceState(null, '', '/web2/index.html?intro=1');
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'welcome' });
  });

  it.each([
    ['member', member, 'home'],
    ['guest', guest, 'login'],
  ])('still verifies an existing %s when a legacy intro parameter is present', async (_kind, user, destination) => {
    history.replaceState(null, '', '/web2/index.html?intro=1');
    identity.token = 'existing-token';
    api.getCurrentUser.mockResolvedValue(user);
    expect(await entry.resolveEntry()).toMatchObject({ destination, user });
    expect(api.getCurrentUser).toHaveBeenCalledWith({ redirectOnUnauthorized: false });
  });
});

describe('welcome page entry transitions', () => {
  const renderWelcome = async () => {
    const { default: WelcomePage } = await import('../src/pages/WelcomePage.vue');
    return mount(WelcomePage);
  };

  it('keeps the welcome introduction hidden until a saved account has been verified', async () => {
    identity.token = 'member-token';
    const pending = deferred();
    api.getCurrentUser.mockReturnValue(pending.promise);
    const wrapper = await renderWelcome();
    await flushPromises();
    expect(wrapper.find('#welcome-title').exists()).toBe(false);
    expect(wrapper.find('a').exists()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    pending.resolve(member);
    await flushPromises();
    expect(navigate).toHaveBeenCalledWith('./index.html', { replace: true });
    expect(wrapper.find('#welcome-title').exists()).toBe(false);
  });

  it('makes Start available immediately while the welcome sentences are still appearing', async () => {
    const microphone = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
    const playback = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const wrapper = await renderWelcome();
    await flushPromises();
    expect(wrapper.get('.intro-primary').attributes('href')).toBe('./login.html?next=%2Fweb2%2Findex.html');
    expect(wrapper.get('.intro-primary').attributes('aria-disabled')).not.toBe('true');
    expect(wrapper.findAll('a, button')).toHaveLength(1);
    expect(entry.hasSeenWelcome()).toBe(true);
    expect(api.getCurrentUser).not.toHaveBeenCalled();
    expect(api.startGuest).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(playback).not.toHaveBeenCalled();
  });

  it('continues to login when the already shown introduction is refreshed', async () => {
    entry.markWelcomeShown();
    const wrapper = await renderWelcome();
    await flushPromises();
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Findex.html', { replace: true });
    expect(wrapper.find('#welcome-title').exists()).toBe(false);
  });

  it('shows a retry after a connection failure without dropping the account or exposing the welcome screen', async () => {
    identity.token = 'member-token';
    api.getCurrentUser.mockRejectedValueOnce({ code: 'NETWORK_ERROR' });
    const wrapper = await renderWelcome();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('检查网络');
    expect(wrapper.find('#welcome-title').exists()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(identity.token).toBe('member-token');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(navigate).toHaveBeenCalledWith('./index.html', { replace: true });
    expect(api.getCurrentUser).toHaveBeenCalledTimes(2);
    expect(api.startGuest).not.toHaveBeenCalled();
  });

  it('does not navigate after leaving while account verification is pending', async () => {
    identity.token = 'member-token';
    const pending = deferred();
    api.getCurrentUser.mockReturnValue(pending.promise);
    const wrapper = await renderWelcome();
    wrapper.unmount();
    pending.resolve(member);
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
  });
});
