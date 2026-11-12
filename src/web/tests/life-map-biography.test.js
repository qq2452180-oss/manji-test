import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import manuscript from '../src/content/life-map-biography.json';
import { lifeMapDemoStories, lifeMapDemoSessions, lifeMapDemoBiographyById, LIFE_MAP_BIOGRAPHY_TITLE } from '../src/lib/life-map-demo.js';
import { lifeMapChapters } from '../src/lib/life-map-topics.js';
import { composePrototypeBiography, prototypeBiographyChapters } from '../src/lib/prototype-biography.js';
import { PROTOTYPE_STORAGE_KEY, getPrototypeState } from '../src/lib/prototype-state.js';
import { getPrototypeStoryImage } from '../src/lib/prototype-images.js';
import PrototypeBiographyPage from '../src/pages/PrototypeBiographyPage.vue';
import PrototypeHomePage from '../src/pages/PrototypeHomePage.vue';

vi.mock('../src/lib/prototype-images.js', () => ({ getPrototypeStoryImage: vi.fn(() => null) }));

const passages = manuscript.chapters.flatMap(chapter => chapter.passages.map(passage => ({ ...passage, chapterId: chapter.id })));
const mergedPassages = passages.filter(passage => passage.storyIds.length > 1);
const sourceById = new Map(lifeMapDemoStories.map(story => [story.id, story]));
const text = stages => stages.flatMap(stage => stage.paragraphs);
const sourceIds = stages => stages.flatMap(stage => stage.sources.map(source => source.storyId));
const sourceLocation = (stages, id) => {
  const stage = stages.find(stage => stage.sources.some(source => source.storyId === id));
  const source = stage?.sources.find(source => source.storyId === id);
  return { stage, source, paragraphs: source ? stage.paragraphs.slice(source.paragraphStart, source.paragraphStart + source.paragraphCount) : [] };
};
const clone = value => structuredClone(value);
const paragraphCount = manuscript.chapters.reduce((count, chapter) => count + chapter.passages.reduce((sum, passage) => sum + passage.paragraphs.length, 0), 0);

