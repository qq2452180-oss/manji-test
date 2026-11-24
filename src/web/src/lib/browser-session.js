// Only the public session identifier is shared. The browser manages the login cookie.
const COOKIE_SESSION_KEY = 'manji.browser.session_id';
const LEGACY_UPGRADE_KEY = 'manji.browser.session_upgrade';
export const AUTH_TOKEN_KEY = 'manji.auth_token';
export const PREVIOUS_GUEST_KEY = 'manji.previous_guest_token';
const PREFERENCES = new Set(['manji.web2.welcome.seen.v1', 'manji.web2.voice-guide.completed.v1']);
const COOKIE_PREFIX = 'cookie:';
let memorySessionId = '';
let sharedWriteFailed = false;

export function usesCookieSession() {
  return window.location?.pathname?.startsWith('/web/');
}

function tabValue(key) {
  try { return window.sessionStorage.getItem(key) || ''; }
  catch { return ''; }
}

function sharedSessionId() {
  let id = tabValue(COOKIE_SESSION_KEY) || memorySessionId;
  if (!sharedWriteFailed) {
    try { id = window.localStorage.getItem(COOKIE_SESSION_KEY); }
    catch { /* Fall back to the current tab's last verified identifier. */ }
  }
  return validSessionId(id) ? id : '';
}

export function validSessionId(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export function cookieOwner(id) { return COOKIE_PREFIX + id; }
export function isCookieOwner(owner) { return owner.startsWith(COOKIE_PREFIX); }

export function rememberLegacyUser(user) {
  try {
    window.sessionStorage.setItem(LEGACY_UPGRADE_KEY, JSON.stringify({ userId: String(user.id), sessionId: user.session_id }));
  } catch { /* Current-document migration can still finish without this retry hint. */ }
}

export function legacyUser() {
  try { return JSON.parse(tabValue(LEGACY_UPGRADE_KEY)); }
  catch { return null; }
}

// Existing callers also use this as their draft/request owner. A cookie owner is public.
export function getAuthToken() {
  const id = usesCookieSession() && sharedSessionId();
  return id ? cookieOwner(id) : tabValue(AUTH_TOKEN_KEY);
}

export function sessionHeaders(headers = {}, owner = getAuthToken()) {
  if (!usesCookieSession()) return owner ? { ...headers, Authorization: 'Bearer ' + owner } : headers;
  const result = { ...headers, 'X-Manji-Session': 'cookie' };
  if (isCookieOwner(owner)) result['X-Manji-Session-Id'] = owner.slice(COOKIE_PREFIX.length);
  else if (owner) result.Authorization = 'Bearer ' + owner;
  return result;
}

function cleanTab(draftOwner, nextOwner) {
  const storage = window.sessionStorage;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith('manji.') || PREFERENCES.has(key)) continue;
    if (draftOwner && key.startsWith('manji.connected.draft.')) {
      try {
        const draft = JSON.parse(storage.getItem(key));
        if (draft.owner === draftOwner) {
          storage.setItem(key, JSON.stringify({ ...draft, owner: nextOwner }));
          continue;
        }
      } catch { /* Drop an unreadable draft during the identity change. */ }
    }
    storage.removeItem(key);
  }
}

function notifyChange() {
  window.dispatchEvent?.(new Event('manji:auth-changed'));
}

export function setAuthToken(token) {
  cleanTab();
  if (token) window.sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  notifyChange();
}

function rememberTab(id, draftOwner) {
  memorySessionId = id;
  try {
    cleanTab(draftOwner, cookieOwner(id));
    if (id) window.sessionStorage.setItem(COOKIE_SESSION_KEY, id);
  } catch { /* Cookies continue to work when tab storage is blocked. */ }
}

export function setCookieSession(id, { notify = true, draftOwner = '', upgradeFrom = '' } = {}) {
  const prior = getAuthToken();
  if (!id || id !== tabValue(COOKIE_SESSION_KEY) || tabValue(AUTH_TOKEN_KEY)) rememberTab(id, draftOwner);
  try {
    // Other already-verified tabs can recognize the same credential rotation.
    if (upgradeFrom) window.localStorage.setItem(LEGACY_UPGRADE_KEY, JSON.stringify({ from: upgradeFrom, to: id }));
    else window.localStorage.removeItem(LEGACY_UPGRADE_KEY);
    if (id) window.localStorage.setItem(COOKIE_SESSION_KEY, id);
    else window.localStorage.removeItem(COOKIE_SESSION_KEY);
    sharedWriteFailed = false;
  } catch { sharedWriteFailed = true; }
  if (notify && prior !== (id ? cookieOwner(id) : '')) notifyChange();
}

function reconcileTab(event) {
  if (!usesCookieSession()) return;
  if (event?.type === 'storage') sharedWriteFailed = false;
  const id = sharedSessionId();
  const tabId = tabValue(COOKIE_SESSION_KEY), legacy = tabValue(AUTH_TOKEN_KEY);
  if (tabId === id && !(id && legacy)) return;
  let draftOwner = '';
  if (id && legacy) {
    try {
      const rotation = JSON.parse(window.localStorage.getItem(LEGACY_UPGRADE_KEY));
      if (rotation?.to === id && typeof rotation.from === 'string' && rotation.from === legacyUser()?.sessionId) draftOwner = legacy;
    } catch { /* Different or unknown accounts must drop the old drafts. */ }
  }
  rememberTab(id, draftOwner);
  if (event?.type === 'storage' || tabId || legacy) notifyChange();
}

window.addEventListener?.('storage', event => {
  if (event.key === COOKIE_SESSION_KEY || event.key === null) reconcileTab(event);
});
window.addEventListener?.('pageshow', reconcileTab);
