import { describe, expect, it } from 'vitest';
import { staticEntryFor } from '../src/lib/static-entries.js';

describe('uploadable html entry points', () => {
  it.each(['', 'index.html'])('opens the map without query parameters at /html/%s', path => {
    expect(staticEntryFor('/html/' + path)).toEqual({ page: 'prototype-home' });
  });

  it.each(['interview', 'story', 'biography', 'chapter', 'profile', 'history', 'organizing'])('keeps direct %s links in the local pages', page => {
    expect(staticEntryFor(`/html/${page}.html`, '?prototype=0&chapter_id=L1')).toEqual({ page: `prototype-${page}` });
  });

  it('retains session context when resolving an old narration link', () => {
    const result = staticEntryFor('/html/interview-history.html', '?session_id=old-session');
    const url = new URL(result.redirect, 'https://example.test/html/');
    expect(url.pathname).toBe('/html/history.html');
    expect(url.searchParams.get('session_id')).toBe('old-session');
    expect(url.searchParams.get('prototype')).toBe('1');
  });

  it('keeps login local and redirects unsupported account pages to the map', () => {
    expect(staticEntryFor('/html/login.html')).toEqual({ page: 'login' });
    expect(staticEntryFor('/html/profile-edit.html')).toEqual({ redirect: './index.html' });
    expect(staticEntryFor('/html/welcome.html')).toEqual({ redirect: './index.html' });
  });
});
