import manuscript from '../src/content/life-map-biography.json';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { legacyPrototypeSnapshot } from './prototype-fixtures.js';
import legacySeeds from '../src/content/prototype-stories.json';
import legacyBookends from '../src/content/prototype-biography-bookends.json';
import { lifeMapChapters, findLifeMapTopic } from '../src/lib/life-map-topics.js';
import {
  lifeMapDemoEntries, lifeMapDemoStories, lifeMapDemoSessions,
  lifeMapDemoBiographyById, LIFE_MAP_BIOGRAPHY_TITLE,
} from '../src/lib/life-map-demo.js';
import {
  PROTOTYPE_STORAGE_KEY, getPrototypeState, getPrototypeSession,
  getPrototypeSessionTurns, startPrototypeSession, advancePrototypeSession, answerPrototypeTopic,
  organizePrototypeSession, completePrototypeOrganization, resetPrototypeState,
  selectPrototypeChapter,
} from '../src/lib/prototype-state.js';
import { composePrototypeBiography } from '../src/lib/prototype-biography.js';
import { prototypeHomeUrl, prototypeHistoryUrl, prototypeStoryUrl } from '../src/lib/prototype-topic.js';
import PrototypeHomePage from '../src/pages/PrototypeHomePage.vue';
import PrototypeHistoryPage from '../src/pages/PrototypeHistoryPage.vue';
import PrototypeStoryPage from '../src/pages/PrototypeStoryPage.vue';
import PrototypeBiographyPage from '../src/pages/PrototypeBiographyPage.vue';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

const paragraphs = stages => stages.flatMap(stage => stage.paragraphs);
const manuscriptPassages = manuscript.chapters.flatMap(chapter => chapter.passages);
const expectedDraft = manuscriptPassages.flatMap(passage => passage.paragraphs);
const passageFor = id => manuscriptPassages.find(passage => passage.storyIds.includes(id));
const independentPassage = id => {
  const passage = passageFor(id);
  return passage.storyIds.length === 1 ? passage.paragraphs : lifeMapDemoBiographyById.get(id);
};
const open = (component, url) => {
  history.replaceState(null, '', url);
  return mount(component);
};
const put = value => {
  const raw = JSON.stringify(value);
  sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, raw);
  return raw;
};
const previousRevision = () => ({ ...legacyPrototypeSnapshot(), seedRevision: 3 });
const clone = value => structuredClone(value);

function unfinishedSample(seed, status) {
  const topic = findLifeMapTopic(seed.chapter_id, seed.content_id);
  return {
    id: 'my-existing-take', chapterId: seed.chapter_id, contentId: seed.content_id,
    storyId: null, freeTalk: false, status, turnIndex: 2,
    turns: [{ role: 'assistant', text: topic.prompt }, { role: 'user', text: '这是我之前保存的回答。' }],
    draft: status === 'organizing' ? '' : '这段还没有讲完。',
    createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:04:00.000Z',
    organizingAt: status === 'organizing' ? '2026-11-01T08:04:00.000Z' : null,
  };
}

