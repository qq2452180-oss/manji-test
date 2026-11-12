import manuscript from '../src/content/life-map-biography.json';
import { lifeMapDemoStories, lifeMapDemoSessions } from '../src/lib/life-map-demo.js';
import { useLegacyPrototypeSnapshot } from './prototype-fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PrototypeNav from '../src/components/PrototypeNav.vue';
import PrototypeBiographyPage from '../src/pages/PrototypeBiographyPage.vue';
import PrototypeChapterPage from '../src/pages/PrototypeChapterPage.vue';
import PrototypeProfilePage from '../src/pages/PrototypeProfilePage.vue';
import PrototypeFamilyPage from '../src/pages/PrototypeFamilyPage.vue';
import { getPrototypeState, PROTOTYPE_STORAGE_KEY, startPrototypeSession, advancePrototypeSession, organizePrototypeSession, completePrototypeOrganization, resetPrototypeState } from '../src/lib/prototype-state.js';
import { getPrototypeScenario } from '../src/lib/prototype-scenarios.js';
import initialStories from '../src/content/prototype-stories.json';
import bookends from '../src/content/prototype-biography-bookends.json';
import template from '../src/content/biography-template.json';

const currentSampleStories = [...initialStories, ...lifeMapDemoStories];
const currentSampleParagraphs = manuscript.chapters.flatMap(chapter => chapter.passages.flatMap(passage => passage.paragraphs));
const initialTitles = initialStories.map(story => story.title);
const seedReadingParagraphs = story => bookends[story.id] || story.paragraphs;
const chapterStories = (chapterId, stories = initialStories) => template.chapters.find(chapter => chapter.id === chapterId).core_contents
  .flatMap(content => stories.filter(story => story.chapter_id === chapterId && story.content_id === content.id));
const chapterParagraphs = (chapterId, stories = initialStories) => chapterStories(chapterId, stories).flatMap(seedReadingParagraphs);
const orderedParagraphs = stories => template.chapters.flatMap(chapter => chapterParagraphs(chapter.id, stories));
const initialChapterTitles = template.chapters.filter(chapter => initialStories.some(story => story.chapter_id === chapter.id)).map(chapter => chapter.title);
const hometownStory = initialStories.find(story => story.id === 'demo-hometown-lane');
const snapshot = storage => Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
  const key = storage.key(index);
  return [key, storage.getItem(key)];
}));
const officialSessionSnapshot = () => {
  const values = snapshot(sessionStorage);
  delete values[PROTOTYPE_STORAGE_KEY];
  return values;
};
const render = (component, search = '?prototype=1') => {
  history.replaceState(null, '', '/web2/index.html' + search);
  return mount(component, { attachTo: document.body });
};
function saveChangedDemo() {
  const state = getPrototypeState();
  state.stories.push({
    id: 'demo-added-story', chapter_id: 'adolescence', content_id: 'learning_experience',
    title: '新增的学习经历', paragraphs: ['这是一段后来补充的演示内容。'],
    createdAt: '2026-02-01T08:00:00.000Z', updatedAt: '2026-02-01T08:00:00.000Z',
  });
  state.sessions.push({
    id: 'demo-saved-session', chapterId: 'origins', contentId: 'hometown',
    status: 'paused', turnIndex: 2, storyId: null, freeTalk: false,
    createdAt: '2026-02-02T08:00:00.000Z', updatedAt: '2026-02-02T08:00:00.000Z', organizingAt: null,
  });
  sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
  sessionStorage.setItem('manji.auth_token', 'formal-account-sentinel');
  sessionStorage.setItem('manji.active_session', 'formal-session-sentinel');
  sessionStorage.setItem('another-app', 'unrelated-session-sentinel');
  localStorage.setItem('manji.web2.welcome.seen.v1', '1');
  localStorage.setItem('formal-account-settings', 'unrelated-local-sentinel');
  return state;
}
const resetButton = wrapper => wrapper.get('.prototype-profile-menu button');
const confirmButton = wrapper => wrapper.get('.prototype-reset-actions button:not(.prototype-reset-cancel)');
const draftParagraphs = wrapper => wrapper.findAll('.prototype-draft-paragraph').map(paragraph => paragraph.text());
const initialParagraphs = orderedParagraphs(initialStories);
async function finishDemo(chapterId, contentId, storyId) {
  const session = startPrototypeSession({ chapterId, contentId, storyId });
  advancePrototypeSession(session.id);
  organizePrototypeSession(session.id);
  vi.advanceTimersByTime(2000);
  const completed = completePrototypeOrganization(session.id);
  await nextTick();
  return completed;
}

