import { onMounted, onUnmounted } from 'vue';
import * as api from '../lib/api.js';
import { navigate, reloadPage } from '../lib/navigation.js';

export function loginUrl({ trial = false } = {}) {
  const next = location.pathname.startsWith('/web2/') ? location.pathname + location.search : '/web2/';
  return './login.html?' + (trial ? 'trial=1&' : '') + 'next=' + encodeURIComponent(next);
}

export async function requireUser() {
  const token = api.getAuthToken();
  if (!token) { navigate(loginUrl(), { replace: true }); return null; }
  const user = await api.getCurrentUser();
  return token === api.getAuthToken() ? user : null;
}

export async function requireMember({ isCurrent = () => true } = {}) {
  const user = await requireUser();
  if (!user || !isCurrent()) return null;
  if (user.is_guest) { navigate(loginUrl({ trial: true }), { replace: true }); return null; }
  return user;
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Visibility hides private content without destroying a recoverable page.
// Leaving the document, unmounting and HMR share one final resource boundary.
export function usePageLifecycle({ hide = () => {}, show = () => {}, auth = () => {}, destroy = () => {} } = {}) {
  let disposed = false;
  const stop = () => { if (!disposed) { disposed = true; destroy(); } };
  const visibility = () => { if (!disposed) document.hidden ? hide() : show(); };
  const pageHide = () => { if (!disposed) hide(); stop(); };
  const pageShow = event => { if (event.persisted) reloadPage(); };
  const authChanged = () => { if (!disposed) auth(); };
  const remove = () => {
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pageHide);
    window.removeEventListener('pageshow', pageShow);
    window.removeEventListener('manji:auth-changed', authChanged);
    stop();
  };
  onMounted(() => {
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    window.addEventListener('manji:auth-changed', authChanged);
  });
  onUnmounted(remove);
  if (import.meta.hot) import.meta.hot.dispose(remove);
  return remove;
}
