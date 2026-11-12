import early from '../content/life-map-demo-early.json';
import later from '../content/life-map-demo-later.json';
import { findLifeMapTopic } from './life-map-topics.js';

// One fictional narrator throughout. These fixtures never represent the account owner.
export const lifeMapDemoEntries = [...early, ...later];
export const lifeMapDemoStories = lifeMapDemoEntries.map((entry, index) => {
  const date = new Date(Date.UTC(2026, 10, 4, 1, index)).toISOString();
  return {
    id: entry.id, chapter_id: entry.chapter_id, content_id: entry.content_id,
    title: entry.title, source: 'fictional-demo', paragraphs: entry.paragraphs,
    createdAt: date, updatedAt: date,
  };
});
export const lifeMapDemoSessions = lifeMapDemoEntries.map((entry, index) => {
  const topic = findLifeMapTopic(entry.chapter_id, entry.content_id);
  const turns = [topic.prompt, ...topic.followups].flatMap((text, questionIndex) => [
    { role: 'assistant', text }, { role: 'user', text: entry.answers[questionIndex] },
  ]);
  const date = lifeMapDemoStories[index].createdAt;
  return {
    id: `demo-life-session-${entry.content_id}`, chapterId: entry.chapter_id, contentId: entry.content_id,
    storyId: entry.id, freeTalk: false, source: 'fictional-demo', status: 'complete',
    turns, turnIndex: turns.length, draft: '', createdAt: date, updatedAt: date, organizingAt: date,
  };
});
export const lifeMapDemoBiographyById = new Map(lifeMapDemoEntries.map(entry => [entry.id, entry.biographyParagraphs]));
export const LIFE_MAP_BIOGRAPHY_TITLE = '把平常的日子记下来';

export function isFictionalDemoStory(story) {
  return story?.source === 'fictional-demo';
}