describe('life map sample answers and first biography', () => {
  it('provides three distinct completed stories per category, each with four exact question/answer pairs', () => {
    expect(lifeMapDemoEntries).toHaveLength(24);
    expect(lifeMapDemoStories).toHaveLength(24);
    expect(lifeMapDemoSessions).toHaveLength(24);
    expect(lifeMapDemoBiographyById.size).toBe(24);
    expect(new Set(lifeMapDemoStories.map(story => story.id)).size).toBe(24);
    expect(new Set(lifeMapDemoSessions.map(session => session.id)).size).toBe(24);
    expect(new Set(lifeMapDemoStories.map(story => `${story.chapter_id}/${story.content_id}`)).size).toBe(24);
    for (const chapter of lifeMapChapters) {
      expect(lifeMapDemoStories.filter(story => story.chapter_id === chapter.id)).toHaveLength(3);
    }
    for (const entry of lifeMapDemoEntries) {
      const topic = findLifeMapTopic(entry.chapter_id, entry.content_id);
      expect(topic).toBeDefined();
      expect(entry.answers).toHaveLength(4);
      expect(entry.paragraphs).toHaveLength(3);
      expect(entry.biographyParagraphs).toHaveLength(2);
      expect([...entry.answers, ...entry.paragraphs, ...entry.biographyParagraphs].every(text => typeof text === 'string' && text.trim())).toBe(true);
      const story = lifeMapDemoStories.find(item => item.id === entry.id);
      expect(story).toMatchObject({ chapter_id: entry.chapter_id, content_id: entry.content_id, title: entry.title, source: 'fictional-demo', paragraphs: entry.paragraphs });
      expect(lifeMapDemoBiographyById.get(entry.id)).toEqual(entry.biographyParagraphs);
      const session = lifeMapDemoSessions.find(item => item.storyId === entry.id);
      expect(session).toMatchObject({ chapterId: entry.chapter_id, contentId: entry.content_id, source: 'fictional-demo', status: 'complete', turnIndex: 8, freeTalk: false, draft: '' });
      expect(session.turns.map(turn => turn.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
      expect(session.turns.filter(turn => turn.role === 'assistant').map(turn => turn.text)).toEqual([topic.prompt, ...topic.followups]);
      expect(session.turns.filter(turn => turn.role === 'user').map(turn => turn.text)).toEqual(entry.answers);
      for (const value of [story.createdAt, story.updatedAt, session.createdAt, session.updatedAt, session.organizingAt]) expect(Number.isFinite(Date.parse(value))).toBe(true);
    }
  });

  it('initializes all 41 stories and 24 completed recordings without writing storage or sharing mutable fixtures', () => {
    const state = getPrototypeState();
    expect(state).toMatchObject({ version: 1, seedRevision: 4, selectedChapterId: 'L1' });
    expect(state.stories.map(story => story.id)).toEqual([...legacySeeds, ...lifeMapDemoStories].map(story => story.id));
    expect(state.sessions).toEqual(lifeMapDemoSessions);
    expect(state.stories).toHaveLength(41);
    expect(state.sessions).toHaveLength(24);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
    state.stories.at(-1).paragraphs.push('仅修改这份副本');
    state.sessions[0].turns[1].text = '仅修改这份会话副本';
    expect(getPrototypeState().stories.at(-1).paragraphs).not.toContain('仅修改这份副本');
    expect(getPrototypeState().sessions[0].turns[1].text).toBe(lifeMapDemoSessions[0].turns[1].text);
  });

  it('projects the polished biography into seven stages without repeating source stories or legacy samples', () => {
    const state = getPrototypeState();
    const before = clone(state);
    const stages = composePrototypeBiography(state.stories);
    expect(stages.map(stage => [stage.id, stage.title])).toEqual(manuscript.chapters.map(chapter => [chapter.id, chapter.title]));
    expect(stages.flatMap(stage => stage.sources.map(source => source.storyId))).toEqual(manuscriptPassages.flatMap(passage => passage.storyIds));
    expect(paragraphs(stages)).toEqual(expectedDraft);
    expect(stages).toHaveLength(7);
    expect(paragraphs(stages).length).toBeLessThan(48);
    expect(composePrototypeBiography([...state.stories].reverse())).toEqual(stages);
    expect(state).toEqual(before);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
  });
});

describe('revision four sample migration', () => {
  it('adds new story/recording pairs once and only persists them on a later normal save', () => {
    const previous = previousRevision();
    previous.selectedChapterId = 'life_today';
    const raw = put(previous);
    sessionStorage.setItem('official-account', 'untouched');
    localStorage.setItem('official-preference', 'untouched');
    const migrated = getPrototypeState();
    expect(migrated.seedRevision).toBe(4);
    expect(migrated.stories).toHaveLength(41);
    expect(migrated.stories.slice(0, 17)).toEqual(previous.stories);
    expect(migrated.stories.slice(17)).toEqual(lifeMapDemoStories);
    expect(migrated.sessions).toEqual(lifeMapDemoSessions);
    expect(getPrototypeState()).toEqual(migrated);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw);
    selectPrototypeChapter('L2');
    expect(JSON.parse(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY))).toEqual({ ...migrated, selectedChapterId: 'L2' });
    expect(getPrototypeState().stories).toHaveLength(41);
    expect(getPrototypeState().sessions).toHaveLength(24);
    expect(sessionStorage.getItem('official-account')).toBe('untouched');
    expect(localStorage.getItem('official-preference')).toBe('untouched');
  });

  it.each(['running', 'paused', 'organizing'])('leaves an existing %s answer and its draft untouched instead of seeding that topic', status => {
    const seed = lifeMapDemoStories[0];
    const previous = previousRevision();
    const existing = unfinishedSample(seed, status);
    previous.sessions = [existing];
    const raw = put(previous);
    const migrated = getPrototypeState();
    expect(migrated.stories).toHaveLength(40);
    expect(migrated.stories.some(story => story.chapter_id === seed.chapter_id && story.content_id === seed.content_id)).toBe(false);
    expect(migrated.sessions).toHaveLength(24);
    expect(migrated.sessions.find(session => session.id === existing.id)).toEqual(existing);
    expect(migrated.sessions.some(session => session.storyId === seed.id)).toBe(false);
    expect(getPrototypeState()).toEqual(migrated);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw);
  });

  it('preserves an existing story, its identity and supplement instead of inserting a sample story or invented history', () => {
    const seed = lifeMapDemoStories[0];
    const previous = previousRevision();
    const existing = {
      ...clone(seed), id: 'my-own-story', source: 'local', title: '我写过的这段生活',
      paragraphs: ['这是我已经写好的正文。', '这段补充也应留在原处。'],
      createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-11-02T08:00:00.000Z',
    };
    previous.stories.push(existing);
    const raw = put(previous);
    const migrated = getPrototypeState();
    expect(migrated.stories).toHaveLength(41);
    expect(migrated.stories.filter(story => story.chapter_id === seed.chapter_id && story.content_id === seed.content_id)).toEqual([existing]);
    expect(migrated.sessions).toHaveLength(23);
    expect(migrated.sessions.some(session => session.chapterId === seed.chapter_id && session.contentId === seed.content_id)).toBe(false);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw);
  });

  it('does not fill missing samples again in a current revision, including an explicitly empty snapshot', () => {
    const current = getPrototypeState();
    current.stories = current.stories.filter(story => story.id !== lifeMapDemoStories[0].id);
    current.sessions = current.sessions.filter(session => session.storyId !== lifeMapDemoStories[0].id);
    let raw = put(current);
    expect(getPrototypeState()).toEqual(current);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw);
    current.stories = []; current.sessions = [];
    raw = put(current);
    expect(getPrototypeState()).toEqual(current);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(raw);
  });

  it('reset restores all 41 stories and 24 samples and rejects a stale organizing callback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T08:00:00.000Z'));
    const session = startPrototypeSession({ chapterId: 'childhood', contentId: 'childhood_occasions' });
    advancePrototypeSession(session.id); organizePrototypeSession(session.id);
    const reset = resetPrototypeState();
    expect(reset.stories).toHaveLength(41);
    expect(reset.sessions).toEqual(lifeMapDemoSessions);
    vi.advanceTimersByTime(5000);
    expect(completePrototypeOrganization(session.id)).toBeNull();
    expect(getPrototypeState()).toEqual(reset);
  });
});

