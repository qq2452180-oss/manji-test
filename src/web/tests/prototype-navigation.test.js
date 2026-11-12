import { useLegacyPrototypeSnapshot } from './prototype-fixtures.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PrototypeHomePage from '../src/pages/PrototypeHomePage.vue';
import PrototypeInterviewPage from '../src/pages/PrototypeInterviewPage.vue';
import PrototypeStoryPage from '../src/pages/PrototypeStoryPage.vue';
import { lifeMapChapters } from '../src/lib/life-map-topics.js';
import demoStories from '../src/content/prototype-stories.json';
import { prototypeHomeUrl, prototypeInterviewUrl, prototypeStoryUrl, resolvePrototypeTopic } from '../src/lib/prototype-topic.js';
import { getPrototypeStories } from '../src/lib/prototype-stories.js';
import { getPrototypeState, PROTOTYPE_STORAGE_KEY, startPrototypeSession, advancePrototypeSession, organizePrototypeSession, completePrototypeOrganization } from '../src/lib/prototype-state.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

beforeEach(() => { useLegacyPrototypeSnapshot(); });

describe('prototype topic navigation', () => {
  it('opens the chosen later chapter and fragment directly and restores the chapter on return', async () => {
    const chapter = lifeMapChapters[6], content = chapter.core_contents[3];
    history.replaceState(null, '', '/web2/index.html?prototype=1');
    const home = mount(PrototypeHomePage);
    await home.get(`[data-testid="chapter-${chapter.id}"]`).trigger('click');
    await home.get(`[data-testid="topic-${content.id}"]`).trigger('click');
    const target = new URL(navigate.mock.calls[0][0], location.href);
    expect(target.pathname).toBe('/web2/interview.html');
    expect(target.searchParams.get('prototype')).toBe('1');
    expect(target.searchParams.get('chapter_id')).toBe(chapter.id);
    expect(target.searchParams.get('content_id')).toBe(content.id);
    expect(location.search).toContain('chapter_id=' + chapter.id);
    expect(home.find('dialog').exists()).toBe(false);
    home.unmount();

    history.replaceState(null, '', target.pathname + target.search);
    const interview = mount(PrototypeInterviewPage);
    expect(interview.get('[data-testid="selected-chapter"]').text()).toBe(chapter.title);
    expect(interview.get('[data-testid="selected-fragment"]').text()).toBe(content.title);
    expect(interview.text()).toContain(content.description);
    const back = interview.findAll('a').find(link => link.attributes('href') === prototypeHomeUrl(chapter.id));
    expect(back).toBeDefined();
    expect(back.text()).toContain('返回人生轨迹');
    history.replaceState(null, '', back.attributes('href'));
    interview.unmount();
    const returned = mount(PrototypeHomePage);
    await flushPromises();
    expect(returned.get(`[data-testid="chapter-${chapter.id}"]`).attributes('aria-selected')).toBe('true');
    expect(returned.find(`[data-testid="topic-${content.id}"]`).exists()).toBe(true);
  });

  it('derives the same topic from a reload URL and ignores supplied title text', () => {
    const target = prototypeInterviewUrl('origins', 'hometown');
    const resolved = resolvePrototypeTopic(new URL(target, location.href).search + '&title=wrong&description=wrong');
    expect(resolved.kind).toBe('topic');
    expect(resolved.chapter.title).toBe('我的来处');
    expect(resolved.content.title).toBe('家乡与居住环境');
  });

  it.each([
    '?chapter_id=origins', '?content_id=hometown', '?chapter_id=&content_id=',
    '?chapter_id=unknown&content_id=hometown', '?chapter_id=origins&content_id=unknown',
    '?chapter_id=childhood&content_id=hometown',
    '?chapter_id=origins&chapter_id=childhood&content_id=hometown',
    '?chapter_id=origins&content_id=hometown&content_id=neighborhood',
  ])('rejects incomplete or mismatched topic context: %s', search => {
    expect(resolvePrototypeTopic(search).kind).toBe('invalid');
    history.replaceState(null, '', '/web2/interview.html' + search + '&prototype=1');
    const page = mount(PrototypeInterviewPage);
    expect(page.text()).toContain('这个片段暂时无法打开');
    expect(page.find('[data-testid="selected-fragment"]').exists()).toBe(false);
    expect(page.findAll('button').some(button => button.text() === '开始讲述')).toBe(false);
  });

  it('opens free talk from the primary Xiaonuan entry without carrying a previously chosen topic', () => {
    history.replaceState(null, '', '/web2/index.html?prototype=1&chapter_id=childhood');
    const home = mount(PrototypeHomePage);
    const entry = home.get('[data-testid="xiaonuan-entry"]');
    expect(entry.element.tagName).toBe('A');
    expect(entry.attributes('href')).toBe('./interview.html?prototype=1');
    expect(home.find('.free-talk-link').exists()).toBe(false);
    expect(home.get('h1').text()).toBe('人生轨迹');
    expect(document.title).toBe('慢记 · 人生轨迹');
    expect(home.find('header a[href="./profile.html?prototype=1"]').exists()).toBe(false);
    expect(home.get('[data-testid="prototype-nav"] [aria-current="page"]').text()).toBe('人生轨迹');
    const href = entry.attributes('href');
    home.unmount();
    history.replaceState(null, '', href);
    const interview = mount(PrototypeInterviewPage);
    expect(interview.find('[data-testid="selected-chapter"]').exists()).toBe(false);
    expect(interview.text()).toContain('随便聊聊');
    expect(resolvePrototypeTopic(location.search)).toEqual({ kind: 'free' });
  });

  it('does not generate a route for an invalid pair', () => {
    expect(prototypeInterviewUrl('childhood', 'hometown')).toBe('');
    expect(prototypeInterviewUrl('origins')).toBe('');
    expect(prototypeHomeUrl('unknown')).toBe('./index.html?prototype=1');
  });
});

