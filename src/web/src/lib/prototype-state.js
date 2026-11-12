import { onUnmounted, shallowRef } from 'vue';
import seeds from '../content/prototype-stories.json';
import { prototypeChapters, lifeMapChapters, findLifeMapTopic } from './life-map-topics.js';
import { getPrototypeScenario } from './prototype-scenarios.js';
import { resolvePrototypeTopic } from './prototype-topic.js';
import { lifeMapDemoStories, lifeMapDemoSessions } from './life-map-demo.js';

// This store deliberately has no dependency on account state or service clients.
export const PROTOTYPE_STORAGE_KEY = import.meta.env.VITE_STATIC_PREVIEW === 'true'
  ? 'manji.html.prototype.v1' : 'manji.web2.prototype.v1';
export const PROTOTYPE_SEED_REVISION = 4;
const completedDemoChapters = new Set(['origins', 'life_today']);
const CHANGE_EVENT = 'manji:prototype-change';
const statuses = new Set(['running', 'paused', 'organizing', 'complete']);
const timestamp = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const validPair = (chapterId, contentId) => resolvePrototypeTopic(new URLSearchParams({ chapter_id: chapterId || '', content_id: contentId || '' })).kind === 'topic';

const questionList = topic => [topic.prompt, ...topic.followups];
function validTopicTurns(session, topic) {
  return Array.isArray(session.turns) && session.turns.length > 0
    && session.turnIndex === session.turns.length
    && session.turns[0]?.role === 'assistant'
    && session.turns.every(turn => turn && typeof turn.text === 'string' && turn.text.trim()
      && (turn.role === 'user' || (turn.role === 'assistant' && questionList(topic).includes(turn.text))));
}

export function getPrototypeSessionTurns(session) {
  if (!session) return [];
  if (findLifeMapTopic(session.chapterId, session.contentId)) return session.turns || [];
  return getPrototypeScenario(session.chapterId, session.contentId)?.turns.slice(0, session.turnIndex) || [];
}

function legacySeedStories() {
  return seeds.map((story, i) => {
    const date = new Date(Date.UTC(2026, 0, i + 1, 8)).toISOString();
    return { ...clone(story), createdAt: date, updatedAt: date };
  });
}

const seedStories = () => [...legacySeedStories(), ...clone(lifeMapDemoStories)];

function initialState() {
  return {
    version: 1,
    seedRevision: PROTOTYPE_SEED_REVISION,
    selectedChapterId: lifeMapChapters[0].id,
    stories: seedStories(),
    sessions: clone(lifeMapDemoSessions),
  };
}

// Project old demo snapshots onto the expanded sample set without replacing
// user-tested stories, their supplements, or unfinished narration records.
function expandSeedStories(stories, sessions, revision) {
  const needsOriginalExpansion = !Number.isInteger(revision) || revision < 2;
  for (const seed of legacySeedStories()) {
    // Revision 3 fills the two requested chapters without repopulating other stages.
    if (!needsOriginalExpansion && !completedDemoChapters.has(seed.chapter_id)) continue;
    const existing = stories.find(story => story.id === seed.id || (story.chapter_id === seed.chapter_id && story.content_id === seed.content_id));
    if (existing) {
      if (needsOriginalExpansion && ['demo-hometown-lane', 'demo-childhood-paper-boats'].includes(seed.id)
        && existing.id === seed.id && seed.paragraphs.slice(0, 2).every((paragraph, i) => existing.paragraphs[i] === paragraph)) {
        const additions = seed.paragraphs.slice(2);
        existing.paragraphs = [...existing.paragraphs.slice(0, 2), ...additions, ...existing.paragraphs.slice(2).filter(paragraph => !additions.includes(paragraph))];
      }
      continue;
    }
    const unfinished = sessions.some(session => session.chapterId === seed.chapter_id && session.contentId === seed.content_id && session.status !== 'complete');
    // Keep any existing take available; finishing it supplements this same topic.
    if (completedDemoChapters.has(seed.chapter_id) || !unfinished) stories.push(seed);
  }
}