describe('first biography wording protection', () => {
  it.each(lifeMapDemoStories.map(story => story.id))('uses the composed passage only for intact %s and preserves its supplement once', id => {
    const seed = lifeMapDemoStories.find(story => story.id === id);
    const supplement = '这是后来补充的文字，按原样保留。';
    const input = Object.freeze({ ...seed, paragraphs: Object.freeze([...seed.paragraphs, supplement]) });
    const stages = composePrototypeBiography(Object.freeze([input]));
    expect(paragraphs(stages)).toEqual([...independentPassage(id), supplement]);
    expect(stages[0].sources).toEqual([{ storyId: id, chapterId: seed.chapter_id, contentId: seed.content_id, paragraphStart: 0, paragraphCount: independentPassage(id).length + 1 }]);
    stages[0].paragraphs.push('只改投影');
    expect(input.paragraphs).toEqual([...seed.paragraphs, supplement]);
  });

  it.each(['changed', 'truncated', 'different-id', 'different-topic'])('preserves actual new-story wording for a %s sample', variation => {
    const source = clone(lifeMapDemoStories[0]);
    if (variation === 'changed') source.paragraphs[1] = '我修改过这里的回忆。';
    if (variation === 'truncated') source.paragraphs = source.paragraphs.slice(0, 2);
    if (variation === 'different-id') source.id = 'my-new-story';
    if (variation === 'different-topic') source.content_id = lifeMapChapters.find(chapter => chapter.id === source.chapter_id).core_contents.find(content => content.id !== source.content_id).id;
    expect(paragraphs(composePrototypeBiography([source]))).toEqual(source.paragraphs);
  });

  it.each(['changed', 'supplemented', 'different-id', 'renamed'])('retains a %s legacy story alongside the new stages', variation => {
    const source = clone(legacySeeds.find(story => !legacyBookends[story.id]));
    if (variation === 'changed') source.paragraphs[0] = '这是我修改的旧稿。';
    if (variation === 'supplemented') source.paragraphs.push('这是我后来补充的经历。');
    if (variation === 'different-id') source.id = 'my-own-legacy-story';
    if (variation === 'renamed') source.title = '我给故事起了新名字';
    const stages = composePrototypeBiography([...lifeMapDemoStories, source]);
    const stage = stages.find(item => item.id === source.chapter_id);
    expect(stage.paragraphs).toEqual(source.paragraphs);
    expect(stage.sources.map(item => item.storyId)).toEqual([source.id]);
  });

  it('does not hide legacy stories for an empty or invalid new story', () => {
    const expected = composePrototypeBiography(legacySeeds);
    const seed = lifeMapDemoStories[0];
    expect(composePrototypeBiography([...legacySeeds, { ...seed, paragraphs: ['', '  '] }])).toEqual(expected);
    expect(composePrototypeBiography([...legacySeeds, { ...seed, chapter_id: 'missing' }])).toEqual(expected);
  });
});

