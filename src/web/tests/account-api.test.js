import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthToken, hasPreviousGuest, loginAccount, registerAccount, restoreGuest, setAuthToken } from '../src/lib/api.js';

const guestToken = 'g'.repeat(43), memberToken = 'm'.repeat(43), otherToken = 'o'.repeat(43);
const member = { token: memberToken, expires_at: '2026-11-01T00:00:00Z', user: { id: 'member-a', is_guest: false } };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(member))); });
afterEach(() => vi.unstubAllGlobals());

describe('account credentials', () => {
  it('accepts the current login response and marks the signed-in user as a member', async () => {
    fetch.mockResolvedValue(response({ token: memberToken, user: { id: 12, username: 'xiao_li', create_time: '2026-11-08T12:00:00Z' } }));
    await expect(loginAccount('  Xiao_Li  ', '  password  ')).resolves.toMatchObject({ token: memberToken, user: { id: 12, username: 'xiao_li', is_guest: false } });
    expect(getAuthToken()).toBe(memberToken);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ username: 'xiao_li', password: '  password  ' });
  });

  it('upgrades the current guest without rotating its token or invalidating saved draft owners', async () => {
    setAuthToken(guestToken);
    const draft = JSON.stringify({ owner: guestToken, text: '还没提交的回忆', pendingInput: { text: '等候重试的回忆', client_input_id: 'input-a' } });
    sessionStorage.setItem('manji.connected.draft.17', draft);
    sessionStorage.setItem('manji.connected.biography_id', 'guest-book');
    sessionStorage.setItem('manji.previous_guest_token', otherToken);
    fetch.mockResolvedValue(response({ id: 12, username: 'xiao_li', create_time: '2026-11-08T12:00:00Z' }, 201));
    const changed = vi.fn(); window.addEventListener('manji:auth-changed', changed);
    try {
      await expect(registerAccount('  Xiao_Li  ', '  password  ')).resolves.toMatchObject({ token: guestToken, user: { id: 12, is_guest: false } });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe('/api/auth/register');
      expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${guestToken}`);
      expect(getAuthToken()).toBe(guestToken);
      expect(sessionStorage.getItem('manji.connected.draft.17')).toBe(draft);
      expect(sessionStorage.getItem('manji.connected.biography_id')).toBe('guest-book');
      expect(hasPreviousGuest()).toBe(false);
      expect(changed).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('manji:auth-changed', changed); }
  });

  it('logs in after anonymous registration using the same normalized credentials', async () => {
    fetch.mockResolvedValueOnce(response({ id: 12, username: 'new_user' }, 201))
      .mockResolvedValueOnce(response({ token: memberToken, user: { id: 12, username: 'new_user' } }));
    await expect(registerAccount('  New_User  ', '  password  ')).resolves.toMatchObject({ token: memberToken, user: { id: 12, is_guest: false } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/register', '/api/auth/login']);
    for (const [, options] of fetch.mock.calls) {
      expect(options.headers.Authorization).toBeUndefined();
      expect(JSON.parse(options.body)).toEqual({ username: 'new_user', password: '  password  ' });
    }
    expect(getAuthToken()).toBe(memberToken);
    expect(Object.values(sessionStorage)).not.toContain('  password  ');
  });

  it.each(['rejected', 'offline', 'malformed'])('reports a created account when automatic login is %s', async failure => {
    sessionStorage.setItem('manji.connected.draft.17', 'existing-work');
    fetch.mockResolvedValueOnce(response({ id: 12, username: 'new_user' }, 201));
    if (failure === 'offline') fetch.mockRejectedValueOnce(new Error('offline'));
    else fetch.mockResolvedValueOnce(failure === 'rejected'
      ? response({ detail: '登录暂时不可用' }, 401) : response({ token: 'invalid', user: { id: 12 } }));
    await expect(registerAccount('new_user', 'password')).rejects.toMatchObject({ code: 'REGISTRATION_LOGIN_REQUIRED', message: expect.stringContaining('账号已创建') });
    expect(getAuthToken()).toBe('');
    expect(sessionStorage.getItem('manji.connected.draft.17')).toBe('existing-work');
  });

  it('does not replace a newer identity after anonymous registration starts automatic login', async () => {
    const pending = deferred();
    fetch.mockResolvedValueOnce(response({ id: 12, username: 'new_user' }, 201)).mockReturnValueOnce(pending.promise);
    const registering = registerAccount('new_user', 'password');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    setAuthToken(otherToken);
    pending.resolve(response({ token: memberToken, user: { id: 12 } }));
    await expect(registering).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(getAuthToken()).toBe(otherToken);
  });

  it('registers with the original guest Bearer and preserves same-owner work without retaining its revoked token', async () => {
    setAuthToken(guestToken);
    sessionStorage.setItem('manji.web2.biography_id', 'guest-book');
    sessionStorage.setItem('manji.web2.interview.guest-a.session-a', '{"finishRequested":true}');
    sessionStorage.setItem('manji.previous_guest_token', otherToken);
    await registerAccount('  Xiao_Li  ', '  password  ');
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/register'); expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe(`Bearer ${guestToken}`);
    expect(JSON.parse(options.body)).toEqual({ username: 'xiao_li', password: '  password  ' });
    expect(getAuthToken()).toBe(memberToken); expect(hasPreviousGuest()).toBe(false);
    expect(sessionStorage.getItem('manji.web2.biography_id')).toBe('guest-book');
    expect(sessionStorage.getItem('manji.web2.interview.guest-a.session-a')).toBe('{"finishRequested":true}');
    expect(Object.values(sessionStorage)).not.toContain('  password  ');
  });

  it('clears business pointers when switching accounts and retains only the verified guest credential', async () => {
    setAuthToken(guestToken); sessionStorage.setItem('manji.web2.biography_id', 'guest-book');
    sessionStorage.setItem('manji.web2.interview.guest-a.session-a', 'private-draft');
    await loginAccount('xiao_li', 'password', { preserveGuest: true });
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/login');
    expect(getAuthToken()).toBe(memberToken); expect(hasPreviousGuest()).toBe(true);
    expect(sessionStorage.getItem('manji.previous_guest_token')).toBe(guestToken);
    expect(sessionStorage.getItem('manji.web2.biography_id')).toBeNull();
    expect(sessionStorage.getItem('manji.web2.interview.guest-a.session-a')).toBeNull();
  });

  it('does not keep previous credentials on an ordinary account login or anonymous registration', async () => {
    setAuthToken(guestToken); await loginAccount('xiao_li', 'password');
    expect(hasPreviousGuest()).toBe(false);
    setAuthToken(''); sessionStorage.setItem('manji.web2.biography_id', 'stale-book');
    await registerAccount('new_user', 'password');
    expect(sessionStorage.getItem('manji.web2.biography_id')).toBeNull();
  });

  it.each([['login', loginAccount], ['register', registerAccount]])('%s validation failure preserves the guest token and its work', async (_name, action) => {
    setAuthToken(guestToken); sessionStorage.setItem('manji.web2.biography_id', 'guest-book');
    const changed = vi.fn(); window.addEventListener('manji:auth-changed', changed);
    try {
      fetch.mockResolvedValue(response({ detail: { code: 'INVALID_CREDENTIALS', message: '账号或密码不正确' } }, 401));
      await expect(action('xiao_li', 'wrong-password')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
      expect(getAuthToken()).toBe(guestToken); expect(sessionStorage.getItem('manji.web2.biography_id')).toBe('guest-book');
      expect(changed).not.toHaveBeenCalled();
    } finally { window.removeEventListener('manji:auth-changed', changed); }
  });

  it('discards both successful and rejected account responses after another identity is selected', async () => {
    for (const status of [200, 401]) {
      setAuthToken(guestToken); const pending = deferred();
      fetch.mockResolvedValue({ ...response({}, status), json: () => pending.promise });
      const loggingIn = loginAccount('xiao_li', 'password'); await Promise.resolve();
      setAuthToken(otherToken); pending.resolve(status === 200 ? member : { detail: { code: 'INVALID_CREDENTIALS' } });
      await expect(loggingIn).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
      expect(getAuthToken()).toBe(otherToken); expect(hasPreviousGuest()).toBe(false);
    }
  });

  it('rejects malformed credential responses without changing the active guest', async () => {
    setAuthToken(guestToken); fetch.mockResolvedValue(response({ ...member, token: 'invalid' }));
    await expect(loginAccount('xiao_li', 'password')).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' });
    expect(getAuthToken()).toBe(guestToken);
  });

  it('rejects an explicitly guest login response without changing the active identity', async () => {
    setAuthToken(guestToken); fetch.mockResolvedValue(response({ ...member, user: { id: 12, is_guest: true } }));
    await expect(loginAccount('xiao_li', 'password')).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' });
    expect(getAuthToken()).toBe(guestToken);
  });
});

describe('return to a preserved guest', () => {
  beforeEach(() => { setAuthToken(memberToken); sessionStorage.setItem('manji.previous_guest_token', guestToken); });

  it('validates with the guest Bearer before replacing the current account', async () => {
    const pending = deferred(); fetch.mockReturnValue(pending.promise);
    const restoring = restoreGuest(); expect(getAuthToken()).toBe(memberToken);
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/me');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${guestToken}`);
    pending.resolve(response({ id: 'guest-a', is_guest: true }));
    await expect(restoring).resolves.toMatchObject({ id: 'guest-a' });
    expect(getAuthToken()).toBe(guestToken); expect(hasPreviousGuest()).toBe(false);
  });

  it('restores a guest using the current me endpoint user_id response', async () => {
    fetch.mockResolvedValue(response({ user_id: 12, is_guest: true }));
    await expect(restoreGuest()).resolves.toMatchObject({ id: 12, user_id: 12, is_guest: true });
    expect(getAuthToken()).toBe(guestToken);
    expect(hasPreviousGuest()).toBe(false);
  });

  it('drops an expired backup without logging out the current member', async () => {
    fetch.mockResolvedValue(response({ detail: { code: 'AUTH_REQUIRED' } }, 401));
    await expect(restoreGuest()).rejects.toMatchObject({ code: 'PREVIOUS_GUEST_UNAVAILABLE' });
    expect(getAuthToken()).toBe(memberToken); expect(hasPreviousGuest()).toBe(false);
  });

  it('retains both credentials when verification cannot reach the service', async () => {
    fetch.mockRejectedValue(new Error('offline'));
    await expect(restoreGuest()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(getAuthToken()).toBe(memberToken); expect(hasPreviousGuest()).toBe(true);
  });

  it('rejects a backup that no longer represents a guest', async () => {
    fetch.mockResolvedValue(response({ id: 'guest-a', is_guest: false }));
    await expect(restoreGuest()).rejects.toMatchObject({ code: 'PREVIOUS_GUEST_UNAVAILABLE' });
    expect(getAuthToken()).toBe(memberToken); expect(hasPreviousGuest()).toBe(false);
  });

  it.each([200, 401])('ignores a late restore status %s after the member changed', async status => {
    const pending = deferred(); fetch.mockReturnValue(pending.promise);
    const restoring = restoreGuest(); setAuthToken(otherToken); sessionStorage.setItem('manji.previous_guest_token', 'n'.repeat(43));
    pending.resolve(response({ id: 'guest-a', is_guest: true }, status));
    await expect(restoring).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(getAuthToken()).toBe(otherToken); expect(sessionStorage.getItem('manji.previous_guest_token')).toBe('n'.repeat(43));
  });
});
