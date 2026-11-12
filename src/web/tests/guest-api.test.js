import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, getAuthToken, getCurrentUser, getGuestTrial, setAuthToken, startGuest } from '../src/lib/api.js';

const guest = { token: 'g'.repeat(43), expires_at: '2026-11-01T00:00:00Z', user: { id: 'guest-a', is_guest: true } };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(guest))); });
afterEach(() => vi.unstubAllGlobals());

it('creates a guest through the real API wrapper and saves its opaque token locally', async () => {
  const changed = vi.fn(); window.addEventListener('manji:auth-changed', changed);
  try {
    expect(await startGuest()).toEqual(guest);
    expect(fetch).toHaveBeenCalledWith('/api/auth/guest', expect.objectContaining({ method: 'POST', cache: 'no-store' }));
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(getAuthToken()).toBe(guest.token); expect(changed).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('manji:auth-changed', changed); }
});

it('rejects a malformed guest response without storing credentials', async () => {
  fetch.mockResolvedValue(response({ ...guest, user: { id: 'member', is_guest: false } }));
  await expect(startGuest()).rejects.toMatchObject({ code: 'GUEST_SESSION_INVALID' });
  expect(getAuthToken()).toBe('');
});

it('cannot replace a newer login with a late guest response', async () => {
  const pending = deferred(); fetch.mockReturnValue(pending.promise);
  const creating = startGuest(); setAuthToken('n'.repeat(43)); pending.resolve(response(guest));
  await expect(creating).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
  expect(getAuthToken()).toBe('n'.repeat(43));
});

it('clears only a confirmed expired credential during a quiet experience check', async () => {
  setAuthToken('e'.repeat(43)); fetch.mockResolvedValue(response({ detail: 'expired' }, 401));
  await expect(getCurrentUser({ redirectOnUnauthorized: false })).rejects.toMatchObject({ status: 401 });
  expect(getAuthToken()).toBe('');
});

it.each([true, false])('normalizes the current me user_id while preserving is_guest=%s', async isGuest => {
  setAuthToken(guest.token); fetch.mockResolvedValue(response({ user_id: 12, is_guest: isGuest }));
  await expect(getCurrentUser({ redirectOnUnauthorized: false })).resolves.toEqual({ id: 12, user_id: 12, is_guest: isGuest });
  expect(getAuthToken()).toBe(guest.token);
});

it('retains a credential and its work when explicitly preserving a rejected session check', async () => {
  setAuthToken(guest.token); sessionStorage.setItem('manji.connected.draft.17', 'unfinished-work');
  fetch.mockResolvedValue(response({ detail: 'expired' }, 401));
  await expect(getCurrentUser({ redirectOnUnauthorized: false, preserveAuthOnUnauthorized: true })).rejects.toMatchObject({ status: 401 });
  expect(getAuthToken()).toBe(guest.token);
  expect(sessionStorage.getItem('manji.connected.draft.17')).toBe('unfinished-work');
});

it('keeps the existing token when the session check cannot reach the service', async () => {
  setAuthToken('e'.repeat(43)); fetch.mockRejectedValue(new Error('offline'));
  await expect(getCurrentUser({ redirectOnUnauthorized: false })).rejects.toBeInstanceOf(ApiError);
  expect(getAuthToken()).toBe('e'.repeat(43));
});

it('retrieves only the authenticated guest trial', async () => {
  setAuthToken(guest.token); fetch.mockResolvedValue(response({ session_id: 'trial-a', activity_state: 'PAUSED' }));
  expect(await getGuestTrial()).toEqual({ session_id: 'trial-a', activity_state: 'PAUSED' });
  expect(fetch).toHaveBeenCalledWith('/api/interview/trial', expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${guest.token}` }) }));
});
