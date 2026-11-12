import { describe, expect, it } from 'vitest';
import seeds from '../src/content/prototype-stories.json';
import bookends from '../src/content/prototype-biography-bookends.json';
import template from '../src/content/biography-template.json';
import { composePrototypeBiography } from '../src/lib/prototype-biography.js';

const story = (id, chapterId, contentId, paragraphs = [id], createdAt = '2026-01-01T00:00:00Z') => ({
  id, chapter_id: chapterId, content_id: contentId, title: `标题 ${id}`, paragraphs, createdAt,
  updatedAt: '2026-11-04T00:00:00Z',
});
const allParagraphs = stages => stages.flatMap(stage => stage.paragraphs);
const seedReadingParagraphs = seed => bookends[seed.id] || seed.paragraphs;

describe('prototype biography reading projection', () => {
  it('composes the seventeen supplied seeds across all life stages without introducing other stories', () => {
    const stages = composePrototypeBiography(seeds);
    expect(seeds).toHaveLength(17);
    expect(seeds.every(seed => seed.paragraphs.length === 4)).toBe(true);
    expect(new Set(seeds.map(seed => seed.chapter_id)).size).toBe(8);
    expect(new Set(seeds.map(seed => `${seed.chapter_id}/${seed.content_id}`)).size).toBe(seeds.length);
    expect(stages.map(({ id, title }) => [id, title])).toEqual(template.chapters.map(chapter => [chapter.id, chapter.title]));
    const expected = template.chapters.flatMap(chapter => chapter.core_contents.flatMap(content =>
      seeds.filter(seed => seed.chapter_id === chapter.id && seed.content_id === content.id).flatMap(seedReadingParagraphs)));
    expect(allParagraphs(stages)).toEqual(expected);
    for (const stage of stages) {
      const stageStories = template.chapters.find(chapter => chapter.id === stage.id).core_contents.flatMap(content =>
        seeds.filter(seed => seed.chapter_id === stage.id && seed.content_id === content.id));
      let paragraphStart = 0;
      expect(stage.sources).toEqual(stageStories.map(seed => {
        const paragraphCount = seedReadingParagraphs(seed).length;
        const source = { storyId: seed.id, chapterId: seed.chapter_id, contentId: seed.content_id, paragraphStart, paragraphCount };
        paragraphStart += paragraphCount;
        return source;
      }));
    }
    expect(stages[0].transition).toBe('');
    expect(stages.slice(1, -1).every(stage => stage.transition.length > 0)).toBe(true);
    expect(stages.at(-1).transition).toBe('');
    expect(stages.every(stage => !Object.hasOwn(stage, 'stories'))).toBe(true);
  });

  it('includes every answered fragment in the first and last chapters and ends with words to keep', () => {
    const stages = composePrototypeBiography(seeds);
    for (const chapterId of ['origins', 'life_today']) {
      const chapter = template.chapters.find(chapter => chapter.id === chapterId);
      const stage = stages.find(stage => stage.id === chapterId);
      expect(stage.sources.map(source => source.contentId)).toEqual(chapter.core_contents.map(content => content.id));
      expect(stage.sources).toHaveLength(5);
    }
    const ending = seeds.find(seed => seed.content_id === 'words_to_keep');
    expect(stages.at(-1).sources.at(-1).storyId).toBe(ending.id);
    expect(allParagraphs(stages).slice(-ending.paragraphs.length)).toEqual(ending.paragraphs);
  });

  it('edits existing bookends without changing source stories and retains their supplements exactly once', () => {
    for (const [id, paragraphs] of Object.entries(bookends)) {
      const seed = seeds.find(item => item.id === id);
      const supplement = `单篇故事保留的补充：${id}`;
      const source = Object.freeze({ ...seed, paragraphs: Object.freeze([...seed.paragraphs, supplement]) });
      const stages = composePrototypeBiography(Object.freeze([source]));
      expect(stages).toHaveLength(1);
      expect(stages[0].id).toBe(seed.chapter_id);
      expect(stages[0].paragraphs).toEqual([...paragraphs, supplement]);
      expect(stages[0].paragraphs.filter(paragraph => paragraph === supplement)).toHaveLength(1);
      expect(stages[0].sources).toEqual([{
        storyId: id, chapterId: seed.chapter_id, contentId: seed.content_id, paragraphStart: 0, paragraphCount: paragraphs.length + 1,
      }]);
      expect(stages[0].paragraphs).not.toEqual(source.paragraphs);
      stages[0].paragraphs.push('只改变阅读投影');
      expect(source.paragraphs).toEqual([...seed.paragraphs, supplement]);
      expect(bookends[id]).toEqual(paragraphs);
      expect(bookends[id]).not.toContain('只改变阅读投影');
    }
  });

  it.each(['changed', 'truncated', 'different-id', 'different-topic'])('keeps the actual story wording for a %s bookend', variation => {
    const seed = seeds.find(item => item.id === 'demo-hometown-lane');
    const source = { ...seed, paragraphs: [...seed.paragraphs] };
    if (variation === 'changed') source.paragraphs[2] = '这一段已经由我重新写过。';
    if (variation === 'truncated') source.paragraphs = source.paragraphs.slice(0, 2);
    if (variation === 'different-id') source.id = 'another-hometown-story';
    if (variation === 'different-topic') source.content_id = 'early_household';
    expect(allParagraphs(composePrototypeBiography([source]))).toEqual(source.paragraphs);
  });

  it('does not supply opening or ending text when those stories are absent', () => {
    const seed = seeds.find(item => item.id === 'demo-childhood-paper-boats');
    const stages = composePrototypeBiography([seed]);
    expect(stages.map(stage => stage.id)).toEqual(['childhood']);
    expect(allParagraphs(stages)).toEqual(seed.paragraphs);
  });

  it('orders chapters and their fragments by the map template regardless of input or update order', () => {
    const input = [
      story('today', 'life_today', 'present_day'),
      story('chores', 'childhood', 'childhood_chores'),
      story('family', 'origins', 'early_household'),
      story('childhood-day', 'childhood', 'childhood_day'),
      story('hometown', 'origins', 'hometown'),
    ];
    const stages = composePrototypeBiography(input);
    expect(stages.map(stage => stage.id)).toEqual(['origins', 'childhood', 'life_today']);
    expect(allParagraphs(stages)).toEqual(['hometown', 'family', 'childhood-day', 'chores', 'today']);
    expect(composePrototypeBiography([...input].reverse())).toEqual(stages);
  });

  it('keeps multiple stories of one fragment stable by creation time and then id', () => {
    const input = [
      story('b', 'origins', 'hometown', ['b'], '2026-01-01T00:00:00Z'),
      story('later', 'origins', 'hometown', ['later'], '2026-02-01T00:00:00Z'),
      story('z-no-date', 'origins', 'hometown', ['z-no-date'], undefined),
      story('a', 'origins', 'hometown', ['a'], '2026-01-01T00:00:00Z'),
      story('a-bad-date', 'origins', 'hometown', ['a-bad-date'], 'invalid'),
    ];
    delete input[2].createdAt;
    expect(allParagraphs(composePrototypeBiography(input))).toEqual(['a-bad-date', 'z-no-date', 'a', 'b', 'later']);
  });

  it('keeps added paragraphs with their original story without moving it after newer stories', () => {
    const original = story('old', 'origins', 'hometown', ['原文一', '原文二']);
    const other = story('next', 'origins', 'early_household', ['另一片段']);
    const before = composePrototypeBiography([other, original]);
    const supplemented = { ...original, updatedAt: '2099-01-01T00:00:00Z', paragraphs: [...original.paragraphs, '补充一'] };
    const after = composePrototypeBiography([other, supplemented]);
    expect(allParagraphs(before)).toEqual(['原文一', '原文二', '另一片段']);
    expect(allParagraphs(after)).toEqual(['原文一', '原文二', '补充一', '另一片段']);
    expect(after[0].sources).toEqual([
      { storyId: 'old', chapterId: 'origins', contentId: 'hometown', paragraphStart: 0, paragraphCount: 3 },
      { storyId: 'next', chapterId: 'origins', contentId: 'early_household', paragraphStart: 3, paragraphCount: 1 },
    ]);
    expect(allParagraphs(composePrototypeBiography([other, supplemented]))).toEqual(allParagraphs(after));
  });

  it('does not change frozen inputs or reuse their paragraph arrays', () => {
    const original = Object.freeze(story('sample', 'origins', 'hometown', Object.freeze(['  保留原有文字与空白。  '])));
    const input = Object.freeze([original]);
    const stage = composePrototypeBiography(input)[0];
    expect(stage.paragraphs).toEqual(original.paragraphs);
    stage.paragraphs.push('仅修改投影');
    expect(original.paragraphs).toEqual(['  保留原有文字与空白。  ']);
    expect(input[0]).toBe(original);
  });

  it.each([undefined, null, {}, [], [null], [story('empty', 'origins', 'hometown', [])]])('returns no draft for an empty or unusable source %j', input => {
    expect(composePrototypeBiography(input)).toEqual([]);
  });

  it('filters invalid topic pairs and empty text without fabricating a stage', () => {
    const input = [
      story('wrong-pair', 'childhood', 'hometown', ['不应显示']),
      story('unknown-chapter', 'unknown', 'hometown', ['不应显示']),
      story('unknown-content', 'origins', 'unknown', ['不应显示']),
      story('blank', 'origins', 'hometown', ['', ' ', null, 42]),
      story('valid', 'childhood', 'childhood_memory', ['', '保留这一段', '   ']),
    ];
    const stages = composePrototypeBiography(input);
    expect(stages).toEqual([{
      id: 'childhood', title: '童年时光', transition: '', paragraphs: ['保留这一段'],
      sources: [{ storyId: 'valid', chapterId: 'childhood', contentId: 'childhood_memory', paragraphStart: 0, paragraphCount: 1 }],
    }]);
  });

  it('rejects duplicate story ids but preserves intentionally repeated source paragraphs', () => {
    const first = story('same', 'origins', 'hometown', ['相同的句子', '相同的句子']);
    const other = story('other', 'origins', 'early_household', ['相同的句子']);
    expect(allParagraphs(composePrototypeBiography([first, first, other]))).toEqual(['相同的句子', '相同的句子', '相同的句子']);
  });
});