function ownStory(id, chapterId, contentId, paragraphs) {
  return { id, chapter_id: chapterId, content_id: contentId, title: '自己记录的故事', paragraphs,
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' };
}

describe('polished biography manuscript', () => {
  it('covers every source once across seven literary chapters, while preserving the eight-category map and original answers', () => {
    expect(manuscript.revision).toBe(2);
    expect(manuscript.title).toBe(LIFE_MAP_BIOGRAPHY_TITLE);
    expect(manuscript.chapters.map(chapter => chapter.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
    expect(prototypeBiographyChapters).toEqual(manuscript.chapters);
    const ids = passages.flatMap(passage => passage.storyIds);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    expect([...ids].sort()).toEqual(lifeMapDemoStories.map(story => story.id).sort());
    expect(mergedPassages.length).toBeGreaterThan(0);
    expect(paragraphCount).toBeLessThan(48);
    for (const chapter of manuscript.chapters) {
      expect(chapter.title.trim()).toBeTruthy();
      expect(chapter.passages.length).toBeGreaterThan(0);
      for (const passage of chapter.passages) {
        expect(passage.storyIds.length).toBeGreaterThan(0);
        expect(passage.paragraphs.length).toBeGreaterThan(0);
        expect(passage.paragraphs.every(paragraph => typeof paragraph === 'string' && paragraph.trim())).toBe(true);
      }
    }
    const state = getPrototypeState();
    expect(state.seedRevision).toBe(4);
    expect(state.stories).toHaveLength(41);
    expect(state.sessions).toEqual(lifeMapDemoSessions);
    expect(lifeMapChapters.map(chapter => chapter.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'X']);
    expect(lifeMapChapters.flatMap(chapter => chapter.core_contents)).toHaveLength(100);
    const map = mount(PrototypeHomePage);
    expect(map.findAll('[role="tab"]')).toHaveLength(8);
    expect(map.get('[data-testid="chapter-X"]').text()).toContain('横向主题');
  });

  it('renders each merged passage only once while its sources share a valid paragraph range', () => {
    const stages = composePrototypeBiography(lifeMapDemoStories);
    expect(stages).toHaveLength(7);
    expect(text(stages)).toEqual(passages.flatMap(passage => passage.paragraphs));
    expect(text(stages)).toHaveLength(paragraphCount);
    expect(new Set(text(stages)).size).toBe(paragraphCount);
    expect(sourceIds(stages)).toEqual(passages.flatMap(passage => passage.storyIds));
    for (const chapter of manuscript.chapters) {
      const stage = stages.find(stage => stage.id === chapter.id);
      let position = 0;
      for (const passage of chapter.passages) {
        for (const id of passage.storyIds) {
          const seed = sourceById.get(id);
          const located = sourceLocation(stages, id);
          expect(located.source).toEqual({ storyId: id, chapterId: seed.chapter_id, contentId: seed.content_id,
            paragraphStart: position, paragraphCount: passage.paragraphs.length });
          expect(located.paragraphs).toEqual(passage.paragraphs);
        }
        position += passage.paragraphs.length;
      }
      expect(position).toBe(stage.paragraphs.length);
    }
  });

  it.each([
    ['MJ2-X-03', 'L2'], ['MJ2-X-05', 'L3'], ['MJ2-X-16', 'L5'],
  ])('places known transverse topic %s in %s and retains its original chapter identity', (contentId, chapterId) => {
    const seed = lifeMapDemoStories.find(story => story.content_id === contentId);
    const stages = composePrototypeBiography(lifeMapDemoStories);
    const located = sourceLocation(stages, seed.id);
    expect(located.stage.id).toBe(chapterId);
    expect(located.source.chapterId).toBe('X');
    expect(stages.some(stage => stage.id === 'X')).toBe(false);
    const edited = { ...seed, paragraphs: ['这是我修改过的横向主题正文。'] };
    const onlyEdited = composePrototypeBiography([edited]);
    expect(onlyEdited.map(stage => stage.id)).toEqual([chapterId]);
    expect(text(onlyEdited)).toEqual(edited.paragraphs);
    expect(sourceLocation(onlyEdited, edited.id).source.chapterId).toBe('X');
  });
});

describe('merged passage safeguards', () => {
  it.each(mergedPassages)('falls back to independent existing stories when one source is missing from $storyIds', passage => {
    for (const missingId of passage.storyIds) {
      const present = passage.storyIds.filter(id => id !== missingId).map(id => sourceById.get(id));
      const stages = composePrototypeBiography(present);
      expect(text(stages)).toEqual(present.flatMap(story => lifeMapDemoBiographyById.get(story.id)));
      expect(sourceIds(stages)).toEqual(present.map(story => story.id));
      expect(sourceIds(stages)).not.toContain(missingId);
      for (const story of present) expect(sourceLocation(stages, story.id).paragraphs).toEqual(lifeMapDemoBiographyById.get(story.id));
    }
  });

  it.each(mergedPassages)('preserves changed wording and uses independent intact passages when any source in $storyIds was edited', passage => {
    for (const changedId of passage.storyIds) {
      const sources = passage.storyIds.map(id => clone(sourceById.get(id)));
      const changed = sources.find(story => story.id === changedId);
      changed.paragraphs[0] = '这一段已由本人重新表达。';
      changed.paragraphs.push('另外补充的原话也要保留。');
      const stages = composePrototypeBiography(sources);
      expect(text(stages)).toEqual(sources.flatMap(story => story.id === changedId ? story.paragraphs : lifeMapDemoBiographyById.get(story.id)));
      expect(sourceIds(stages)).toEqual(passage.storyIds);
      expect(sourceLocation(stages, changedId).paragraphs).toEqual(changed.paragraphs);
    }
  });

  it.each(mergedPassages)('keeps all local additions after the intact merged passage $storyIds exactly once', passage => {
    const sources = passage.storyIds.map(id => ({ ...sourceById.get(id), paragraphs: [...sourceById.get(id).paragraphs, `后来补充：${id}`] }));
    const additions = passage.storyIds.map(id => `后来补充：${id}`);
    const stages = composePrototypeBiography(sources);
    expect(text(stages)).toEqual([...passage.paragraphs, ...additions]);
    for (const story of sources) expect(sourceLocation(stages, story.id).paragraphs).toEqual([...passage.paragraphs, ...additions]);
    for (const addition of additions) expect(text(stages).filter(paragraph => paragraph === addition)).toHaveLength(1);
    expect(composePrototypeBiography([...sources].reverse())).toEqual(stages);
  });

  it('does not use a mismatched topic as evidence for a merged passage or lose its actual words', () => {
    const passage = mergedPassages[0];
    const sources = passage.storyIds.map(id => clone(sourceById.get(id)));
    const mismatched = sources[0];
    mismatched.chapter_id = 'X';
    mismatched.content_id = 'MJ2-X-01';
    mismatched.paragraphs = ['这条记录实际上属于另一个话题。'];
    const stages = composePrototypeBiography(sources);
    expect(sourceLocation(stages, mismatched.id).stage.id).toBe('X');
    expect(sourceLocation(stages, mismatched.id).paragraphs).toEqual(mismatched.paragraphs);
    for (const source of sources.slice(1)) {
      expect(sourceLocation(stages, source.id).paragraphs).toEqual(lifeMapDemoBiographyById.get(source.id));
    }
    expect(new Set(sourceIds(stages)).size).toBe(sources.length);
  });

  it('keeps unrelated new and modified records without inferring an age for unknown transverse stories', () => {
    const added = ownStory('my-extra', 'L2', 'MJ2-L2-01', ['我自己记录的一段少年生活。']);
    const transverse = ownStory('my-transverse', 'X', 'MJ2-X-03', ['这段往事发生的时期，我还没有确定。']);
    const stages = composePrototypeBiography([...lifeMapDemoStories, transverse, added]);
    expect(sourceLocation(stages, added.id).stage.id).toBe('L2');
    expect(sourceLocation(stages, added.id).paragraphs).toEqual(added.paragraphs);
    const unplaced = sourceLocation(stages, transverse.id);
    expect(unplaced.stage.id).toBe('X');
    expect(unplaced.stage.title).toBe('另外记起的往事');
    expect(unplaced.paragraphs).toEqual(transverse.paragraphs);
    expect(unplaced.source.chapterId).toBe('X');
    expect(sourceIds(stages)).toHaveLength(26);
  });

  it('does not mutate frozen source stories, answers or the manuscript, and does not share their arrays', () => {
    const savedStories = clone(lifeMapDemoStories), savedAnswers = clone(lifeMapDemoSessions), savedManuscript = clone(manuscript);
    const input = Object.freeze(lifeMapDemoStories.map(story => Object.freeze({ ...story, paragraphs: Object.freeze([...story.paragraphs]) })));
    const stages = composePrototypeBiography(input);
    expect(composePrototypeBiography([...input].reverse())).toEqual(stages);
    stages[0].paragraphs.push('只改变阅读结果');
    stages[0].sources[0].chapterId = 'changed';
    expect(input.map(story => ({ ...story, paragraphs: [...story.paragraphs] }))).toEqual(savedStories);
    expect(lifeMapDemoStories).toEqual(savedStories);
    expect(lifeMapDemoSessions).toEqual(savedAnswers);
    expect(manuscript).toEqual(savedManuscript);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
  });
});

describe('polished biography page', () => {
  it('uses original source chapter IDs for image lookup after transverse stories move into life stages', () => {
    history.replaceState(null, '', './biography.html?prototype=1');
    mount(PrototypeBiographyPage);
    for (const contentId of ['MJ2-X-03', 'MJ2-X-05', 'MJ2-X-16']) {
      expect(getPrototypeStoryImage).toHaveBeenCalledWith('X', contentId);
    }
    expect(getPrototypeStoryImage).not.toHaveBeenCalledWith('L2', 'MJ2-X-03');
    expect(getPrototypeStoryImage).not.toHaveBeenCalledWith('L3', 'MJ2-X-05');
    expect(getPrototypeStoryImage).not.toHaveBeenCalledWith('L5', 'MJ2-X-16');
  });

  it('shows the revised manuscript immediately from an existing v4 snapshot without reset or a new saved body', () => {
    const state = getPrototypeState();
    const original = JSON.stringify(state);
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, original);
    history.replaceState(null, '', './biography.html?prototype=1');
    const page = mount(PrototypeBiographyPage);
    expect(page.get('.prototype-draft-label').text()).toBe('修订初稿');
    expect(page.findAll('.prototype-draft-stage h2').map(heading => heading.text())).toEqual(manuscript.chapters.map(chapter => chapter.title));
    expect(page.find('[data-testid="biography-stage-X"]').exists()).toBe(false);
    expect(page.findAll('.prototype-draft-paragraph').map(node => node.text())).toEqual(passages.flatMap(passage => passage.paragraphs));
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(original);
    expect(getPrototypeState().sessions).toEqual(state.sessions);
  });
});
