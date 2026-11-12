import { normalizeId } from './workflow-api.js';
import { safeNext } from './login-helpers.js';

export function loginUrl({ register = false } = {}) {
  const next = safeNext(location.pathname + location.search, location.origin, '/web/');
  return `./login.html?${register ? 'mode=register&' : ''}next=${encodeURIComponent(next)}`;
}

function pageUrl(page, ids = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(ids)) {
    if (value !== null && value !== undefined) params.set(key, normalizeId(value));
  }
  return `./${page}.html${params.size ? `?${params}` : ''}`;
}

export function homeUrl(chapterId) {
  return pageUrl('index', { chapter_id: chapterId });
}

export function interviewUrl({ topicId, chapterId, sessionId, storyId } = {}) {
  return pageUrl('interview', { topic_id: topicId, chapter_id: chapterId, session_id: sessionId, story_id: storyId });
}

export function organizingUrl(sessionId, { storyId } = {}) {
  return pageUrl('organizing', { session_id: normalizeId(sessionId), story_id: storyId });
}

export function storyUrl(storyId, { sessionId } = {}) {
  return pageUrl('story', { story_id: normalizeId(storyId), session_id: sessionId });
}

export function biographyUrl() {
  return pageUrl('biography');
}

export function chapterUrl(chapterId) {
  return pageUrl('chapter', { chapter_id: normalizeId(chapterId) });
}

export function historyUrl(sessionId) {
  return pageUrl('history', { session_id: sessionId });
}