function expandLifeMapDemo(stories, sessions) {
  for (const seed of lifeMapDemoStories) {
    // Existing writing and unfinished answers take precedence over sample content.
    if (stories.some(story => story.id === seed.id || (story.chapter_id === seed.chapter_id && story.content_id === seed.content_id))
      || sessions.some(session => session.chapterId === seed.chapter_id && session.contentId === seed.content_id)) continue;
    const recording = lifeMapDemoSessions.find(session => session.storyId === seed.id);
    if (sessions.some(session => session.id === recording.id)) continue;
    stories.push(clone(seed));
    sessions.push(clone(recording));
  }
}

export function getPrototypeState() {
  try {
    const state = JSON.parse(sessionStorage.getItem(PROTOTYPE_STORAGE_KEY));
    if (state?.version !== 1 || !Array.isArray(state.stories) || !Array.isArray(state.sessions)) return initialState();
    const storyIds = new Set(), sessionIds = new Set();
    const stories = state.stories.filter(story => {
      if (!story || typeof story.id !== 'string' || !story.id || storyIds.has(story.id) || !validPair(story.chapter_id, story.content_id) || typeof story.title !== 'string' || !Array.isArray(story.paragraphs) || !story.paragraphs.length || !story.paragraphs.every(p => typeof p === 'string') || !Number.isFinite(Date.parse(story.updatedAt))) return false;
      storyIds.add(story.id);
      return true;
    });
    const sessions = state.sessions.filter(session => {
      if (!session || typeof session.id !== 'string' || !session.id || sessionIds.has(session.id) || !validPair(session.chapterId, session.contentId) || !statuses.has(session.status) || !Number.isInteger(session.turnIndex) || session.turnIndex < 1 || !Number.isFinite(Date.parse(session.updatedAt))) return false;
      const topic = findLifeMapTopic(session.chapterId, session.contentId);
      if (topic ? !validTopicTurns(session, topic) : session.turnIndex > 4) return false;
      if (topic && ['organizing', 'complete'].includes(session.status) && !session.turns.some(turn => turn.role === 'user')) return false;
      if (topic && session.draft !== undefined && typeof session.draft !== 'string') return false;
      if (session.freeTalk && (session.chapterId !== 'childhood' || session.contentId !== 'childhood_memory')) return false;
      if (session.storyId && !stories.some(s => s.id === session.storyId && s.chapter_id === session.chapterId && s.content_id === session.contentId)) return false;
      if (session.status === 'complete' && !session.storyId) return false;
      if (session.status === 'organizing' && !Number.isFinite(Date.parse(session.organizingAt))) return false;
      sessionIds.add(session.id);
      return true;
    });
    const selectedChapterId = prototypeChapters.some(chapter => chapter.id === state.selectedChapterId) ? state.selectedChapterId : lifeMapChapters[0].id;
    if (!Number.isInteger(state.seedRevision) || state.seedRevision < 3) expandSeedStories(stories, sessions, state.seedRevision);
    if (!Number.isInteger(state.seedRevision) || state.seedRevision < 4) expandLifeMapDemo(stories, sessions);
    return { version: 1, seedRevision: PROTOTYPE_SEED_REVISION, selectedChapterId, stories, sessions };
  } catch {
    return initialState();
  }
}

function save(state) {
  // A failed write must not pretend the demo can survive the next page navigation.
  try { sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state)); }
  catch { throw new Error('无法保存进度，请允许当前页面使用浏览器存储后重试。'); }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function usePrototypeState() {
  const state = shallowRef(getPrototypeState());
  const refresh = () => { state.value = getPrototypeState(); };
  window.addEventListener(CHANGE_EVENT, refresh);
  window.addEventListener('pageshow', refresh);
  onUnmounted(() => {
    window.removeEventListener(CHANGE_EVENT, refresh);
    window.removeEventListener('pageshow', refresh);
  });
  return state;
}

export function resetPrototypeState() { const state = initialState(); save(state); return state; }
export function selectPrototypeChapter(chapterId) {
  const state = getPrototypeState();
  if (state.selectedChapterId === chapterId || !prototypeChapters.some(chapter => chapter.id === chapterId)) return;
  state.selectedChapterId = chapterId; save(state);
}
export function getPrototypeSession(id) { return getPrototypeState().sessions.find(session => session.id === id) || null; }