describe('prototype stories already told', () => {
  it.each(['L1', 'X'])('marks only stories actually saved for the new %s topics', async chapterId => {
    const chapter = lifeMapChapters.find(item => item.id === chapterId);
    const content = chapter.core_contents[0];
    const state = getPrototypeState();
    state.stories.push({
      id: 'new-topic-story', chapter_id: chapterId, content_id: content.id,
      title: content.title, paragraphs: ['我记得那段生活。'],
      createdAt: '2026-11-04T08:00:00.000Z', updatedAt: '2026-11-04T08:00:00.000Z',
    });
    sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
    history.replaceState(null, '', prototypeHomeUrl(chapterId));
    const home = mount(PrototypeHomePage);
    expect(home.findAll('.chapter-topic-status')).toHaveLength(1);
    const topic = home.get(`[data-testid="topic-${content.id}"]`);
    expect(topic.get('.chapter-topic-status').text()).toBe('讲过');
    await topic.trigger('click');
    expect(navigate).toHaveBeenLastCalledWith(prototypeStoryUrl(chapterId, content.id));
    expect(getPrototypeState().stories.filter(story => demoStories.some(seed => seed.id === story.id))).toHaveLength(demoStories.length);
  });

  it('falls back from an old map selection without clearing stories or unfinished recordings', async () => {
    startPrototypeSession({ chapterId: 'origins', contentId: 'hometown' });
    const before = getPrototypeState();
    history.replaceState(null, '', prototypeHomeUrl('origins'));
    const home = mount(PrototypeHomePage);
    await flushPromises();
    expect(home.get('[data-testid="chapter-L1"]').attributes('aria-selected')).toBe('true');
    expect(home.find('[data-testid="chapter-origins"]').exists()).toBe(false);
    expect(home.findAll('.chapter-topic-status')).toHaveLength(0);
    expect(home.find('[data-testid="resume-last-session"]').exists()).toBe(false);
    expect(getPrototypeState().stories).toEqual(before.stories);
    expect(getPrototypeState().sessions).toEqual(before.sessions);
  });

  it('returns to the originating history detail after opening and leaving a supplement', async () => {
    vi.useFakeTimers();
    const session = startPrototypeSession({ chapterId: 'origins', contentId: 'early_household' });
    advancePrototypeSession(session.id); organizePrototypeSession(session.id);
    vi.advanceTimersByTime(2000);
    const completed = completePrototypeOrganization(session.id);
    history.replaceState(null, '', prototypeStoryUrl('origins', 'early_household', { storyId: completed.storyId, sessionId: session.id, from: 'history' }));
    const story = mount(PrototypeStoryPage);
    const supplement = story.get('[data-testid="continue-topic"]').attributes('href');
    expect(new URL(supplement, location.href).searchParams.has('session_id')).toBe(false);
    story.unmount(); history.replaceState(null, '', supplement);
    const interview = mount(PrototypeInterviewPage);
    await interview.get('[data-testid="start-interview"]').trigger('click');
    const backToStory = interview.get('.prototype-interview-back').attributes('href');
    expect(new URL(backToStory, location.href).searchParams.get('session_id')).toBe(session.id);
    interview.unmount(); history.replaceState(null, '', backToStory);
    const returned = mount(PrototypeStoryPage);
    const historyLink = returned.get('.prototype-story-back').attributes('href');
    expect(historyLink).toBe('./history.html?prototype=1&session_id=' + session.id);
    expect(returned.find('[data-testid^="demo-story-"]').exists()).toBe(true);
  });

  it.each(demoStories)('preserves the old story URL and supplement for $id', async story => {
    history.replaceState(null, '', prototypeStoryUrl(story.chapter_id, story.content_id));
    const page = mount(PrototypeStoryPage);
    expect(page.find('.prototype-story-label').exists()).toBe(false);
    expect(page.get(`[data-testid="demo-story-${story.id}"]`).text()).toContain(story.paragraphs[0]);
    const pictureFiles = {
      'origins/hometown': 'hometown.webp',
      'childhood/playmates_and_play': 'paper-boats.webp',
      'livelihood/main_work': 'shop.webp',
      'family_and_relationships/shared_daily_life': 'family-table.webp',
    };
    const pictureFile = pictureFiles[`${story.chapter_id}/${story.content_id}`];
    expect(page.findAll('figure.prototype-memory-image')).toHaveLength(pictureFile ? 1 : 0);
    if (pictureFile) {
      const figure = page.get(`[data-testid="demo-story-${story.id}"] figure.prototype-memory-image`);
      expect(figure.get('img').attributes('src')).toContain(pictureFile);
      expect(figure.get('img').attributes('alt').trim().length).toBeGreaterThan(0);
      expect(figure.get('img').attributes('loading')).toBe('lazy');
      expect(figure.get('figcaption').text()).toBe({
        'hometown.webp': '老巷里的傍晚', 'paper-boats.webp': '雨后的小纸船',
        'shop.webp': '小店的日常', 'family-table.webp': '一家人的饭桌',
      }[pictureFile]);
      expect(figure.element.previousElementSibling.textContent).toBe(story.paragraphs[1]);
    }
    expect(page.get('h1').text()).toBe(story.title);
    const follow = page.get('[data-testid="continue-topic"]');
    expect(follow.text()).toContain('继续补充');
    expect(follow.attributes('href')).toBe(prototypeInterviewUrl(story.chapter_id, story.content_id, { storyId: story.id, from: 'map', back: 'story' }));
    history.replaceState(null, '', follow.attributes('href'));
    const interview = mount(PrototypeInterviewPage);
    const resolved = resolvePrototypeTopic(location.search);
    expect(interview.get('[data-testid="selected-chapter"]').text()).toBe(resolved.chapter.title);
    expect(interview.get('[data-testid="selected-fragment"]').text()).toBe(resolved.content.title);
  });

  it('does not mark a new topic as told simply because its interview page was opened', async () => {
    const chapter = lifeMapChapters[0], content = chapter.core_contents[0];
    history.replaceState(null, '', prototypeHomeUrl(chapter.id));
    const home = mount(PrototypeHomePage);
    const untold = home.get(`[data-testid="topic-${content.id}"]`);
    expect(untold.find('.chapter-topic-status').exists()).toBe(false);
    await untold.trigger('click');
    expect(navigate).toHaveBeenCalledWith(prototypeInterviewUrl(chapter.id, content.id));
    history.replaceState(null, '', navigate.mock.calls[0][0]);
    mount(PrototypeInterviewPage);
    expect(getPrototypeStories(chapter.id, content.id)).toEqual([]);
    history.replaceState(null, '', prototypeHomeUrl(chapter.id));
    const returned = mount(PrototypeHomePage);
    expect(returned.get(`[data-testid="topic-${content.id}"]`).find('.chapter-topic-status').exists()).toBe(false);
  });

  it('offers starting a valid untold fragment when its story URL is opened directly', () => {
    history.replaceState(null, '', prototypeStoryUrl('childhood', 'childhood_occasions'));
    const page = mount(PrototypeStoryPage);
    expect(page.text()).toContain('这段故事还没开始');
    expect(page.find('[data-testid^="demo-story-"]').exists()).toBe(false);
    expect(page.get('[data-testid="start-topic"]').text()).toContain('开始讲述');
    expect(page.get('[data-testid="start-topic"]').attributes('href')).toBe(prototypeInterviewUrl('childhood', 'childhood_occasions'));
  });

  it.each([
    '?prototype=1', '?prototype=1&chapter_id=origins',
    '?prototype=1&chapter_id=childhood&content_id=hometown',
    '?prototype=1&chapter_id=origins&content_id=hometown&content_id=neighborhood',
  ])('never leaks an unrelated demo story for invalid context: %s', search => {
    history.replaceState(null, '', '/web2/story.html' + search);
    const page = mount(PrototypeStoryPage);
    expect(page.text()).toContain('暂时找不到这段故事');
    expect(page.find('[data-testid^="demo-story-"]').exists()).toBe(false);
    expect(page.find('[data-testid="continue-topic"]').exists()).toBe(false);
    expect(getPrototypeStories('childhood', 'hometown')).toEqual([]);
  });
});
