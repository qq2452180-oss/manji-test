import { findPrototypeChapter as chapterById } from './life-map-topics.js';

export function resolvePrototypeTopic(search = '') {
  const params = new URLSearchParams(search);
  if (!params.has('chapter_id') && !params.has('content_id')) return { kind: 'free' };
  const chapter = chapterById(params.get('chapter_id'));
  if (params.getAll('chapter_id').length !== 1 || params.getAll('content_id').length !== 1) {
    return { kind: 'invalid', chapter };
  }
  const content = chapter?.core_contents.find(item => item.id === params.get('content_id'));
  return content ? { kind: 'topic', chapter, content } : { kind: 'invalid', chapter };
}

const sources = new Set(['map', 'biography', 'chapter', 'history']);
export function prototypeSource(search = '') {
  const params = new URLSearchParams(search);
  return params.getAll('from').length === 1 && sources.has(params.get('from')) ? params.get('from') : 'map';
}

function withOptions(params, options = {}) {
  if (options.sessionId) params.set('session_id', options.sessionId);
  if (options.storyId) params.set('story_id', options.storyId);
  if (options.returnSessionId) params.set('return_session_id', options.returnSessionId);
  if (sources.has(options.from)) params.set('from', options.from);
  if (options.back === 'story') params.set('back', 'story');
  return params;
}

export function prototypeInterviewUrl(chapterId, contentId, options = {}) {
  const params = new URLSearchParams({ prototype: '1' });
  if (chapterId !== undefined || contentId !== undefined) {
    params.set('chapter_id', chapterId ?? '');
    params.set('content_id', contentId ?? '');
    if (resolvePrototypeTopic(params).kind !== 'topic') return '';
  }
  return './interview.html?' + withOptions(params, options);
}

export function prototypeHomeUrl(chapterId) {
  const params = new URLSearchParams({ prototype: '1' });
  if (chapterById(chapterId)) params.set('chapter_id', chapterId);
  return './index.html?' + params;
}

export function prototypeStoryUrl(chapterId, contentId, options = {}) {
  const params = new URLSearchParams({ prototype: '1', chapter_id: chapterId ?? '', content_id: contentId ?? '' });
  return resolvePrototypeTopic(params).kind === 'topic' ? './story.html?' + withOptions(params, options) : '';
}

export const prototypeBiographyUrl = () => './biography.html?prototype=1';
export const prototypeProfileUrl = () => './profile.html?prototype=1';
export function prototypeChapterUrl(chapterId) {
  return chapterById(chapterId) ? './chapter.html?' + new URLSearchParams({ prototype: '1', chapter_id: chapterId }) : prototypeBiographyUrl();
}
export function prototypeHistoryUrl(sessionId, options = {}) {
  const params = new URLSearchParams({ prototype: '1' });
  return './history.html?' + withOptions(params, { ...options, sessionId });
}
export function prototypeOrganizingUrl(sessionId, options = {}) {
  return './organizing.html?' + withOptions(new URLSearchParams({ prototype: '1' }), { ...options, sessionId });
}

export function prototypeBackLink(search = '', context = {}) {
  const params = new URLSearchParams(search);
  const from = prototypeSource(params);
  const chapterId = context.chapter?.id || context.chapterId || context.session?.chapterId;
  const contentId = context.content?.id || context.contentId || context.session?.contentId;
  const storyId = context.story?.id || context.storyId || context.session?.storyId;
  if (params.get('back') === 'story' && storyId) {
    const sessionId = params.getAll('return_session_id').length === 1 ? params.get('return_session_id') : undefined;
    const href = prototypeStoryUrl(chapterId, contentId, { storyId, sessionId, from });
    if (href) return { href, label: '返回故事' };
  }
  if (from === 'biography') return { href: prototypeBiographyUrl(), label: '返回传记' };
  if (from === 'chapter') return { href: prototypeChapterUrl(chapterId), label: '返回章节' };
  if (from === 'history') return { href: prototypeHistoryUrl(params.get('session_id') || undefined), label: '返回讲述记录' };
  return { href: prototypeHomeUrl(chapterId), label: '返回人生轨迹' };
}