beforeEach(() => {
  useLegacyPrototypeSnapshot();
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {
    this.open = true;
    this.querySelector('[autofocus]')?.focus();
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('prototype library navigation', () => {
  it.each([
    ['map', '人生轨迹'],
    ['book', '传记'],
    ['', ''],
  ])('keeps all five destinations in order and marks only the current destination %s', (active, label) => {
    const wrapper = mount(PrototypeNav, { props: { active } });
    expect(wrapper.findAll('a').map(link => [link.text(), link.attributes('href')])).toEqual([
      ['人生轨迹', './index.html?prototype=1'],
      ['传记', './biography.html?prototype=1'],
      ['小暖', './interview.html?prototype=1'],
      ['家人', './preview.html?prototype=1&kind=family'],
      ['我的', './profile.html?prototype=1'],
    ]);
    expect(wrapper.get('[data-testid="xiaonuan-entry"]').attributes('aria-label')).toBe('和小暖聊聊');
    expect(wrapper.findAll('[aria-current="page"]')).toHaveLength(active ? 1 : 0);
    if (active) expect(wrapper.get('[aria-current="page"]').text()).toBe(label);
  });

  it('opens retained legacy seed stories directly as a draft without writing data or displaying story lists', () => {
    sessionStorage.setItem('manji.auth_token', 'formal-account-sentinel');
    localStorage.setItem('formal-account-settings', 'unrelated-local-sentinel');
    const beforeSession = snapshot(sessionStorage), beforeLocal = snapshot(localStorage);
    const wrapper = render(PrototypeBiographyPage);
    expect(wrapper.get('[data-testid="prototype-biography-page"] h1').text()).toBe('我的传记');
    expect(wrapper.find('header a[href="./profile.html?prototype=1"]').exists()).toBe(false);
    expect(wrapper.get('.prototype-draft-label').text()).toBe('草稿');
    const draft = wrapper.get('[data-testid="prototype-biography-draft"]');
    expect(draft.attributes('aria-label')).toBe('人生传记草稿');
    expect(draft.findAll('h2').map(node => node.text())).toEqual(initialChapterTitles);
    expect(draftParagraphs(draft)).toEqual(initialParagraphs);
    const figures = draft.findAll('figure.prototype-memory-image');
    expect(figures).toHaveLength(4);
    expect(figures.map(figure => figure.get('figcaption').text())).toEqual(['老巷里的傍晚', '雨后的小纸船', '小店的日常', '一家人的饭桌']);
    expect(figures.map(figure => figure.element.previousElementSibling.textContent)).toEqual([
      ['origins', 'hometown'], ['childhood', 'playmates_and_play'],
      ['livelihood', 'main_work'], ['family_and_relationships', 'shared_daily_life'],
    ].map(([chapterId, contentId]) => seedReadingParagraphs(initialStories.find(story => story.chapter_id === chapterId && story.content_id === contentId))[1]));
    for (const figure of figures) {
      expect(figure.get('img').attributes('alt').trim().length).toBeGreaterThan(0);
      expect(figure.get('img').attributes('loading')).toBe('lazy');
    }
    expect(wrapper.get('[data-testid="biography-stage-origins"]').find('.prototype-draft-transition').exists()).toBe(false);
    expect(wrapper.get('[data-testid="biography-stage-life_today"]').find('.prototype-draft-transition').exists()).toBe(false);
    expect(wrapper.findAll('.prototype-draft-transition')).toHaveLength(initialChapterTitles.length - 2);
    expect(wrapper.find('.book-cover, .prototype-chapter-list, .prototype-recent-list').exists()).toBe(false);
    expect(draft.find('a').exists()).toBe(false);
    const headingsAndLinks = draft.findAll('h1, h2, h3, h4, h5, h6, a').map(node => node.text());
    for (const title of initialTitles) expect(headingsAndLinks).not.toContain(title);
    expect(wrapper.text()).not.toContain('章节目录');
    expect(wrapper.text()).not.toContain('最近整理');
    expect(wrapper.get('[aria-current="page"]').text()).toBe('传记');
    expect(document.title).toBe('慢记 · 我的传记');
    expect(snapshot(sessionStorage)).toEqual(beforeSession);
    expect(snapshot(localStorage)).toEqual(beforeLocal);
  });

  it('hides an unavailable illustration without removing or changing the biography text', async () => {
    const wrapper = render(PrototypeBiographyPage);
    const beforeStorage = snapshot(sessionStorage);
    const first = wrapper.get('figure.prototype-memory-image img');
    expect(wrapper.findAll('figure.prototype-memory-image')).toHaveLength(4);
    await first.trigger('error');
    expect(wrapper.findAll('figure.prototype-memory-image')).toHaveLength(3);
    expect(draftParagraphs(wrapper)).toEqual(initialParagraphs);
    expect(snapshot(sessionStorage)).toEqual(beforeStorage);
  });

  it('adds only organized stories and inserts their text in life-map order even when completed later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T08:00:00.000Z'));
    const wrapper = render(PrototypeBiographyPage);
    const pending = startPrototypeSession({ chapterId: 'adolescence', contentId: 'learning_experience' });
    advancePrototypeSession(pending.id);
    await nextTick();
    expect(draftParagraphs(wrapper)).toEqual(initialParagraphs);
    expect(draftParagraphs(wrapper.get('[data-testid="biography-stage-adolescence"]'))).toEqual(chapterParagraphs('adolescence'));
    expect(draftParagraphs(wrapper)).not.toContain(getPrototypeScenario('adolescence', 'learning_experience').paragraphs[0]);
    organizePrototypeSession(pending.id);
    await nextTick();
    expect(draftParagraphs(wrapper)).toEqual(initialParagraphs);
    vi.advanceTimersByTime(2000);
    completePrototypeOrganization(pending.id);
    await nextTick();
    expect(draftParagraphs(wrapper.get('[data-testid="biography-stage-adolescence"]'))).toEqual([
      ...getPrototypeScenario('adolescence', 'learning_experience').paragraphs, ...chapterParagraphs('adolescence'),
    ]);

    await finishDemo('childhood', 'childhood_occasions');
    expect(wrapper.get('[data-testid="prototype-biography-draft"]').findAll('h2').map(node => node.text())).toEqual(initialChapterTitles);
    expect(draftParagraphs(wrapper.get('[data-testid="biography-stage-childhood"]'))).toEqual([
      ...chapterParagraphs('childhood'), ...getPrototypeScenario('childhood', 'childhood_occasions').paragraphs,
    ]);
    expect(draftParagraphs(wrapper.get('[data-testid="biography-stage-origins"]'))).toEqual(chapterParagraphs('origins'));
    expect(wrapper.text()).not.toContain(getPrototypeScenario('childhood', 'childhood_occasions').title);
  });

  it('preserves original story paragraphs while showing the edited passage and its supplement once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T08:00:00.000Z'));
    const wrapper = render(PrototypeBiographyPage);
    const source = hometownStory;
    const completed = await finishDemo(source.chapter_id, source.content_id, source.id);
    completePrototypeOrganization(completed.id);
    await nextTick();
    expect(draftParagraphs(wrapper.get('[data-testid="biography-stage-origins"]'))).toEqual([
      ...seedReadingParagraphs(source), getPrototypeScenario(source.chapter_id, source.content_id).supplement,
      ...chapterStories(source.chapter_id).filter(story => story.id !== source.id).flatMap(seedReadingParagraphs),
    ]);
    expect(draftParagraphs(wrapper.get('[data-testid="biography-stage-childhood"]'))).toEqual(chapterParagraphs('childhood'));
    expect(wrapper.get('[data-testid="prototype-biography-draft"]').findAll('h2').map(node => node.text())).toEqual(initialChapterTitles);
    expect(getPrototypeState().stories).toHaveLength(initialStories.length);
    expect(getPrototypeState().stories.find(story => story.id === source.id).paragraphs).toEqual([
      ...source.paragraphs, getPrototypeScenario(source.chapter_id, source.content_id).supplement,
    ]);
  });

  it('refreshes on browser return and remounts from current stories without persisting a separate draft', async () => {
    let wrapper = render(PrototypeBiographyPage);
    const changedState = saveChangedDemo();
    const beforeSession = snapshot(sessionStorage), beforeLocal = snapshot(localStorage);
    window.dispatchEvent(new Event('pageshow'));
    await nextTick();
    const expected = orderedParagraphs(changedState.stories);
    expect(draftParagraphs(wrapper)).toEqual(expected);
    wrapper.unmount();
    wrapper = render(PrototypeBiographyPage);
    expect(draftParagraphs(wrapper)).toEqual(expected);
    expect(snapshot(sessionStorage)).toEqual(beforeSession);
    expect(snapshot(localStorage)).toEqual(beforeLocal);
  });

  it('reads saved progress using the new passage and falls back to edited source text on browser return', async () => {
    const state = getPrototypeState();
    const source = state.stories.find(story => story.id === hometownStory.id);
    source.paragraphs.push('之前这次演示留下的补充。');
    state.stories = [source];
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
    const beforeSession = snapshot(sessionStorage);
    const wrapper = render(PrototypeBiographyPage);
    expect(draftParagraphs(wrapper)).toEqual([...bookends[source.id], '之前这次演示留下的补充。']);
    expect(wrapper.findAll('.prototype-draft-stage')).toHaveLength(1);
    expect(snapshot(sessionStorage)).toEqual(beforeSession);

    source.paragraphs[0] = '这段故事已经有了我自己的开头。';
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
    const changedSnapshot = snapshot(sessionStorage);
    window.dispatchEvent(new Event('pageshow'));
    await nextTick();
    expect(draftParagraphs(wrapper)).toEqual(source.paragraphs);
    expect(snapshot(sessionStorage)).toEqual(changedSnapshot);
  });

  it('updates an open draft to the current seed collection when the demo is reset', async () => {
    saveChangedDemo();
    const beforeOfficial = officialSessionSnapshot(), beforeLocal = snapshot(localStorage);
    const wrapper = render(PrototypeBiographyPage);
    expect(draftParagraphs(wrapper)).toContain('这是一段后来补充的演示内容。');
    resetPrototypeState();
    await nextTick();
    expect(draftParagraphs(wrapper)).toEqual(currentSampleParagraphs);
    expect(draftParagraphs(wrapper)).not.toContain('这是一段后来补充的演示内容。');
    expect(wrapper.findAll('.prototype-draft-stage h2').map(heading => heading.text())).toEqual(manuscript.chapters.map(chapter => chapter.title));
    expect(officialSessionSnapshot()).toEqual(beforeOfficial);
    expect(snapshot(localStorage)).toEqual(beforeLocal);
  });

  it('offers free narration from an empty draft and preserves the biography return source', () => {
    const state = getPrototypeState();
    state.stories = [];
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
    const wrapper = render(PrototypeBiographyPage);
    expect(wrapper.find('[data-testid="prototype-biography-draft"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('讲下的故事，会在这里慢慢成书。');
    const link = wrapper.get('.prototype-library-empty .prototype-library-button');
    expect(link.text()).toBe('和小暖聊聊');
    expect(link.attributes('href')).toBe('./interview.html?prototype=1&from=biography');
  });

  it('shows only stories from the requested chapter and preserves its return source', () => {
    const wrapper = render(PrototypeChapterPage, '?prototype=1&chapter_id=origins');
    expect(wrapper.get('h1').text()).toBe('我的来处');
    expect(wrapper.findAll('.prototype-chapter-story h2').map(heading => heading.text())).toEqual(initialStories.filter(story => story.chapter_id === 'origins').map(story => story.title));
    expect(wrapper.get('.prototype-chapter-story h2').text()).toBe(hometownStory.title);
    expect(wrapper.get('.prototype-story-excerpt').text()).toContain('我小时候住的地方');
    expect(wrapper.get('.prototype-chapter-heading .prototype-row-meta').text()).toBe(`${initialStories.filter(story => story.chapter_id === 'origins').length} 篇故事`);
    for (const story of initialStories.filter(story => story.chapter_id !== 'origins')) expect(wrapper.text()).not.toContain(story.title);
    const link = new URL(wrapper.get('.prototype-chapter-story a').attributes('href'), location.href);
    expect(link.searchParams.get('chapter_id')).toBe('origins');
    expect(link.searchParams.get('story_id')).toBe('demo-hometown-lane');
    expect(link.searchParams.get('from')).toBe('chapter');
    expect(wrapper.get('.prototype-library-back').attributes('href')).toBe('./biography.html?prototype=1');
    expect(wrapper.find('[data-testid="prototype-nav"]').exists()).toBe(false);
  });

  it.each([
    '',
    '&chapter_id=',
    '&chapter_id=missing-chapter',
    '&chapter_id=origins&chapter_id=origins',
    '&chapter_id=origins&chapter_id=childhood',
  ])('keeps stories hidden for an invalid chapter query %s', query => {
    const wrapper = render(PrototypeChapterPage, '?prototype=1' + query);
    expect(wrapper.get('h1').text()).toBe('暂时找不到这一章');
    expect(wrapper.find('.prototype-chapter-story').exists()).toBe(false);
    for (const title of initialTitles) expect(wrapper.text()).not.toContain(title);
    expect(wrapper.findAll('a').every(link => link.attributes('href') === './biography.html?prototype=1')).toBe(true);
  });

  it('returns an empty valid chapter to that chapter on the map', () => {
    const state = getPrototypeState();
    state.stories = state.stories.filter(story => story.chapter_id !== 'adolescence');
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
    const wrapper = render(PrototypeChapterPage, '?prototype=1&chapter_id=adolescence');
    expect(wrapper.get('h1').text()).toBe('少年与成长');
    expect(wrapper.text()).toContain('这一章还没有故事');
    expect(wrapper.text()).not.toContain('演示故事');
    expect(wrapper.find('.prototype-chapter-story').exists()).toBe(false);
    expect(wrapper.get('.prototype-library-button').attributes('href')).toBe('./index.html?prototype=1&chapter_id=adolescence');
  });
});

