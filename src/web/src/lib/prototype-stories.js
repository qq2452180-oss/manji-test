import { getPrototypeState } from './prototype-state.js';
import { resolvePrototypeTopic } from './prototype-topic.js';

// Fictional fixtures for the prototype; never read or write account story data.
export function getPrototypeStories(chapterId, contentId) {
  const context = resolvePrototypeTopic(new URLSearchParams({ chapter_id: chapterId ?? '', content_id: contentId ?? '' }));
  if (context.kind !== 'topic') return [];
  return getPrototypeState().stories.filter(story => story.chapter_id === chapterId && story.content_id === contentId);
}
