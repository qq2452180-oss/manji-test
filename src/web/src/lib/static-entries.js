import { entryFor } from './entries.js';

// The uploadable site always uses local pages, including direct deep links.
export function staticEntryFor(pathname, search = '') {
  const params = new URLSearchParams(search);
  params.set('prototype', '1');
  const entry = entryFor(pathname, params.toString());
  if (entry.redirect || entry.page === 'login' || entry.page.startsWith('prototype-')) return entry;
  return { redirect: './index.html' };
}
