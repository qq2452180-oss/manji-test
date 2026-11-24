import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthToken, getCurrentUser, loginAccount, loginWithSms, logout, registerAccount, sessionHeaders } from '../src/lib/api.js';

const id = 'a'.repeat(64), anotherId = 'b'.repeat(64);
const user = { id: 17, username: 'member' };
const session = { session_id: id, user };
const me = { session_id: id, user_id: user.id, is_guest: false };
const marker = 'manji.browser.session_id';
const legacyKey = 'manji.auth_token';
const quiet = { redirectOnUnauthorized: false };
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  history.replaceState(null, '', '/web/login.html');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('persistent browser member login', () => {
  it.each([
    ['/api/auth/sms/login', () => loginWithSms('13800138000', '012345')],
    ['/api/auth/login', () => loginAccount('member', 'password')],
    ['/api/auth/register', () => registerAccount('member', 'password')],
  ])('verifies the cookie set by %s with a same-origin /me before publishing the public id', async (path, action) => {
    fetch.mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(me));
    await expect(action()).resolves.toMatchObject(session);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([path, '/api/auth/me']);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: {
      'X-Manji-Session': 'cookie', 'X-Manji-Session-Id': 'anonymous',
    } });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(localStorage.getItem(marker)).toBe(id);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
    expect(sessionHeaders()).toEqual({ 'X-Manji-Session': 'cookie', 'X-Manji-Session-Id': id });
  });

  it.each([
    [() => json({ detail: '请重新登录' }, 401), 'COOKIE_SESSION_UNAVAILABLE'],
    [() => json({ ...me, session_id: anotherId }), 'AUTH_CONTEXT_CHANGED'],
  ])('rejects a missing or different cookie after an accepted login', async (reply, code) => {
    fetch.mockResolvedValueOnce(json(session)).mockResolvedValueOnce(reply());
    await expect(loginAccount('member', 'pw')).rejects.toMatchObject({ code });
    expect(getAuthToken()).toBe('');
  });

  it('rejects a legacy login response with a raw credential on the connected site', async () => {
    fetch.mockResolvedValueOnce(json({ ...session, token: 's'.repeat(43) }));
    await expect(loginAccount('member', 'pw')).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' });
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });

  it('discovers the HttpOnly session without an existing marker or an extra local identity change', async () => {
    const changed = vi.fn();
    window.addEventListener('manji:auth-changed', changed);
    try {
      fetch.mockResolvedValueOnce(json(me));
      await expect(getCurrentUser(quiet)).resolves.toMatchObject({ id: user.id, ...me });
      expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('X-Manji-Session-Id');
      expect(getAuthToken()).toBe('cookie:' + id);
      expect(changed).not.toHaveBeenCalled();
    } finally { window.removeEventListener('manji:auth-changed', changed); }
  });

  it('rediscovers the current cookie after a stale public marker without retrying a write', async () => {
    localStorage.setItem(marker, anotherId);
    fetch.mockResolvedValueOnce(json({ detail: { code: 'AUTH_CONTEXT_CHANGED' } }, 409)).mockResolvedValueOnce(json(me));
    await expect(getCurrentUser(quiet)).resolves.toMatchObject({ id: user.id });
    expect(fetch.mock.calls.map(([, options]) => options.headers['X-Manji-Session-Id'])).toEqual([anotherId, undefined]);
    expect(getAuthToken()).toBe('cookie:' + id);
  });

  it('can use a verified cookie when shared storage is readable but writes are blocked', async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    });
    fetch.mockResolvedValueOnce(json(me));
    await getCurrentUser(quiet);
    expect(getAuthToken()).toBe('cookie:' + id);
    expect(sessionHeaders()['X-Manji-Session-Id']).toBe(id);
    // Sign out in the same storage-restricted environment.
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await logout();
    expect(getAuthToken()).toBe('');
  });

  it('leaves the confirmed session intact on a transient logout failure', async () => {
    localStorage.setItem(marker, id);
    fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(getAuthToken()).toBe('cookie:' + id);
  });

  it('revokes the current session and accepts an empty 204 with a JSON content type', async () => {
    localStorage.setItem(marker, id);
    sessionStorage.setItem('manji.connected.draft.4', 'draft');
    fetch.mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'Content-Type': 'application/json' } }));
    await expect(logout()).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/logout');
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-Manji-Session-Id': id });
    expect(getAuthToken()).toBe('');
    expect(sessionStorage.getItem('manji.connected.draft.4')).toBeNull();
  });

  it('migrates only the verified guest’s connected drafts on same-account registration', async () => {
    const guest = 'g'.repeat(43);
    sessionStorage.setItem(legacyKey, guest);
    sessionStorage.setItem('manji.connected.draft.4', JSON.stringify({ owner: guest, text: '草稿' }));
    sessionStorage.setItem('manji.connected.draft.9', JSON.stringify({ owner: 'other' }));
    fetch.mockResolvedValueOnce(json({ ...me, is_guest: true, session_id: anotherId }))
      .mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(me));
    await registerAccount('member', 'pw');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer ' + guest);
    expect(fetch.mock.calls[2][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.4'))).toEqual({ owner: 'cookie:' + id, text: '草稿' });
    expect(sessionStorage.getItem('manji.connected.draft.9')).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain(guest);
  });

  it('upgrades an existing member tab once, verifies the cookie and reassigns only that account’s drafts', async () => {
    const legacy = 'old-member-token';
    sessionStorage.setItem(legacyKey, legacy);
    sessionStorage.setItem('manji.connected.draft.3', JSON.stringify({ owner: legacy, text: '以前的讲述' }));
    fetch.mockResolvedValueOnce(json({ ...me, session_id: anotherId }))
      .mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(me));
    const [first, second] = await Promise.all([getCurrentUser(quiet), getCurrentUser(quiet)]);
    expect(first).toEqual(second);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me', '/api/auth/session/upgrade', '/api/auth/me']);
    expect(fetch.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer ' + legacy, 'X-Manji-Session-Id': anotherId });
    expect(fetch.mock.calls[2][1].headers.Authorization).toBeUndefined();
    expect(getAuthToken()).toBe('cookie:' + id);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.3'))).toEqual({ owner: 'cookie:' + id, text: '以前的讲述' });
  });

  it('recovers an upgrade interrupted after the cookie rotated and preserves the verified member’s draft', async () => {
    sessionStorage.setItem(legacyKey, 'legacy-member');
    sessionStorage.setItem('manji.connected.draft.4', JSON.stringify({ owner: 'legacy-member', text: '草稿' }));
    fetch.mockResolvedValueOnce(json({ ...me, session_id: anotherId })).mockRejectedValueOnce(new Error('offline'));
    await expect(getCurrentUser(quiet)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(getAuthToken()).toBe('legacy-member');
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.4')).owner).toBe('legacy-member');
    fetch.mockResolvedValueOnce(json({ detail: { code: 'AUTH_CONTEXT_CHANGED' } }, 409)).mockResolvedValueOnce(json(me));
    await expect(getCurrentUser(quiet)).resolves.toMatchObject(me);
    expect(getAuthToken()).toBe('cookie:' + id);
    expect(JSON.parse(sessionStorage.getItem('manji.connected.draft.4'))).toEqual({ owner: 'cookie:' + id, text: '草稿' });
  });

  it('rechecks the owner after acquiring the cross-tab lock before mutating a cookie', async () => {
    const gate = Promise.withResolvers();
    const lock = vi.fn(async (_name, callback) => { await gate.promise; return callback(); });
    vi.stubGlobal('navigator', { locks: { request: lock } });
    const login = loginAccount('member', 'pw');
    expect(lock).toHaveBeenCalledWith('manji.browser.session', expect.any(Function));
    localStorage.setItem(marker, anotherId);
    gate.resolve();
    await expect(login).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cleans private tab state and notifies readers after another tab switches the shared session', async () => {
    fetch.mockResolvedValueOnce(json(me));
    await getCurrentUser(quiet);
    sessionStorage.setItem('manji.connected.draft.4', 'old');
    const changed = vi.fn();
    window.addEventListener('manji:auth-changed', changed);
    try {
      localStorage.setItem(marker, anotherId);
      window.dispatchEvent(new StorageEvent('storage', { key: marker, oldValue: id, newValue: anotherId, storageArea: localStorage }));
      expect(getAuthToken()).toBe('cookie:' + anotherId);
      expect(sessionStorage.getItem('manji.connected.draft.4')).toBeNull();
      expect(changed).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('manji:auth-changed', changed); }
  });

  it('discards a late rejected logout when another tab has already selected a newer session', async () => {
    localStorage.setItem(marker, id);
    let finish;
    fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const leaving = logout();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    localStorage.setItem(marker, anotherId);
    finish(json({ detail: '已过期' }, 401));
    await expect(leaving).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(getAuthToken()).toBe('cookie:' + anotherId);
  });
});