describe('sample map, recordings and biography pages', () => {
  it('marks exactly three sample topics in every category and opens their story links', async () => {
    const home = open(PrototypeHomePage, prototypeHomeUrl());
    expect(home.find('[data-testid="resume-last-session"]').exists()).toBe(false);
    for (const chapter of lifeMapChapters) {
      await home.get(`[data-testid="chapter-${chapter.id}"]`).trigger('click');
      expect(home.findAll('.chapter-topic-status')).toHaveLength(3);
      const stories = lifeMapDemoStories.filter(story => story.chapter_id === chapter.id);
      for (const story of stories) {
        const topic = home.get(`[data-testid="topic-${story.content_id}"]`);
        expect(topic.get('.chapter-topic-status').text()).toBe('讲过');
        await topic.trigger('click');
        expect(navigate).toHaveBeenLastCalledWith(prototypeStoryUrl(story.chapter_id, story.content_id));
      }
    }
  });

  it('renders all 24 four-answer records and their matching stories without creating activity', () => {
    for (const session of lifeMapDemoSessions) {
      const page = open(PrototypeHistoryPage, prototypeHistoryUrl(session.id));
      expect(page.findAll('.prototype-history-turn p').map(node => node.text())).toEqual(session.turns.map(turn => turn.text));
      expect(page.get('.prototype-history-header > span').text()).toBe('话题讲述');
      expect(page.get('[data-testid="history-continue"]').attributes('href')).toContain('story_id=' + session.storyId);
      expect(getPrototypeSessionTurns(getPrototypeSession(session.id))).toEqual(session.turns);
      page.unmount();
      const story = lifeMapDemoStories.find(item => item.id === session.storyId);
      const reading = open(PrototypeStoryPage, prototypeStoryUrl(session.chapterId, session.contentId, { sessionId: session.id, storyId: session.storyId }));
      expect(reading.findAll('.prototype-story-article > p').map(node => node.text())).toEqual(story.paragraphs);
      expect(reading.find('.prototype-story-label').exists()).toBe(false);
      expect(reading.get('[data-testid="story-answers"]').text()).toBe('查看这篇的问答');
      expect(reading.get('[data-testid="story-answers"]').attributes('href')).toBe(prototypeHistoryUrl(session.id, {
        storyId: session.storyId, back: 'story', from: 'map', returnSessionId: session.id,
      }));
      reading.unmount();
    }
    expect(getPrototypeState().sessions).toHaveLength(24);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
  });

  it('keeps the original sample answers and a saved local supplement in both story and biography', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T08:00:00.000Z'));
    const seed = lifeMapDemoStories[0];
    const originalRecording = lifeMapDemoSessions.find(session => session.storyId === seed.id);
    const session = startPrototypeSession({ chapterId: seed.chapter_id, contentId: seed.content_id, storyId: seed.id });
    const addition = '我后来还想补充一段自己的回忆。';
    answerPrototypeTopic(session.id, addition);
    organizePrototypeSession(session.id);
    vi.advanceTimersByTime(2000);
    completePrototypeOrganization(session.id);
    completePrototypeOrganization(session.id);
    const story = getPrototypeState().stories.find(item => item.id === seed.id);
    expect(story).toMatchObject({ source: 'fictional-demo', hasLocalAdditions: true, paragraphs: [...seed.paragraphs, addition] });
    expect(getPrototypeSession(originalRecording.id)).toEqual(originalRecording);
    const reading = open(PrototypeStoryPage, prototypeStoryUrl(seed.chapter_id, seed.content_id, { storyId: seed.id, sessionId: session.id }));
    expect(reading.findAll('.prototype-story-article > p').map(node => node.text())).toEqual([...seed.paragraphs, addition]);
    expect(reading.get('[data-testid="story-answers"]').attributes('href')).toBe(prototypeHistoryUrl(originalRecording.id, {
      storyId: seed.id, back: 'story', from: 'map', returnSessionId: session.id,
    }));
    reading.unmount();
    const biography = open(PrototypeBiographyPage, './biography.html?prototype=1');
    expect(biography.get('.prototype-draft-label').text()).toBe('修订初稿');
    const stage = composePrototypeBiography(getPrototypeState().stories).find(item => item.id === seed.chapter_id);
    const source = stage.sources.find(item => item.storyId === seed.id);
    expect(stage.paragraphs.slice(source.paragraphStart, source.paragraphStart + source.paragraphCount)).toEqual([
      ...passageFor(seed.id).paragraphs, addition,
    ]);
    expect(stage.paragraphs.filter(paragraph => paragraph === addition)).toHaveLength(1);
  });

  it('opens the polished biography with its book title and seven stages without persisting a second body', async () => {
    const page = open(PrototypeBiographyPage, './biography.html?prototype=1');
    expect(page.get('h1').text()).toBe('我的传记');
    expect(page.text()).toContain(LIFE_MAP_BIOGRAPHY_TITLE);
    expect(page.get('.prototype-draft-label').text()).toBe('修订初稿');
    expect(page.findAll('.prototype-draft-stage h2').map(heading => heading.text())).toEqual(manuscript.chapters.map(chapter => chapter.title));
    expect(page.findAll('.prototype-draft-paragraph').map(node => node.text())).toEqual(expectedDraft);
    expect(page.findAll('.prototype-draft-paragraph')).toHaveLength(expectedDraft.length);
    window.dispatchEvent(new Event('pageshow'));
    await nextTick();
    expect(page.findAll('.prototype-draft-paragraph').map(node => node.text())).toEqual(expectedDraft);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
  });
});