export function startPrototypeSession({ chapterId, contentId, freeTalk = false, storyId } = {}) {
  if (freeTalk) { chapterId = 'childhood'; contentId = 'childhood_memory'; }
  if (!validPair(chapterId, contentId)) return null;
  const state = getPrototypeState();
  if (storyId && !state.stories.some(story => story.id === storyId && story.chapter_id === chapterId && story.content_id === contentId)) return null;
  // A repeated start click or re-entry reuses the unfinished take for this topic.
  const previous = [...state.sessions].reverse().find(session => session.chapterId === chapterId && session.contentId === contentId && !!session.freeTalk === freeTalk && (session.storyId || null) === (storyId || null) && ['running', 'paused'].includes(session.status));
  if (previous) {
    previous.status = 'running'; previous.updatedAt = timestamp(); save(state); return previous;
  }
  const now = timestamp();
  const session = { id: `demo-${crypto.randomUUID()}`, chapterId, contentId, freeTalk, storyId: storyId || null, status: 'running', turnIndex: 1, createdAt: now, updatedAt: now, organizingAt: null };
  const topic = findLifeMapTopic(chapterId, contentId);
  if (topic) { session.turns = [{ role: 'assistant', text: topic.prompt }]; session.draft = ''; }
  state.sessions.push(session); save(state); return session;
}

function updateSession(id, change) {
  const state = getPrototypeState();
  const session = state.sessions.find(item => item.id === id);
  if (!session) return null;
  if (change(session, state)) { session.updatedAt = timestamp(); save(state); }
  return session;
}
export function pausePrototypeSession(id) {
  return updateSession(id, session => { if (session.status !== 'running') return false; session.status = 'paused'; return true; });
}
export function resumePrototypeSession(id) {
  return updateSession(id, session => { if (session.status !== 'paused') return false; session.status = 'running'; return true; });
}
export function advancePrototypeSession(id) {
  return updateSession(id, session => {
    if (session.status !== 'running') return false;
    const length = getPrototypeScenario(session.chapterId, session.contentId)?.turns.length || 0;
    if (session.turnIndex >= length) return false;
    session.turnIndex += 1; return true;
  });
}
export function savePrototypeTopicDraft(id, text) {
  return updateSession(id, session => {
    if (!findLifeMapTopic(session.chapterId, session.contentId) || !['running', 'paused'].includes(session.status) || typeof text !== 'string' || session.draft === text) return false;
    session.draft = text; return true;
  });
}
export function answerPrototypeTopic(id, text) {
  return updateSession(id, session => {
    if (!findLifeMapTopic(session.chapterId, session.contentId) || session.status !== 'running' || typeof text !== 'string' || !text.trim()) return false;
    session.turns.push({ role: 'user', text: text.trim() });
    session.turnIndex = session.turns.length; session.draft = ''; return true;
  });
}
export function choosePrototypeTopicQuestion(id, index) {
  return updateSession(id, session => {
    const topic = findLifeMapTopic(session.chapterId, session.contentId);
    if (!topic || session.status !== 'running' || session.draft?.trim() || !Number.isInteger(index) || index < 0 || index > topic.followups.length) return false;
    const text = questionList(topic)[index];
    const last = session.turns.at(-1);
    if (last?.role === 'assistant') last.text = text;
    else session.turns.push({ role: 'assistant', text });
    session.turnIndex = session.turns.length; return true;
  });
}
export function organizePrototypeSession(id) {
  return updateSession(id, session => {
    if (!['running', 'paused'].includes(session.status) || session.turnIndex < 2) return false;
    if (findLifeMapTopic(session.chapterId, session.contentId) && (session.draft?.trim() || !session.turns.some(turn => turn.role === 'user'))) return false;
    session.status = 'organizing'; session.organizingAt = timestamp(); return true;
  });
}
export function completePrototypeOrganization(id) {
  return updateSession(id, (session, state) => {
    if (session.status !== 'organizing' || Date.now() - Date.parse(session.organizingAt) < 2000) return false;
    const topic = findLifeMapTopic(session.chapterId, session.contentId);
    const scenario = getPrototypeScenario(session.chapterId, session.contentId);
    const paragraphs = topic ? session.turns.filter(turn => turn.role === 'user').flatMap(turn => turn.text.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean)) : scenario?.paragraphs;
    if (!paragraphs?.length) return false;
    let story = state.stories.find(item => session.storyId ? item.id === session.storyId : item.chapter_id === session.chapterId && item.content_id === session.contentId);
    if (story) {
      if (topic) {
        story.paragraphs.push(...paragraphs);
        if (story.source === 'fictional-demo') story.hasLocalAdditions = true;
      }
      else if (!story.paragraphs.includes(scenario.supplement)) story.paragraphs.push(scenario.supplement);
      story.updatedAt = timestamp();
    } else {
      const now = timestamp();
      story = { id: `demo-story-${session.chapterId}-${session.contentId}`, chapter_id: session.chapterId, content_id: session.contentId, title: topic?.title || scenario.title, paragraphs: [...paragraphs], createdAt: now, updatedAt: now };
      state.stories.push(story);
    }
    session.storyId = story.id;
    session.status = 'complete';
    return true;
  });
}

