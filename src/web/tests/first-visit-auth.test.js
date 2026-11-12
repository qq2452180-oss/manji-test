import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/lib/api.js';
import * as entry from '../src/lib/first-visit.js';
import * as pointers from '../src/lib/app-state.js';
import { completeVoiceGuide, hasCompletedVoiceGuide } from '../src/lib/voice-guide-state.js';

const expiredToken = 'e'.repeat(43), memberToken = 'm'.repeat(43);
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => body,
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ id: 'member-a', is_guest: false })));
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (this === window.localStorage) throw new DOMException('Persistent storage is full', 'QuotaExceededError');
    return setItem.call(this, key, value);
  });
});
afterEach(() => vi.unstubAllGlobals());

function savePrivateContext() {
  pointers.setBiographyId('old-book');
  pointers.setActiveSessionId('old-session');
  pointers.setOrganizationSessionId('old-organization');
  sessionStorage.setItem('manji.web2.interview.guest-a.old-session', 'old-draft');
  sessionStorage.setItem('manji.previous_guest_token', 'old-guest-token');
}

function expectPrivateContextCleared() {
  expect(sessionStorage.getItem('manji.web2.welcome.flow.v1')).toBeNull();
  expect(pointers.getBiographyId()).toBeNull();
  expect(pointers.getActiveSessionIds()).toEqual([]);
  expect(pointers.getOrganizationSessionId()).toBeNull();
  expect(sessionStorage.getItem('manji.web2.interview.guest-a.old-session')).toBeNull();
  expect(api.hasPreviousGuest()).toBe(false);
}

describe('entry routing through real authentication changes when persistent storage is unavailable', () => {
  it.each(['/web2/welcome.html', '/web2/index.html'])('keeps an expired returning visitor on login after synchronous auth-changed at %s', async path => {
    history.replaceState(null, '', path);
    api.setAuthToken(expiredToken);
    savePrivateContext();
    fetch.mockResolvedValue(response({ detail: { code: 'AUTH_REQUIRED' } }, 401));
    let version = 0, replacement;
    const authChanged = vi.fn(() => {
      const request = ++version;
      replacement = entry.resolveEntry({ isCurrent: () => request === version });
    });
    window.addEventListener('manji:auth-changed', authChanged);
    try {
      const request = version;
      // This is the same cancellation boundary used by the welcome and home pages.
      expect(await entry.resolveEntry({ isCurrent: () => request === version })).toBeNull();
      expect(authChanged).toHaveBeenCalledOnce();
      expect(await replacement).toMatchObject({ destination: 'login', token: '', user: null });
    } finally {
      window.removeEventListener('manji:auth-changed', authChanged);
    }
    expect(api.getAuthToken()).toBe('');
    expectPrivateContextCleared();
    expect(window.localStorage.length).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${expiredToken}` }),
    }));

    // A newly loaded login document must retain the same route from storage alone.
    vi.resetModules();
    const freshEntry = await import('../src/lib/first-visit.js');
    expect(freshEntry.firstVisitReturnUrl()).toBe('');
    expect(await freshEntry.resolveEntry()).toMatchObject({ destination: 'login' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves public welcome/tutorial preferences while clearing private state on account switch', async () => {
    api.setAuthToken(expiredToken);
    entry.markWelcomeShown();
    completeVoiceGuide();
    savePrivateContext();
    expect(entry.firstVisitReturnUrl()).toBe('');
    api.setAuthToken(memberToken);
    expect(api.getAuthToken()).toBe(memberToken);
    expect(entry.hasSeenWelcome()).toBe(true);
    expect(hasCompletedVoiceGuide()).toBe(true);
    expect(entry.firstVisitReturnUrl()).toBe('');
    expectPrivateContextCleared();
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'home', token: memberToken });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${memberToken}`);
  });

  it('removes a legacy prepared guest flow and all private state on logout without replaying welcome', async () => {
    api.setAuthToken('g'.repeat(43));
    entry.markWelcomeShown();
    sessionStorage.setItem('manji.web2.welcome.flow.v1', 'guest:guest-a');
    savePrivateContext();
    fetch.mockResolvedValue(response({ ok: true }));
    await api.logout();
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(api.getAuthToken()).toBe('');
    expect(entry.hasSeenWelcome()).toBe(true);
    expect(entry.firstVisitReturnUrl()).toBe('');
    expectPrivateContextCleared();
    expect(await entry.resolveEntry()).toMatchObject({ destination: 'login' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
