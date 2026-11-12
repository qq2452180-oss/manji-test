import * as api from './api.js';

const SEEN_KEY = 'manji.web2.welcome.seen.v1';
const FLOW_KEY = 'manji.web2.welcome.flow.v1';
const read = (area, key) => {
  try { return window[area].getItem(key) || ''; } catch (_) { return ''; }
};
const write = (area, key, value) => {
  try {
    if (value) window[area].setItem(key, value);
    else window[area].removeItem(key);
  } catch (_) { /* The login link also works when storage is blocked. */ }
};

export function hasSeenWelcome() {
  return read('localStorage', SEEN_KEY) === '1' || read('sessionStorage', SEEN_KEY) === '1' || Boolean(read('sessionStorage', FLOW_KEY));
}

function rememberWelcome() {
  write('localStorage', SEEN_KEY, '1');
  write('sessionStorage', SEEN_KEY, '1');
}

export function markWelcomeShown() {
  finishFirstVisit();
}

export function finishFirstVisit() {
  rememberWelcome();
  write('sessionStorage', FLOW_KEY, '');
}

export function firstVisitStartUrl() {
  return entryUrl({ destination: 'login' });
}

export function firstVisitReturnUrl() {
  return hasSeenWelcome() ? '' : './welcome.html';
}

export function entryUrl(context) {
  if (context.destination === 'login') {
    return './login.html?' + (context.user?.is_guest ? 'trial=1&' : '') + 'next=' + encodeURIComponent('/web2/index.html');
  }
  return { welcome: './welcome.html', home: './index.html' }[context.destination];
}

export async function resolveEntry({ isCurrent = () => true } = {}) {
  const token = api.getAuthToken();
  if (!token) {
    if (!isCurrent()) return null;
    const destination = hasSeenWelcome() ? 'login' : 'welcome';
    return { destination, token: '', user: null };
  }
  // An expired credential is still evidence of a returning user. Record it
  // before auth/me can clear the token and publish auth-changed.
  rememberWelcome();
  try {
    const user = await api.getCurrentUser({ redirectOnUnauthorized: false });
    if (!isCurrent() || api.getAuthToken() !== token) return null;
    if (!user?.id || typeof user.is_guest !== 'boolean') throw new Error('暂时无法确认您的身份，请重试。');
    finishFirstVisit();
    return { destination: user.is_guest ? 'login' : 'home', user, token };
  } catch (error) {
    if (!isCurrent()) return null;
    const currentToken = api.getAuthToken();
    if (error.status === 401 && (!currentToken || currentToken === token)) {
      finishFirstVisit();
      return { destination: 'login', token: '', user: null };
    }
    if (currentToken !== token) return null;
    throw error;
  }
}
