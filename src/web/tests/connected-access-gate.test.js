import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, onMounted, onUnmounted } from 'vue';
import ConnectedAccessGate from '../src/components/ConnectedAccessGate.vue';
import { getAuthToken, setAuthToken } from '../src/lib/api.js';
import { navigate, reloadPage } from '../src/lib/navigation.js';

vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' }, json: async () => body,
});
const member = { user_id: 7, is_guest: false };
const path = '/web/interview.html?session_id=12&interaction=voice';
function mountGate() {
  const mounted = vi.fn(), unmounted = vi.fn();
  const business = defineComponent({ setup() {
    onMounted(mounted); onUnmounted(unmounted);
    return () => h('section', { 'data-testid': 'business-page' }, 'saved interview');
  } });
  return { wrapper: mount(ConnectedAccessGate, { slots: { default: () => h(business) } }), mounted, unmounted };
}
function expectLogin() {
  expect(navigate).toHaveBeenCalledExactlyOnceWith(
    `./login.html?next=${encodeURIComponent(path)}`, { replace: true },
  );
}
beforeEach(() => {
  setAuthToken('');
  history.replaceState(null, '', path);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('connected member access gate', () => {
  it('redirects anonymous access without mounting the business page or creating a guest', async () => {
    const { wrapper, mounted } = mountGate();
    await flushPromises();
    expect(wrapper.find('[data-testid="business-page"]').exists()).toBe(false);
    expect(mounted).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expectLogin();
  });

  it('blocks an old guest while retaining the credential and draft for registration', async () => {
    setAuthToken('old-guest');
    sessionStorage.setItem('manji.connected.draft.12', 'existing draft');
    fetch.mockResolvedValue(response({ user_id: 7, is_guest: true }));
    const { mounted } = mountGate();
    await flushPromises();
    expect(mounted).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me']);
    expect(getAuthToken()).toBe('old-guest');
    expect(sessionStorage.getItem('manji.connected.draft.12')).toBe('existing draft');
    expectLogin();
  });

  it('waits for member verification before mounting the business page', async () => {
    setAuthToken('member-token');
    let resolve;
    fetch.mockReturnValue(new Promise(done => { resolve = done; }));
    const { wrapper, mounted } = mountGate();
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    expect(mounted).not.toHaveBeenCalled();
    resolve(response(member)); await flushPromises();
    expect(mounted).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="business-page"]').exists()).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('allows retry after a verification network failure without opening the business page', async () => {
    setAuthToken('member-token');
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    const { wrapper, mounted } = mountGate();
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法连接');
    expect(mounted).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    fetch.mockResolvedValue(response(member));
    await wrapper.get('button.connected-retry').trigger('click'); await flushPromises();
    expect(mounted).toHaveBeenCalledOnce();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('unmounts protected content and returns to login after signing out', async () => {
    setAuthToken('member-token');
    fetch.mockResolvedValue(response(member));
    const { wrapper, mounted, unmounted } = mountGate();
    await flushPromises();
    expect(mounted).toHaveBeenCalledOnce();
    setAuthToken(''); await flushPromises();
    expect(unmounted).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="business-page"]').exists()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expectLogin();
  });

  it('does not admit a stale member response after sign out', async () => {
    setAuthToken('member-token');
    let resolve;
    fetch.mockReturnValue(new Promise(done => { resolve = done; }));
    const { mounted } = mountGate();
    setAuthToken(''); await flushPromises();
    resolve(response(member)); await flushPromises();
    expect(mounted).not.toHaveBeenCalled();
    expectLogin();
  });

  it('reloads on bfcache restoration instead of reusing a previously authorized page', async () => {
    setAuthToken('member-token');
    fetch.mockResolvedValue(response(member));
    const { wrapper } = mountGate();
    await flushPromises();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(reloadPage).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reloadPage).toHaveBeenCalledOnce();
    wrapper.unmount();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reloadPage).toHaveBeenCalledOnce();
  });
});
