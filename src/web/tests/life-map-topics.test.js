import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import source from '../src/content/life-stage-topics.json';
import legacyTemplate from '../src/content/biography-template.json';
import { lifeMapChapters, prototypeChapters, findPrototypeChapter, findLifeMapTopic } from '../src/lib/life-map-topics.js';
import { prototypeHomeUrl, prototypeInterviewUrl, resolvePrototypeTopic } from '../src/lib/prototype-topic.js';
import PrototypeHomePage from '../src/pages/PrototypeHomePage.vue';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

describe('life map topic library', () => {
  it('retains the seven stages and cross-cutting themes in source order with all 100 cards and 400 questions', () => {
    expect(source.version).toBe('0.4');
    expect(lifeMapChapters.map(chapter => [chapter.id, chapter.title])).toEqual(source.stage_definitions.map(stage => [stage.id, stage.name]));
    expect(lifeMapChapters.map(chapter => chapter.core_contents.length)).toEqual([12, 12, 12, 12, 12, 12, 12, 16]);
    const contents = lifeMapChapters.flatMap(chapter => chapter.core_contents);
    expect(contents).toHaveLength(100);
    expect(new Set(contents.map(content => content.id)).size).toBe(100);
    expect(contents.flatMap(content => [content.prompt, ...content.followups])).toHaveLength(400);
    for (const chapter of lifeMapChapters) {
      const originals = source.cards.filter(card => card.stage === chapter.id);
      expect(chapter.core_contents.map(content => content.id)).toEqual(originals.map(card => card.id));
      for (const [index, content] of chapter.core_contents.entries()) {
        expect(content).toMatchObject(originals[index]);
        expect(content.description).toBe(originals[index].prompt);
        expect(content.followups).toHaveLength(3);
        expect(findLifeMapTopic(chapter.id, content.id)).toEqual(content);
        const resolved = resolvePrototypeTopic(new URLSearchParams({ chapter_id: chapter.id, content_id: content.id }));
        expect(resolved).toMatchObject({ kind: 'topic', chapter: { id: chapter.id }, content });
      }
    }
  });

  it('retains older story identities for existing links without mixing them into the map', () => {
    expect(prototypeChapters).toHaveLength(lifeMapChapters.length + legacyTemplate.chapters.length);
    expect(new Set(prototypeChapters.map(chapter => chapter.id)).size).toBe(prototypeChapters.length);
    for (const chapter of legacyTemplate.chapters) {
      expect(findPrototypeChapter(chapter.id)).toEqual(chapter);
      expect(lifeMapChapters.some(item => item.id === chapter.id)).toBe(false);
      for (const content of chapter.core_contents) {
        expect(resolvePrototypeTopic(new URLSearchParams({ chapter_id: chapter.id, content_id: content.id }))).toMatchObject({ kind: 'topic', chapter, content });
      }
    }
  });

  it.each([
    ['L1', 'MJ2-L2-01'], ['L2', 'MJ2-L1-01'], ['L1', 'hometown'],
    ['origins', 'MJ2-L1-01'], ['X', 'MJ2-L7-01'], ['missing', 'MJ2-L1-01'],
  ])('rejects a mismatched chapter/card pair %s / %s', (chapterId, contentId) => {
    expect(findLifeMapTopic(chapterId, contentId)).toBeFalsy();
    expect(prototypeInterviewUrl(chapterId, contentId)).toBe('');
    expect(resolvePrototypeTopic(new URLSearchParams({ chapter_id: chapterId, content_id: contentId })).kind).toBe('invalid');
  });
});

describe('life map questions', () => {
  it('shows each stage’s titles and opening questions without optional follow-up controls', async () => {
    history.replaceState(null, '', prototypeHomeUrl());
    const home = mount(PrototypeHomePage);
    expect(home.findAll('[role="tab"]')).toHaveLength(8);
    for (const chapter of lifeMapChapters) {
      await home.get(`[data-testid="chapter-${chapter.id}"]`).trigger('click');
      const panel = home.get('[role="tabpanel"]:not([hidden])');
      const topicButtons = panel.findAll('[data-testid^="topic-"]');
      expect(topicButtons).toHaveLength(chapter.core_contents.length);
      expect(panel.findAll('details')).toHaveLength(0);
      expect(panel.findAll('[data-testid^="followups-"]')).toHaveLength(0);
      expect(panel.text()).not.toContain('可选追问');
      for (const [index, content] of chapter.core_contents.entries()) {
        expect(topicButtons[index].text()).toContain(content.title);
        expect(topicButtons[index].text()).toContain(content.prompt);
      }
      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it('keeps arrow, Home and End navigation aligned with the new eight categories', async () => {
    history.replaceState(null, '', prototypeHomeUrl());
    const home = mount(PrototypeHomePage, { attachTo: document.body });
    await home.get('[data-testid="chapter-L1"]').trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(home.get('[data-testid="chapter-L2"]').attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(home.get('[data-testid="chapter-L2"]').element);
    await home.get('[data-testid="chapter-L2"]').trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(home.get('[data-testid="chapter-X"]').attributes('aria-selected')).toBe('true');
    expect(home.findAll('[data-testid^="topic-"]')).toHaveLength(16);
    await home.get('[data-testid="chapter-X"]').trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(home.get('[data-testid="chapter-L1"]').attributes('aria-selected')).toBe('true');
    expect(home.findAll('[data-testid^="topic-"]')).toHaveLength(12);
  });
});