describe('prototype profile and family', () => {
  it('shows a neutral space label and safe history, family, and login destinations', () => {
    sessionStorage.setItem('manji.auth_token', 'formal-account-sentinel');
    const wrapper = render(PrototypeProfilePage);
    expect(wrapper.get('.prototype-demo-identity h2').text()).toBe('我的空间');
    expect(wrapper.findAll('.prototype-profile-menu a').map(link => [link.text().replace('›', '').trim(), link.attributes('href')])).toEqual([
      ['讲述记录', './history.html?prototype=1'],
    ]);
    expect(wrapper.get('.prototype-profile-footer a').attributes('href')).toBe('./login.html');
    const navigation = wrapper.get('[data-testid="prototype-nav"]');
    expect(navigation.get('[aria-current="page"]').text()).toBe('我的');
    expect(navigation.get('a[href="./preview.html?prototype=1&kind=family"]').text()).toBe('家人');
    expect(sessionStorage.getItem('manji.auth_token')).toBe('formal-account-sentinel');
  });

  it('does not reset on cancel and restores focus to the reset control', async () => {
    saveChangedDemo();
    const before = snapshot(sessionStorage), beforeLocal = snapshot(localStorage);
    const wrapper = render(PrototypeProfilePage);
    resetButton(wrapper).element.focus();
    await resetButton(wrapper).trigger('click');
    expect(wrapper.get('dialog').element.open).toBe(true);
    expect(snapshot(sessionStorage)).toEqual(before);
    await wrapper.get('.prototype-reset-cancel').trigger('click');
    expect(wrapper.get('dialog').element.open).toBe(false);
    expect(document.activeElement).toBe(resetButton(wrapper).element);
    expect(snapshot(sessionStorage)).toEqual(before);
    expect(snapshot(localStorage)).toEqual(beforeLocal);
    expect(wrapper.get('[role="status"]').text()).toBe('');
  });

  it('only resets demo stories and sessions after confirmation, preserving all other storage', async () => {
    saveChangedDemo();
    const beforeOfficial = officialSessionSnapshot(), beforeLocal = snapshot(localStorage);
    const wrapper = render(PrototypeProfilePage);
    await resetButton(wrapper).trigger('click');
    expect(getPrototypeState().stories).toHaveLength(initialStories.length + 1);
    expect(getPrototypeState().sessions).toHaveLength(1);
    await confirmButton(wrapper).trigger('click');
    expect(getPrototypeState().stories.map(story => story.title)).toEqual(currentSampleStories.map(story => story.title));
    expect(getPrototypeState().sessions).toEqual(lifeMapDemoSessions);
    expect(officialSessionSnapshot()).toEqual(beforeOfficial);
    expect(snapshot(localStorage)).toEqual(beforeLocal);
    expect(wrapper.get('dialog').element.open).toBe(false);
    expect(document.activeElement).toBe(resetButton(wrapper).element);
    expect(wrapper.get('[role="status"]').text()).toBe('内容已重置。');
  });

  it('keeps the confirmation open and the current data intact if demo storage cannot be written', async () => {
    saveChangedDemo();
    const before = snapshot(sessionStorage), beforeLocal = snapshot(localStorage);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === sessionStorage && key === PROTOTYPE_STORAGE_KEY) throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return setItem.call(this, key, value);
    });
    const wrapper = render(PrototypeProfilePage);
    await resetButton(wrapper).trigger('click');
    await confirmButton(wrapper).trigger('click');
    expect(wrapper.get('dialog').element.open).toBe(true);
    expect(wrapper.get('dialog [role="alert"]').text()).toContain('无法保存进度');
    expect(wrapper.get('[role="status"]').text()).toBe('');
    expect(snapshot(sessionStorage)).toEqual(before);
    expect(snapshot(localStorage)).toEqual(beforeLocal);
  });

  it('opens family from the main navigation and shows its availability message', () => {
    const wrapper = render(PrototypeFamilyPage);
    expect(wrapper.get('[data-testid="prototype-family-page"] h1').text()).toBe('家人');
    expect(wrapper.text()).toContain('家人功能后续开放');
    expect(wrapper.text()).not.toContain('返回我的');
    expect(wrapper.get('[data-testid="prototype-nav"] [aria-current="page"]').text()).toBe('家人');
    expect(wrapper.find('button, input, form').exists()).toBe(false);
    expect(document.title).toBe('慢记 · 家人');
  });
});
