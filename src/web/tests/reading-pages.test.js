import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ReadingPage from '../src/pages/ReadingPage.vue';
import BookCover from '../src/components/BookCover.vue';
import * as api from '../src/lib/api.js';
import { setBiographyId } from '../src/lib/app-state.js';
import { navigate, reloadPage } from '../src/lib/navigation.js';

vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(), getCurrentUser: vi.fn(), bootstrapBiography: vi.fn(), getBiography: vi.fn(), getChapter: vi.fn(), getStory: vi.fn() }));
vi.mock('../src/lib/app-state.js', () => ({ setBiographyId: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

const photo = { props: ['mediaId', 'index'], template: '<button class="material-photo" :data-media-id="mediaId">照片 {{ index + 1 }}</button>' };
const render = kind => mount(ReadingPage, { props: { kind }, global: { stubs: { PrivatePhoto: photo } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function visibility(hidden) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
  await nextTick();
}
const story = (id = 'story-1', text = '原来的正文') => ({ story_id: id, current_version: { title: '第一篇', body: text, photos: [] } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  api.getAuthToken.mockReturnValue('test-token');
  api.getCurrentUser.mockResolvedValue({ user_id: 'test-user' });
  api.bootstrapBiography.mockResolvedValue({ biography_id: 'book-1' });
});

describe('Vue reading pages', () => {
  it('keeps the guest book as an explicit preview without formal home or navigation entries', async () => {
    api.getCurrentUser.mockResolvedValue({ id: 'guest-1', is_guest: true });
    api.getBiography.mockResolvedValue({ biography_id: 'book-1', title: '我的故事', chapters: [] });
    const wrapper = render('biography'); await flushPromises();
    expect(wrapper.get('.trial-preview-note').text()).toContain('登录或注册');
    expect(wrapper.get('.paper-title').text()).toBe('本次体验的故事');
    expect(wrapper.find('nav').exists()).toBe(false);
    expect(wrapper.find('a[href="./index.html"]').exists()).toBe(false);
    expect(wrapper.find('a[href*="interview.html"]').exists()).toBe(false);
    expect(wrapper.get('.header-back').attributes('href')).toBe('./login.html?trial=1');
  });

  it('withholds member navigation until identity is verified and clears it on hide', async () => {
    const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
    api.getBiography.mockResolvedValue({ biography_id: 'book-1', chapters: [] });
    const wrapper = render('biography'); await flushPromises();
    expect(wrapper.find('nav').exists()).toBe(false);
    pending.resolve({ id: 'member-1', is_guest: false }); await flushPromises();
    expect(wrapper.find('nav').exists()).toBe(true);
    await visibility(true); expect(wrapper.find('nav').exists()).toBe(false);
  });

  it('does not restore member navigation when verification finishes after hiding', async () => {
    const pending = deferred(); api.getCurrentUser.mockReturnValue(pending.promise);
    const wrapper = render('biography'); await flushPromises(); await visibility(true);
    pending.resolve({ id: 'member-1', is_guest: false }); await flushPromises();
    expect(wrapper.find('nav').exists()).toBe(false);
    expect(api.getBiography).not.toHaveBeenCalled();
  });

  it('shows the real first story before inviting a guest to continue using Manji', async () => {
    history.replaceState(null, '', '/web2/story.html?id=story-1');
    api.getCurrentUser.mockResolvedValue({ id: 'guest-1', is_guest: true });
    api.getStory.mockResolvedValue(story('story-1', '小时候，院子里有一棵桂花树。'));
    const wrapper = render('story');
    await flushPromises();
    expect(wrapper.get('.story-body').text()).toContain('桂花树');
    expect(wrapper.get('.trial-result').text()).toContain('这是您的第一篇故事');
    expect(wrapper.get('.trial-result a').attributes('href')).toBe('./login.html?trial=1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not display a trial completion prompt for an existing account', async () => {
    history.replaceState(null, '', '/web2/story.html?id=story-1');
    api.getStory.mockResolvedValue(story());
    const wrapper = render('story');
    await flushPromises();
    expect(wrapper.find('.trial-result').exists()).toBe(false);
  });
  it('keeps guest reading public and preserves the exact return URL when logging in', async () => {
    history.replaceState(null, '', '/web2/story.html?story_id=story-1');
    api.getAuthToken.mockReturnValue(null);
    const wrapper = render('story');
    await flushPromises();
    expect(wrapper.text()).toContain('登录后，继续读你的故事');
    expect(wrapper.get('.paper-state a').attributes('href')).toBe('./login.html?next=%2Fweb2%2Fstory.html%3Fstory_id%3Dstory-1');
    expect(api.getCurrentUser).not.toHaveBeenCalled();
    expect(api.getStory).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders the returned chapter order and totals without treating user text as markup', async () => {
    api.getBiography.mockResolvedValue({ biography_id: 'book-1', title: '我的人生', updated_at: '2026-10-08T12:00:00', chapters: [
      { chapter_id: 'chapter/2', title: '<b>后来</b>', story_count: 2, start_year: 2000, end_year: 2010, summary: '第二段经历' },
      { chapter_id: 'chapter-1', title: '童年', story_count: 1, start_year: 1980 },
    ] });
    const wrapper = render('biography');
    await flushPromises();
    expect(api.getBiography).toHaveBeenCalledWith('book-1');
    expect(setBiographyId).toHaveBeenCalledWith('book-1');
    expect(wrapper.get('.book-stats').text()).toContain('2 章 · 3 篇故事');
    expect(wrapper.findAll('.chapter-title').map(node => node.text())).toEqual(['<b>后来</b>', '童年']);
    expect(wrapper.findAll('.chapter-title b')).toHaveLength(0);
    expect(wrapper.get('.chapter-row').attributes('href')).toBe('./chapter.html?id=chapter%2F2');
    expect(wrapper.get('.chapter-row').text()).toContain('2000—2010年');
  });

  it('opens only three stories initially, then reveals more while preserving paragraphs and current photo order', async () => {
    history.replaceState(null, '', '/web2/chapter.html?chapter_id=chapter-1');
    const first = story('story-1', '第一段\n\n第二段\n第三段');
    first.current_version.photos = [{ media_id: 'later', position: 2 }, { media_id: 'first', position: 1 }];
    api.getChapter.mockResolvedValue({ chapter: { chapter_id: 'chapter-1', title: '童年', summary: '小时候' }, stories: [first,
      ...[2, 3, 4, 5].map(number => story(`story-${number}`, `第${number}篇正文`)), { story_id: 'not-written' }] });
    const wrapper = render('chapter');
    await flushPromises();
    expect(api.getChapter).toHaveBeenCalledWith('chapter-1');
    expect(wrapper.findAll('.chapter-story')).toHaveLength(3);
    expect(wrapper.get('.material-photo').attributes('data-media-id')).toBe('first');
    expect(wrapper.findAll('.chapter-story')[0].findAll('.paper-paragraph').map(node => node.text())).toEqual(['第一段', '第二段', '第三段']);
    expect(wrapper.get('.story-link').text()).toContain('查看 2 张照片');
    await wrapper.get('.continue-reading').trigger('click');
    expect(wrapper.findAll('.chapter-story')).toHaveLength(5);
    expect(wrapper.find('.continue-reading').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('not-written');
  });

  it('reads only the current story version and lets the reader page through photos in saved order', async () => {
    history.replaceState(null, '', '/web2/story.html?id=story-1');
    api.getStory.mockResolvedValue({ ...story('story-1', '当前正文'), body: '旧版正文', photos: [{ media_id: 'old-photo' }],
      current_version: { title: '现在的版本', body: '当前正文', photos: [{ media_id: 'second', position: 20 }, { media_id: 'first', position: 10 }] } });
    const wrapper = render('story');
    await flushPromises();
    expect(wrapper.text()).toContain('当前正文');
    expect(wrapper.text()).not.toContain('旧版正文');
    expect(wrapper.get('.material-photo').attributes('data-media-id')).toBe('first');
    let steps = wrapper.findAll('.story-photo-step');
    expect(steps[0].attributes('disabled')).toBeDefined();
    expect(steps[1].attributes('disabled')).toBeUndefined();
    await steps[1].trigger('click');
    expect(wrapper.get('.material-photo').attributes('data-media-id')).toBe('second');
    expect(wrapper.get('.story-photo-count').text()).toBe('2 / 2');
    steps = wrapper.findAll('.story-photo-step');
    expect(steps[1].attributes('disabled')).toBeDefined();
    await steps[0].trigger('click');
    expect(wrapper.get('.material-photo').attributes('data-media-id')).toBe('first');
  });

  it('discards hidden-page responses, reloads on return and clears private text on account change', async () => {
    history.replaceState(null, '', '/web2/story.html?id=story-1');
    const pending = deferred();
    api.getStory.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(story('story-1', '返回后重新读取的正文'));
    const wrapper = render('story');
    await flushPromises();
    await visibility(true);
    pending.resolve(story('story-1', '不应出现的旧响应'));
    await flushPromises();
    expect(wrapper.text()).not.toContain('不应出现的旧响应');
    await visibility(false);
    await flushPromises();
    expect(wrapper.text()).toContain('返回后重新读取的正文');
    expect(api.getStory).toHaveBeenCalledTimes(2);
    api.getAuthToken.mockReturnValue('another-account');
    window.dispatchEvent(new Event('manji:auth-changed'));
    await nextTick();
    expect(wrapper.text()).not.toContain('返回后重新读取的正文');
    expect(navigate).toHaveBeenCalledWith('./login.html?next=%2Fweb2%2Fstory.html%3Fid%3Dstory-1', { replace: true });
    await visibility(false);
    await flushPromises();
    expect(api.getStory).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched story and offers a working retry', async () => {
    history.replaceState(null, '', '/web2/story.html?id=story-1');
    api.getStory.mockResolvedValueOnce(story('another-story', '别人的故事')).mockResolvedValueOnce(story());
    const wrapper = render('story');
    await flushPromises();
    expect(wrapper.text()).toContain('故事信息不完整');
    expect(wrapper.text()).not.toContain('别人的故事');
    await wrapper.get('.paper-state button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('原来的正文');
  });

  it('does not reload on an ordinary pageshow and uses document reload for a restored page', async () => {
    history.replaceState(null, '', '/web2/story.html?id=story-1');
    api.getStory.mockResolvedValue(story());
    render('story');
    await flushPromises();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    await flushPromises();
    expect(api.getStory).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it('keeps the full long book title accessible while fitting visible cover copy', () => {
    const title = '这是一本记录我从童年走向成年再到退休以后所有珍贵经历与故乡往事的传记';
    const wrapper = mount(BookCover, { props: { title } });
    expect(wrapper.classes()).toContain('has-long-copy');
    expect(wrapper.attributes('aria-label')).toContain(title);
    expect(Array.from(wrapper.get('.cover-title').text())).toHaveLength(32);
    expect(wrapper.get('.cover-title').text()).toMatch(/…$/);
    expect(wrapper.find('.cover-rings').exists()).toBe(false);
  });
});