describe('story question and answer return navigation', () => {
  it.each(['map', 'chapter', 'biography', 'history'])('returns from a story’s questions to that story and preserves its %s source after refresh', from => {
    const seed = lifeMapDemoStories[0];
    const recording = lifeMapDemoSessions.find(session => session.storyId === seed.id);
    const sourceSessionId = from === 'history' ? recording.id : undefined;
    const storyUrl = prototypeStoryUrl(seed.chapter_id, seed.content_id, { storyId: seed.id, from, sessionId: sourceSessionId });
    const story = open(PrototypeStoryPage, storyUrl);
    const questionsUrl = story.get('[data-testid="story-answers"]').attributes('href');
    const params = new URL(questionsUrl, location.href).searchParams;
    expect(params.get('session_id')).toBe(recording.id);
    expect(params.get('story_id')).toBe(seed.id);
    expect(params.get('from')).toBe(from);
    expect(params.get('back')).toBe('story');
    expect(params.get('return_session_id')).toBe(sourceSessionId || null);
    story.unmount();

    let questions = open(PrototypeHistoryPage, questionsUrl);
    expect(questions.get('.prototype-history-header a').text()).toContain('返回故事');
    expect(questions.get('.prototype-history-header a').attributes('href')).toBe(storyUrl);
    expect(questions.get('[data-testid="history-continue"]').attributes('href')).toBe(storyUrl);
    questions.unmount();
    questions = open(PrototypeHistoryPage, questionsUrl);
    const returnUrl = questions.get('.prototype-history-header a').attributes('href');
    expect(returnUrl).toBe(storyUrl);
    expect(questions.get('[data-testid="history-continue"]').attributes('href')).toBe(returnUrl);
    questions.unmount();

    const returned = open(PrototypeStoryPage, returnUrl);
    expect(returned.get('h1').text()).toBe(seed.title);
    expect(returned.findAll('.prototype-story-article > p').map(node => node.text())).toEqual(seed.paragraphs);
    expect(returned.get('.prototype-story-back').attributes('href')).toBe({
      map: prototypeHomeUrl(seed.chapter_id),
      chapter: './chapter.html?prototype=1&chapter_id=' + seed.chapter_id,
      biography: './biography.html?prototype=1',
      history: prototypeHistoryUrl(recording.id),
    }[from]);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
  });

  it('keeps a completed supplement as the story’s return session while reading its original questions', () => {
    vi.useFakeTimers();
    const seed = lifeMapDemoStories[0];
    const recording = lifeMapDemoSessions.find(session => session.storyId === seed.id);
    const supplement = startPrototypeSession({ chapterId: seed.chapter_id, contentId: seed.content_id, storyId: seed.id });
    answerPrototypeTopic(supplement.id, '这是一段后来补充的回忆。');
    organizePrototypeSession(supplement.id);
    vi.advanceTimersByTime(2000);
    completePrototypeOrganization(supplement.id);
    const before = sessionStorage.getItem(PROTOTYPE_STORAGE_KEY);
    const storyUrl = prototypeStoryUrl(seed.chapter_id, seed.content_id, { storyId: seed.id, sessionId: supplement.id, from: 'history' });
    const story = open(PrototypeStoryPage, storyUrl);
    const questionsUrl = story.get('[data-testid="story-answers"]').attributes('href');
    const params = new URL(questionsUrl, location.href).searchParams;
    expect(params.get('session_id')).toBe(recording.id);
    expect(params.get('return_session_id')).toBe(supplement.id);
    expect(supplement.id).not.toBe(recording.id);
    story.unmount();
    const questions = open(PrototypeHistoryPage, questionsUrl);
    expect(questions.findAll('.prototype-history-turn p').map(node => node.text())).toEqual(recording.turns.map(turn => turn.text));
    const returnUrl = questions.get('.prototype-history-header a').attributes('href');
    expect(returnUrl).toBe(storyUrl);
    expect(questions.get('[data-testid="history-continue"]').attributes('href')).toBe(storyUrl);
    questions.unmount();
    const returned = open(PrototypeStoryPage, returnUrl);
    expect(returned.get('.prototype-story-back').attributes('href')).toBe(prototypeHistoryUrl(supplement.id));
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(before);
  });

  it.each(['missing', 'unfinished', 'other-story'])('ignores a %s return session without routing to another story', kind => {
    const seed = lifeMapDemoStories[0];
    const recording = lifeMapDemoSessions.find(session => session.storyId === seed.id);
    let returnSessionId = 'missing-recording';
    if (kind === 'unfinished') returnSessionId = startPrototypeSession({ chapterId: seed.chapter_id, contentId: seed.content_id, storyId: seed.id }).id;
    if (kind === 'other-story') returnSessionId = lifeMapDemoSessions.find(session => session.storyId !== seed.id).id;
    const before = sessionStorage.getItem(PROTOTYPE_STORAGE_KEY);
    const questions = open(PrototypeHistoryPage, prototypeHistoryUrl(recording.id, {
      storyId: seed.id, from: 'chapter', back: 'story', returnSessionId,
    }));
    const expected = prototypeStoryUrl(seed.chapter_id, seed.content_id, { storyId: seed.id, from: 'chapter' });
    const returnUrl = questions.get('.prototype-history-header a').attributes('href');
    expect(returnUrl).toBe(expected);
    expect(new URL(returnUrl, location.href).searchParams.has('session_id')).toBe(false);
    expect(questions.get('[data-testid="history-continue"]').attributes('href')).toBe(expected);
    questions.unmount();
    const returned = open(PrototypeStoryPage, returnUrl);
    expect(returned.get('h1').text()).toBe(seed.title);
    expect(returned.findAll('.prototype-story-article > p').map(node => node.text())).toEqual(seed.paragraphs);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(before);
  });
});
