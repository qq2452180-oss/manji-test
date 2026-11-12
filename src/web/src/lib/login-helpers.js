const pages = new Set(['index.html', 'profile.html', 'profile-edit.html', 'biography.html',
  'chapter.html', 'story.html', 'interview.html', 'history.html', 'organizing.html', 'preview.html']);

export function safeNext(value, origin, base = '/web2/') {
  base = base === '/web/' ? '/web/' : '/web2/';
  const fallback = base + 'index.html';
  if (typeof value !== 'string' || /[\\\u0000-\u0020]/.test(value)) return fallback;
  try {
    const url = new URL(value, origin + base);
    if (url.origin !== origin || url.username || url.password) return fallback;
    if (!url.pathname.startsWith(base)) return fallback;
    if (url.pathname !== base && !pages.has(url.pathname.slice(base.length))) return fallback;
    return url.pathname + url.search;
  } catch (_) { return fallback; }
}

export function loginAccounts(value) {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter(row => row && typeof row === 'object' &&
    typeof row.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.token)).map((row, index) => ({
      token: row.token,
      label: typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 80) : '测试账户 ' + (index + 1),
    }));
}
