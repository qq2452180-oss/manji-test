export function entryFor(pathname, search = '') {
  const page = pathname.split('/').pop() || 'index.html';
  const params = new URLSearchParams(search);
  if (params.get('prototype') === '1') {
    const prototypePages = { 'index.html': 'home', 'interview.html': 'interview', 'story.html': 'story', 'biography.html': 'biography', 'chapter.html': 'chapter', 'profile.html': 'profile', 'history.html': 'history', 'organizing.html': 'organizing', 'preview.html': 'family' };
    if (prototypePages[page]) return { page: 'prototype-' + prototypePages[page] };
  }
  const aliases = { 'photo.html': 'interview.html', 'text-chat.html': 'interview.html', 'realtime-interview.html': 'interview.html', 'interview-history.html': 'history.html' };
  if (aliases[page]) {
    if (page === 'photo.html') params.set('entry', 'PHOTO');
    if (page === 'text-chat.html') params.set('interaction', 'text');
    if (!params.has('session_id') && aliases[page] === 'interview.html') params.set('new', '1');
    return { redirect: './' + aliases[page] + (params.size ? '?' + params : '') };
  }
  return { page: page.replace(/\.html$/, '') };
}
