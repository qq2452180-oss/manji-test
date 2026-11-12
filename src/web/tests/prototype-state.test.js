import { legacyPrototypeSnapshot } from './prototype-fixtures.js';
import { lifeMapDemoStories, lifeMapDemoSessions } from '../src/lib/life-map-demo.js';
import { describe, expect, it, vi } from 'vitest';
import template from '../src/content/biography-template.json';
import seeds from '../src/content/prototype-stories.json';
import { getPrototypeScenario } from '../src/lib/prototype-scenarios.js';
import { PROTOTYPE_STORAGE_KEY, getPrototypeState, getPrototypeSession, startPrototypeSession, pausePrototypeSession, resumePrototypeSession, advancePrototypeSession, organizePrototypeSession, completePrototypeOrganization, resetPrototypeState, resolvePrototypeInterview, resolvePrototypeSession, resolvePrototypeStory } from '../src/lib/prototype-state.js';
import { prototypeBackLink, prototypeInterviewUrl, prototypeStoryUrl } from '../src/lib/prototype-topic.js';

const allSeeds = [...seeds, ...lifeMapDemoStories];

function begin(options = { chapterId: 'childhood', contentId: 'childhood_occasions' }) {
  return startPrototypeSession(options);
}
function organize(session) {
  advancePrototypeSession(session.id);
  return organizePrototypeSession(session.id);
}
function complete(session) {
  organize(session);
  vi.advanceTimersByTime(2000);
  return completePrototypeOrganization(session.id);
}
function clock() { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T09:00:00Z')); }
function legacyState() {
  const oldIds = ['demo-hometown-lane', 'demo-childhood-paper-boats'];
  return {
    version: 1,
    selectedChapterId: 'livelihood',
    stories: oldIds.map(id => ({
      ...structuredClone(seeds.find(seed => seed.id === id)),
      paragraphs: seeds.find(seed => seed.id === id).paragraphs.slice(0, 2),
      createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z',
    })),
    sessions: [],
  };
}
function legacySession(id, chapterId, contentId, status = 'paused', storyId = null) {
  return {
    id, chapterId, contentId, freeTalk: false, storyId, status, turnIndex: 2,
    createdAt: '2026-11-03T08:00:00.000Z', updatedAt: '2026-11-03T08:01:00.000Z',
    organizingAt: status === 'organizing' ? '2026-11-03T08:01:00.000Z' : null,
  };
}

describe('isolated prototype state', () => {
  it('initializes 41 stories and 24 completed sample sessions without creating new activity or touching credentials', () => {
    sessionStorage.setItem('manji.auth', 'official');
    localStorage.setItem('business-record', 'untouched');
    expect(getPrototypeState().stories.map(s => s.id)).toEqual(allSeeds.map(s => s.id));
    expect(getPrototypeState().stories).toHaveLength(41);
    expect(getPrototypeState()).toMatchObject({ version: 1, seedRevision: 4 });
    expect(getPrototypeState().stories.every(story => Number.isFinite(Date.parse(story.createdAt)) && Number.isFinite(Date.parse(story.updatedAt)))).toBe(true);
    expect(getPrototypeState().sessions).toEqual(lifeMapDemoSessions);
    expect(resolvePrototypeInterview('?chapter_id=origins&content_id=early_household').kind).toBe('topic');
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('manji.auth')).toBe('official');
    expect(localStorage.getItem('business-record')).toBe('untouched');
  });

  it.each([undefined, 1])('upgrades legacy seed revision %s without overwriting supplements, sessions, or stored data', revision => {
    const previous = legacyState();
    if (revision !== undefined) previous.seedRevision = revision;
    const supplement = '这是我后来补充的回忆，仍要跟在原故事后面。';
    previous.stories[0].paragraphs.push(supplement);
    previous.sessions = [
      legacySession('old-paused', 'origins', 'hometown', 'paused', previous.stories[0].id),
      legacySession('old-organizing', 'origins', 'early_household', 'organizing'),
    ];
    const saved = JSON.stringify(previous);
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, saved);
    sessionStorage.setItem('manji.auth_token', 'official-token');
    localStorage.setItem('formal-record', 'official-record');

    const upgraded = getPrototypeState();
    expect(upgraded).toMatchObject({ version: 1, seedRevision: 4, selectedChapterId: 'livelihood' });
    expect(upgraded.stories).toHaveLength(allSeeds.length);
    expect(new Set(upgraded.stories.map(story => `${story.chapter_id}/${story.content_id}`)).size).toBe(allSeeds.length);
    for (const seed of seeds) {
      expect(upgraded.stories.find(story => story.id === seed.id)?.paragraphs).toEqual([
        ...seed.paragraphs, ...(seed.id === previous.stories[0].id ? [supplement] : []),
      ]);
    }
    expect(upgraded.stories[0]).toMatchObject({ createdAt: previous.stories[0].createdAt, updatedAt: previous.stories[0].updatedAt });
    expect(upgraded.sessions).toEqual([...previous.sessions, ...lifeMapDemoSessions]);
    expect(getPrototypeState()).toEqual(upgraded);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(saved);
    expect(sessionStorage.getItem('manji.auth_token')).toBe('official-token');
    expect(localStorage.getItem('formal-record')).toBe('official-record');

    resumePrototypeSession('old-paused');
    const persisted = JSON.parse(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY));
    expect(persisted.seedRevision).toBe(4);
    expect(persisted.stories).toEqual(upgraded.stories);
    expect(getPrototypeState().stories).toEqual(upgraded.stories);
    expect(getPrototypeState().sessions.find(session => session.id === 'old-organizing')).toEqual(previous.sessions[1]);
    expect(sessionStorage.getItem('manji.auth_token')).toBe('official-token');
    expect(localStorage.getItem('formal-record')).toBe('official-record');
  });

  it('preserves an existing story and id for a newly seeded topic instead of replacing it', () => {
    const previous = legacyState();
    const existing = {
      ...structuredClone(seeds.find(seed => seed.chapter_id === 'livelihood' && seed.content_id === 'main_work')),
      id: 'previously-told-main-work', title: '我已经讲过的工作故事', paragraphs: ['这是之前整理的正文。', '这是我补充的经历。'],
      createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z',
    };
    previous.stories.push(existing);
    previous.sessions.push(legacySession('completed-work', existing.chapter_id, existing.content_id, 'complete', existing.id));
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(previous));
    const upgraded = getPrototypeState();
    expect(upgraded.stories).toHaveLength(allSeeds.length);
    expect(upgraded.stories.filter(story => story.chapter_id === existing.chapter_id && story.content_id === existing.content_id)).toEqual([existing]);
    expect(upgraded.sessions).toEqual([...previous.sessions, ...lifeMapDemoSessions]);
    expect(getPrototypeState()).toEqual(upgraded);
  });

  it('fills both end chapters in revision two without rewriting existing stories or unrelated chapters', () => {
    clock();
    const addedIds = new Set(['demo-early-household', 'demo-family-livelihood', 'demo-neighborhood', 'demo-recent-life', 'demo-present-interests', 'demo-present-concerns', 'demo-words-to-keep']);
    const previous = legacyPrototypeSnapshot();
    previous.seedRevision = 2;
    previous.selectedChapterId = 'life_today';
    previous.stories = previous.stories.filter(story => !addedIds.has(story.id) && story.id !== 'demo-main-work');
    const hometown = previous.stories.find(story => story.id === 'demo-hometown-lane');
    hometown.paragraphs[2] = '这是我修改过的巷口回忆。';
    hometown.paragraphs.push('先前讲述留下的补充也要保留。');
    const custom = {
      id: 'my-neighborhood', chapter_id: 'origins', content_id: 'neighborhood', title: '我自己的邻里故事',
      paragraphs: ['这段是已经整理过的邻里回忆。'], createdAt: hometown.createdAt, updatedAt: hometown.updatedAt,
    };
    previous.stories.push(custom);
    previous.sessions = [legacySession('unfinished-ending', 'life_today', 'words_to_keep')];
    const saved = JSON.stringify(previous);
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, saved);
    sessionStorage.setItem('formal-account', 'untouched');

    const upgraded = getPrototypeState();
    expect(upgraded).toMatchObject({ seedRevision: 4, selectedChapterId: 'life_today', sessions: [...previous.sessions, ...lifeMapDemoSessions] });
    expect(upgraded.stories).toHaveLength(allSeeds.length - 1);
    for (const chapterId of ['origins', 'life_today']) {
      expect(upgraded.stories.filter(story => story.chapter_id === chapterId).map(story => story.content_id).sort()).toEqual(
        template.chapters.find(chapter => chapter.id === chapterId).core_contents.map(content => content.id).sort(),
      );
    }
    expect(upgraded.stories.find(story => story.id === hometown.id)).toEqual(hometown);
    expect(upgraded.stories.filter(story => story.content_id === 'neighborhood')).toEqual([custom]);
    expect(upgraded.stories.some(story => story.content_id === 'main_work')).toBe(false);
    expect(getPrototypeState()).toEqual(upgraded);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(saved);

    resumePrototypeSession('unfinished-ending');
    const completed = complete(getPrototypeSession('unfinished-ending'));
    const ending = getPrototypeState().stories.find(story => story.id === completed.storyId);
    expect(ending.id).toBe('demo-words-to-keep');
    expect(ending.paragraphs).toEqual([
      ...seeds.find(story => story.id === ending.id).paragraphs,
      getPrototypeScenario('life_today', 'words_to_keep').supplement,
    ]);
    completePrototypeOrganization(completed.id);
    expect(getPrototypeState().stories).toHaveLength(allSeeds.length - 1);
    expect(getPrototypeState().stories.find(story => story.id === hometown.id)).toEqual(hometown);
    expect(JSON.parse(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).seedRevision).toBe(4);
    expect(sessionStorage.getItem('formal-account')).toBe('untouched');
  });

  it('does not rewrite an old seed whose existing original paragraphs no longer match', () => {
    const previous = legacyState();
    previous.stories[0].paragraphs = ['这段原文已经经过我自己的修改。', '这段回忆也需要保留。', '后来的补充内容。'];
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(previous));
    expect(getPrototypeState().stories.find(story => story.id === previous.stories[0].id)).toEqual(previous.stories[0]);
    expect(getPrototypeState().stories).toHaveLength(allSeeds.length);
  });

  it.each(['running', 'paused', 'organizing'])('keeps a newly seeded topic unspoken while its legacy session is %s', status => {
    const previous = legacyState();
    const unfinished = legacySession('unfinished-work', 'livelihood', 'main_work', status);
    previous.sessions.push(unfinished);
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(previous));
    const upgraded = getPrototypeState();
    expect(upgraded.stories).toHaveLength(allSeeds.length - 1);
    expect(upgraded.stories.some(story => story.chapter_id === unfinished.chapterId && story.content_id === unfinished.contentId)).toBe(false);
    expect(upgraded.sessions).toEqual([unfinished, ...lifeMapDemoSessions]);
    expect(getPrototypeState()).toEqual(upgraded);
  });

  it('keeps an explicitly empty current revision empty, and reset restores the complete current seed collection', () => {
    const current = { version: 1, seedRevision: 4, selectedChapterId: 'childhood', stories: [], sessions: [] };
    const saved = JSON.stringify(current);
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, saved);
    expect(getPrototypeState()).toEqual(current);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(saved);
    resetPrototypeState();
    const reset = getPrototypeState();
    expect(reset).toMatchObject({ version: 1, seedRevision: 4, selectedChapterId: 'L1', sessions: lifeMapDemoSessions });
    expect(reset.stories.map(story => ({ id: story.id, paragraphs: story.paragraphs }))).toEqual(allSeeds.map(story => ({ id: story.id, paragraphs: story.paragraphs })));
  });

  it('pauses persistently and advances only after an explicit resume', () => {
    const session = begin();
    advancePrototypeSession(session.id);
    pausePrototypeSession(session.id);
    expect(JSON.parse(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).sessions.find(item => item.id === session.id)).toMatchObject({ id: session.id, status: 'paused', turnIndex: 2 });
    advancePrototypeSession(session.id);
    expect(getPrototypeSession(session.id).turnIndex).toBe(2);
    resumePrototypeSession(session.id);
    advancePrototypeSession(session.id);
    expect(getPrototypeSession(session.id)).toMatchObject({ status: 'running', turnIndex: 3 });
    expect(begin().id).toBe(session.id);
    expect(getPrototypeState().sessions).toHaveLength(lifeMapDemoSessions.length + 1);
  });

  it('requires a visible user turn and completes once after two seconds, even when called repeatedly', () => {
    clock();
    const session = begin();
    expect(organizePrototypeSession(session.id).status).toBe('running');
    const pending = organize(session);
    vi.advanceTimersByTime(1000);
    expect(organizePrototypeSession(session.id).organizingAt).toBe(pending.organizingAt);
    expect(completePrototypeOrganization(session.id).status).toBe('organizing');
    vi.advanceTimersByTime(1000);
    const result = completePrototypeOrganization(session.id);
    expect(result.status).toBe('complete');
    const saved = sessionStorage.getItem(PROTOTYPE_STORAGE_KEY);
    completePrototypeOrganization(session.id); organizePrototypeSession(session.id); resumePrototypeSession(session.id);
    expect(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(saved);
    expect(getPrototypeState().stories).toHaveLength(allSeeds.length + 1);
    expect(getPrototypeState().stories.find(s => s.id === result.storyId).paragraphs).toEqual(getPrototypeScenario(session.chapterId, session.contentId).paragraphs);
  });

  it('appends a supplement to the same story without replacing its original paragraphs', () => {
    clock();
    const seed = seeds.find(item => item.id === 'demo-hometown-lane');
    const session = begin({ chapterId: seed.chapter_id, contentId: seed.content_id, storyId: seed.id });
    const result = complete(session);
    const story = getPrototypeState().stories.find(s => s.id === seed.id);
    expect(result.storyId).toBe(seed.id);
    expect(story.paragraphs).toEqual([...seed.paragraphs, getPrototypeScenario(seed.chapter_id, seed.content_id).supplement]);
    completePrototypeOrganization(session.id);
    expect(getPrototypeState().stories).toHaveLength(allSeeds.length);
    expect(getPrototypeState().stories.find(s => s.id === seed.id).paragraphs).toHaveLength(seed.paragraphs.length + 1);
  });

  it('completes separate supplement sessions without repeating the same fixed demo paragraph', () => {
    clock();
    const seed = seeds.find(item => item.id === 'demo-hometown-lane');
    const options = { chapterId: seed.chapter_id, contentId: seed.content_id, storyId: seed.id };
    const first = complete(begin(options));
    const second = complete(begin(options));
    expect(second.id).not.toBe(first.id);
    expect([getPrototypeSession(first.id), getPrototypeSession(second.id)].map(session => ({ status: session.status, storyId: session.storyId }))).toEqual([
      { status: 'complete', storyId: seed.id },
      { status: 'complete', storyId: seed.id },
    ]);
    const supplement = getPrototypeScenario(seed.chapter_id, seed.content_id).supplement;
    const story = getPrototypeState().stories.find(item => item.id === seed.id);
    expect(story.paragraphs).toEqual([...seed.paragraphs, supplement]);
    expect(story.paragraphs.filter(paragraph => paragraph === supplement)).toHaveLength(1);
    expect(getPrototypeState().stories).toHaveLength(allSeeds.length);
  });

  it('places free talk into the fixed childhood fragment', () => {
    clock();
    const session = begin({ freeTalk: true });
    const result = complete(session);
    expect(getPrototypeState().stories.find(s => s.id === result.storyId)).toMatchObject({ chapter_id: 'childhood', content_id: 'childhood_memory' });
    expect(resolvePrototypeInterview(new URL(prototypeInterviewUrl(undefined, undefined, { sessionId: session.id }), location.href).search).kind).toBe('free');
  });

  it('reset restores seeds and prevents an old organizing callback from resurrecting a story', () => {
    clock();
    sessionStorage.setItem('official-session', 'kept'); localStorage.setItem('official-record', 'kept');
    const session = begin(); organize(session);
    resetPrototypeState(); vi.advanceTimersByTime(5000);
    expect(completePrototypeOrganization(session.id)).toBeNull();
    expect(getPrototypeState().stories.map(s => s.id)).toEqual(allSeeds.map(s => s.id));
    expect(getPrototypeState().sessions).toEqual(lifeMapDemoSessions);
    expect(sessionStorage.getItem('official-session')).toBe('kept');
    expect(localStorage.getItem('official-record')).toBe('kept');
  });

  it('rejects unknown, repeated, or mismatched identifiers without selecting another story', () => {
    clock();
    const session = complete(begin());
    const matching = new URL(prototypeInterviewUrl(session.chapterId, session.contentId, { sessionId: session.id }), location.href).search;
    expect(resolvePrototypeInterview(matching).session.id).toBe(session.id);
    for (const search of [matching + '&session_id=' + session.id, matching.replace('childhood_occasions', 'hometown'), '?session_id=' + session.id, '?chapter_id=origins&content_id=hometown&story_id=missing', '?chapter_id=origins&content_id=hometown&story_id=' + seeds.find(item => item.id === 'demo-childhood-paper-boats').id]) {
      expect(resolvePrototypeInterview(search).kind).toBe('invalid');
    }
    expect(resolvePrototypeSession('?session_id=' + session.id + '&chapter_id=childhood&content_id=childhood_memory')).toBeNull();
    expect(resolvePrototypeSession('?session_id=' + session.id + '&session_id=' + session.id)).toBeNull();
    for (const suffix of ['&story_id=missing', '&story_id=' + seeds.find(item => item.id === 'demo-childhood-paper-boats').id, '&session_id=' + session.id]) {
      const context = resolvePrototypeStory('?chapter_id=origins&content_id=hometown' + suffix);
      expect(context.kind).toBe('invalid'); expect(context.stories).toEqual([]);
    }
    expect(startPrototypeSession({ chapterId: 'childhood', contentId: 'hometown' })).toBeNull();
    expect(startPrototypeSession({ chapterId: 'origins', contentId: 'hometown', storyId: seeds.find(item => item.id === 'demo-childhood-paper-boats').id })).toBeNull();
  });

  it('routes source back links only to prototype pages and handles corrupt local demo state', () => {
    const context = { chapterId: 'origins', contentId: 'hometown', storyId: seeds.find(item => item.id === 'demo-hometown-lane').id };
    expect(prototypeBackLink('?from=chapter', context).href).toBe('./chapter.html?prototype=1&chapter_id=origins');
    expect(prototypeBackLink('?from=biography', context).href).toBe('./biography.html?prototype=1');
    expect(prototypeBackLink('?from=history&session_id=demo-id', context).href).toBe('./history.html?prototype=1&session_id=demo-id');
    expect(prototypeBackLink('?back=story&from=chapter', context).href).toBe(prototypeStoryUrl('origins', 'hometown', { storyId: seeds.find(item => item.id === 'demo-hometown-lane').id, from: 'chapter' }));
    expect(prototypeBackLink('?from=https://invalid.example', context).href).toBe('./index.html?prototype=1&chapter_id=origins');
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, '{broken');
    expect(getPrototypeState().stories).toHaveLength(allSeeds.length);
  });

  it('provides an individual script and draft for each of the 40 exact template pairs', () => {
    let count = 0;
    for (const chapter of template.chapters) for (const content of chapter.core_contents) {
      const scenario = getPrototypeScenario(chapter.id, content.id);
      expect(scenario).toBeTruthy();
      expect(scenario.turns.map(turn => turn.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
      expect(scenario.paragraphs).toHaveLength(2);
      expect(scenario.supplement.trim().length).toBeGreaterThan(0);
      count++;
    }
    expect(count).toBe(40);
    expect(getPrototypeScenario('origins', 'childhood_memory')).toBeNull();
  });
});