function optionalId(params, name) {
  return !params.has(name) || (params.getAll(name).length === 1 && !!params.get(name));
}

export function resolvePrototypeInterview(search = '') {
  const params = new URLSearchParams(search), topic = resolvePrototypeTopic(params);
  if (topic.kind === 'invalid' || !optionalId(params, 'session_id') || !optionalId(params, 'story_id')) return { kind: 'invalid', chapter: topic.chapter };
  const state = getPrototypeState();
  const session = params.has('session_id') ? state.sessions.find(item => item.id === params.get('session_id')) : null;
  const story = params.has('story_id') ? state.stories.find(item => item.id === params.get('story_id')) : null;
  if ((params.has('session_id') && !session) || (params.has('story_id') && !story)) return { kind: 'invalid', chapter: topic.chapter };
  const matches = (chapterId, contentId) => topic.kind === 'topic' && topic.chapter.id === chapterId && topic.content.id === contentId;
  if (session && !(topic.kind === 'free' ? session.freeTalk : matches(session.chapterId, session.contentId))) return { kind: 'invalid', chapter: topic.chapter };
  if (story && !matches(story.chapter_id, story.content_id)) return { kind: 'invalid', chapter: topic.chapter };
  if (story && session && session.storyId !== story.id) return { kind: 'invalid', chapter: topic.chapter };
  return { ...topic, session, story };
}

export function resolvePrototypeSession(search = '') {
  const params = new URLSearchParams(search);
  if (!params.has('session_id') || !optionalId(params, 'session_id') || !optionalId(params, 'story_id')) return null;
  const session = getPrototypeSession(params.get('session_id'));
  if (!session) return null;
  if (params.has('chapter_id') || params.has('content_id')) {
    const topic = resolvePrototypeTopic(params);
    if (topic.kind !== 'topic' || topic.chapter.id !== session.chapterId || topic.content.id !== session.contentId) return null;
  }
  if (params.has('story_id') && params.get('story_id') !== session.storyId) return null;
  return session;
}

export function resolvePrototypeStory(search = '') {
  const params = new URLSearchParams(search), topic = resolvePrototypeTopic(params);
  if (topic.kind !== 'topic' || !optionalId(params, 'story_id') || !optionalId(params, 'session_id')) return { kind: 'invalid', chapter: topic.chapter, stories: [] };
  let stories = getPrototypeState().stories.filter(story => story.chapter_id === topic.chapter.id && story.content_id === topic.content.id);
  if (params.has('story_id')) {
    stories = stories.filter(story => story.id === params.get('story_id'));
    if (!stories.length) return { kind: 'invalid', chapter: topic.chapter, stories: [] };
  }
  if (params.has('session_id')) {
    const session = resolvePrototypeSession(params);
    if (!session || session.status !== 'complete' || !stories.some(story => story.id === session.storyId)) return { kind: 'invalid', chapter: topic.chapter, stories: [] };
  }
  return { ...topic, stories };
}
