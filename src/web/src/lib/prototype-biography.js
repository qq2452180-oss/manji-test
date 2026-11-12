import { prototypeChapters } from './life-map-topics.js';
import seeds from '../content/prototype-stories.json';
import bookends from '../content/prototype-biography-bookends.json';
import { lifeMapDemoStories, lifeMapDemoBiographyById } from './life-map-demo.js';
import { findLifeMapTopic } from './life-map-topics.js';
import manuscript from '../content/life-map-biography.json';

export const prototypeBiographyChapters = manuscript.chapters;

// Fixed links between existing memories; these never add biographical facts.
const transitions = {
  origins: '关于来处，还有一些回忆。',
  childhood: '说起童年，还有一些小事值得记下。',
  adolescence: '关于少年与成长，我也记下这些片段。',
  entering_society: '说到走向社会，我想起这些经历。',
  livelihood: '谋生与劳动，也是我讲述的一部分。',
  family_and_relationships: '关于家人和重要的关系，我还有这些记忆。',
  turning_points: '人生中的变化，也留下了一些记忆。',
  life_today: '',
};
const bookendSeeds = new Map(seeds.filter(seed => Object.hasOwn(bookends, seed.id)).map(seed => [seed.id, seed]));
const lifeMapSeeds = new Map(lifeMapDemoStories.map(seed => [seed.id, seed]));
const legacySeeds = new Map(seeds.map(seed => [seed.id, seed]));
const sameTopic = (left, right) => left.chapter_id === right.chapter_id && left.content_id === right.content_id;
const originalPrefix = (story, seed) => seed && sameTopic(story, seed)
  && seed.paragraphs.every((paragraph, index) => story.paragraphs[index] === paragraph);

function readingParagraphs(story) {
  const lifeMapSeed = lifeMapSeeds.get(story.id);
  if (originalPrefix(story, lifeMapSeed)) {
    return [...lifeMapDemoBiographyById.get(story.id), ...story.paragraphs.slice(lifeMapSeed.paragraphs.length)];
  }
  const seed = bookendSeeds.get(story.id);
  // Only edit a known demo passage. Changed or newly told stories keep their own words.
  if (!seed || seed.chapter_id !== story.chapter_id || seed.content_id !== story.content_id
    || !seed.paragraphs.every((paragraph, index) => story.paragraphs[index] === paragraph)) return story.paragraphs;
  return [...bookends[story.id], ...story.paragraphs.slice(seed.paragraphs.length)];
}
const chapterContents = new Map(prototypeChapters.map(chapter => [chapter.id, new Set(chapter.core_contents.map(content => content.id))]));
const createdTime = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const compareStories = (left, right) => createdTime(left.createdAt) - createdTime(right.createdAt)
  || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

function appendPassage(stage, stories, paragraphs) {
  const paragraphStart = stage.paragraphs.length;
  stage.paragraphs.push(...paragraphs);
  // A merged passage can cite several original stories. Their original chapter
  // stays attached even when a cross-cutting memory moves into a life stage.
  stage.sources.push(...stories.map(story => ({
    storyId: story.id, contentId: story.content_id, chapterId: story.chapter_id,
    paragraphStart, paragraphCount: paragraphs.length,
  })));
}

// A reading projection only: source paragraphs and storage remain untouched.
export function composePrototypeBiography(stories = []) {
  if (!Array.isArray(stories)) return [];
  const seen = new Set();
  const available = [];
  for (const story of stories) {
    if (!story || typeof story.id !== 'string' || !story.id.trim() || seen.has(story.id)
      || !chapterContents.get(story.chapter_id)?.has(story.content_id) || !Array.isArray(story.paragraphs)) continue;
    const paragraphs = story.paragraphs.filter(paragraph => typeof paragraph === 'string' && paragraph.trim());
    if (!paragraphs.length) continue;
    seen.add(story.id);
    available.push({ ...story, paragraphs });
  }

  const stages = [];
  const hasLifeMapStories = available.some(story => findLifeMapTopic(story.chapter_id, story.content_id));
  // The old sample set remains accessible at its original URLs. Its unchanged
  // passages do not repeat the same fictional life after the new eight chapters.
  const included = available.filter(story => {
    const legacy = legacySeeds.get(story.id);
    return !hasLifeMapStories || !originalPrefix(story, legacy)
      || story.paragraphs.length !== legacy.paragraphs.length || story.title !== legacy.title;
  });
  const used = new Set();
  const appendRemaining = (stage, chapter) => {
    for (const content of chapter.core_contents) {
      const ordered = included.filter(story => !used.has(story.id) && story.chapter_id === chapter.id && story.content_id === content.id).sort(compareStories);
      for (const story of ordered) {
        appendPassage(stage, [story], readingParagraphs(story));
        used.add(story.id);
      }
    }
  };
  for (const chapter of manuscript.chapters) {
    const stage = { id: chapter.id, title: chapter.title, transition: '', paragraphs: [], sources: [] };
    for (const passage of chapter.passages) {
      const originals = passage.storyIds.map(id => included.find(story => story.id === id
        && lifeMapSeeds.has(id) && sameTopic(story, lifeMapSeeds.get(id))));
      const present = originals.filter(Boolean);
      if (!present.length) continue;
      if (originals.every(story => story && originalPrefix(story, lifeMapSeeds.get(story.id)))) {
        const additions = present.flatMap(story => story.paragraphs.slice(lifeMapSeeds.get(story.id).paragraphs.length));
        appendPassage(stage, present, [...passage.paragraphs, ...additions]);
      } else {
        // Never fill gaps in a partial or edited collection with details from an
        // absent story. Keep each available story's independent reading version.
        for (const story of present) appendPassage(stage, [story], readingParagraphs(story));
      }
      present.forEach(story => used.add(story.id));
    }
    appendRemaining(stage, prototypeChapters.find(item => item.id === chapter.id));
    if (stage.paragraphs.length) stages.push(stage);
  }
  for (const chapter of prototypeChapters.filter(item => !manuscript.chapters.some(stage => stage.id === item.id))) {
    const stage = { id: chapter.id, title: chapter.id === 'X' ? '另外记起的往事' : chapter.title,
      transition: stages.length ? (transitions[chapter.id] || '') : '', paragraphs: [], sources: [] };
    appendRemaining(stage, chapter);
    if (stage.paragraphs.length) stages.push(stage);
  }
  return stages;
}
