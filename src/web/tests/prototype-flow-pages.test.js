import { useLegacyPrototypeSnapshot } from './prototype-fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PrototypeInterviewPage from '../src/pages/PrototypeInterviewPage.vue';
import PrototypeOrganizingPage from '../src/pages/PrototypeOrganizingPage.vue';
import PrototypeHistoryPage from '../src/pages/PrototypeHistoryPage.vue';
import { getPrototypeState, getPrototypeSession, startPrototypeSession, pausePrototypeSession, advancePrototypeSession, organizePrototypeSession, completePrototypeOrganization } from '../src/lib/prototype-state.js';
import { prototypeInterviewUrl, prototypeOrganizingUrl, prototypeHistoryUrl, prototypeStoryUrl, prototypeHomeUrl, prototypeChapterUrl, prototypeBiographyUrl } from '../src/lib/prototype-topic.js';
import { getPrototypeScenario } from '../src/lib/prototype-scenarios.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

const pair = { chapterId: 'childhood', contentId: 'childhood_occasions' };
const network = vi.fn(), microphone = vi.fn(), audio = vi.fn(), recorder = vi.fn();
let hidden, originalMediaDevices;
function open(url) { history.replaceState(null, '', url); }
function interviewUrl(id, options = {}) { return prototypeInterviewUrl(pair.chapterId, pair.contentId, { sessionId: id, ...options }); }
async function elapse(ms) { await vi.advanceTimersByTimeAsync(ms); await nextTick(); }
async function visibility(value) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); await nextTick(); }
function createOrganizing(options = pair) {
  const session = startPrototypeSession(options);
  advancePrototypeSession(session.id);
  organizePrototypeSession(session.id);
  return getPrototypeSession(session.id);
}
function activePage(url = interviewUrl()) { open(url); return mount(PrototypeInterviewPage); }

beforeEach(() => {
  useLegacyPrototypeSnapshot();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T08:00:00.000Z'));
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('Audio', audio);
  vi.stubGlobal('MediaRecorder', recorder);
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else delete navigator.mediaDevices;
});

describe('prototype interview playback', () => {
  it('stops locally and exposes a recoverable error when saving fails during playback', async () => {
    const page = activePage();
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = getPrototypeState().sessions[0].id;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await elapse(1800);
    expect(page.get('[role="alert"]').text()).toContain('无法保存进度');
    expect(page.get('[data-testid="start-interview"]').text()).toBe('继续讲述');
    expect(page.text()).toContain('已暂停');
    await elapse(6000);
    expect(getPrototypeSession(id).turnIndex).toBe(1);
    write.mockRestore();
    await page.get('[data-testid="start-interview"]').trigger('click');
    await elapse(1800);
    expect(getPrototypeSession(id).turnIndex).toBe(2);
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('does not create a session by opening the page and keeps real services and media untouched', async () => {
    sessionStorage.setItem('real-account-sentinel', 'existing-account');
    const page = activePage();
    expect(getPrototypeState().sessions).toHaveLength(0);
    expect(page.get('.prototype-interview-label').text()).toBe('讲述');
    expect(page.get('[data-testid="start-interview"]').text()).toBe('开始讲述');
    await page.get('[data-testid="start-interview"]').trigger('click');
    await elapse(5400);
    expect(getPrototypeState().sessions[0].turnIndex).toBe(4);
    expect(network).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(audio).not.toHaveBeenCalled();
    expect(recorder).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('real-account-sentinel')).toBe('existing-account');
    expect(page.find('input[type="file"], textarea, audio').exists()).toBe(false);
  });

  it('keeps one recording on rapid repeated start, writes its URL, and advances at 1800 ms boundaries', async () => {
    const page = activePage(interviewUrl(undefined, { from: 'chapter' }));
    const button = page.get('[data-testid="start-interview"]').element;
    button.click(); button.click();
    await nextTick();
    const [session] = getPrototypeState().sessions;
    const script = getPrototypeScenario(pair.chapterId, pair.contentId);
    expect(getPrototypeState().sessions).toHaveLength(1);
    expect(session.turnIndex).toBe(1);
    expect(new URLSearchParams(location.search).get('session_id')).toBe(session.id);
    expect(new URLSearchParams(location.search).get('from')).toBe('chapter');
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(script.turns[0].text);
    expect(page.get('[data-testid="finish-interview"]').element.disabled).toBe(true);
    await elapse(1799);
    expect(getPrototypeSession(session.id).turnIndex).toBe(1);
    await elapse(1);
    expect(getPrototypeSession(session.id).turnIndex).toBe(2);
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(script.turns[1].text);
    expect(page.get('[data-testid="finish-interview"]').element.disabled).toBe(false);
    await elapse(3600);
    expect(getPrototypeSession(session.id).turnIndex).toBe(4);
    await elapse(20000);
    expect(getPrototypeSession(session.id).turnIndex).toBe(4);
    expect(getPrototypeSession(session.id).status).toBe('running');
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(script.turns[3].text);
  });

  it('pauses without progressing and resumes the same session after a refresh', async () => {
    let page = activePage();
    await page.get('[data-testid="start-interview"]').trigger('click');
    await elapse(1800);
    const id = getPrototypeState().sessions[0].id;
    await page.get('[data-testid="pause-interview"]').trigger('click');
    const caption = page.get('[data-testid="prototype-caption"]').text();
    await elapse(10000);
    expect(getPrototypeSession(id).turnIndex).toBe(2);
    page.unmount();
    page = mount(PrototypeInterviewPage);
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(caption);
    expect(page.get('[data-testid="start-interview"]').text()).toBe('继续讲述');
    await elapse(5000);
    expect(getPrototypeSession(id).turnIndex).toBe(2);
    await page.get('[data-testid="start-interview"]').trigger('click');
    await elapse(1800);
    expect(getPrototypeSession(id).turnIndex).toBe(3);
    expect(getPrototypeState().sessions).toHaveLength(1);
  });

  it('pauses a running record immediately when it is opened again', async () => {
    const current = startPrototypeSession(pair);
    advancePrototypeSession(current.id);
    const page = activePage(interviewUrl(current.id));
    expect(getPrototypeSession(current.id).status).toBe('paused');
    await elapse(7200);
    expect(getPrototypeSession(current.id).turnIndex).toBe(2);
    expect(page.text()).toContain('已暂停');
  });

  it.each(['visibility', 'pagehide', 'unmount'])('clears playback and pauses on %s without automatically resuming', async reason => {
    const page = activePage();
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = getPrototypeState().sessions[0].id;
    if (reason === 'visibility') await visibility(true);
    else if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    else page.unmount();
    expect(getPrototypeSession(id).status).toBe('paused');
    await elapse(6000);
    expect(getPrototypeSession(id).turnIndex).toBe(1);
    if (reason !== 'unmount') {
      await visibility(false);
      window.dispatchEvent(new Event('pageshow'));
      await elapse(5000);
      expect(getPrototypeSession(id).status).toBe('paused');
      expect(getPrototypeSession(id).turnIndex).toBe(1);
    }
  });

  it('ends only after a second turn and navigates to the matching organizing record', async () => {
    const page = activePage(interviewUrl(undefined, { from: 'biography' }));
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = getPrototypeState().sessions[0].id;
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(navigate).not.toHaveBeenCalled();
    expect(getPrototypeSession(id).status).toBe('running');
    await elapse(1800);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(getPrototypeSession(id).status).toBe('organizing');
    expect(navigate).toHaveBeenCalledWith(prototypeOrganizingUrl(id, { from: 'biography' }));
    await elapse(5000);
    expect(getPrototypeSession(id).turnIndex).toBe(2);
  });

  it.each(['organizing', 'complete'])('opens an existing %s take as a result link without starting another take', async status => {
    const current = createOrganizing();
    if (status === 'complete') { await elapse(2000); completePrototypeOrganization(current.id); }
    const page = activePage(interviewUrl(current.id));
    expect(page.find('[data-testid="start-interview"]').exists()).toBe(false);
    expect(page.get('[data-testid="interview-result"]').text()).toBe(status === 'complete' ? '查看故事' : '查看整理进度');
    await elapse(6000);
    expect(getPrototypeState().sessions).toHaveLength(1);
    expect(getPrototypeSession(current.id).status).toBe(status);
  });

  it.each(['session_id=missing', 'session_id=', 'session_id=a&session_id=b'])('rejects an invalid session without starting a recording: %s', query => {
    const page = activePage(interviewUrl() + '&' + query);
    expect(page.text()).toContain('这个片段暂时无法打开');
    expect(page.find('button').exists()).toBe(false);
    expect(getPrototypeState().sessions).toHaveLength(0);
  });
});

describe('prototype organization timing', () => {
  it('finishes after the remaining two-second window and remains idempotent on refresh', async () => {
    const current = createOrganizing();
    const before = getPrototypeState().stories.length;
    await elapse(700);
    open(prototypeOrganizingUrl(current.id, { from: 'chapter' }));
    let page = mount(PrototypeOrganizingPage);
    expect(page.text()).toContain('正在整理这段讲述');
    expect(page.get('.prototype-organizing-header a').attributes('href')).toBe(prototypeChapterUrl(pair.chapterId));
    await elapse(500);
    page.unmount();
    page = mount(PrototypeOrganizingPage);
    await elapse(799);
    expect(getPrototypeSession(current.id).status).toBe('organizing');
    await elapse(1);
    expect(getPrototypeSession(current.id).status).toBe('complete');
    expect(getPrototypeState().stories).toHaveLength(before + 1);
    const completed = getPrototypeSession(current.id);
    const paragraphs = [...getPrototypeState().stories.find(story => story.id === completed.storyId).paragraphs];
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toBe(prototypeStoryUrl(pair.chapterId, pair.contentId, { storyId: completed.storyId, sessionId: completed.id, from: 'chapter' }));
    page.unmount();
    page = mount(PrototypeOrganizingPage);
    window.dispatchEvent(new Event('pageshow'));
    await elapse(8000);
    expect(page.text()).toContain('这段讲述已经整理好了');
    expect(getPrototypeState().stories.find(story => story.id === completed.storyId).paragraphs).toEqual(paragraphs);
    expect(getPrototypeState().stories).toHaveLength(before + 1);
  });

  it('does not finish while hidden and safely completes an overdue job when returning', async () => {
    const current = createOrganizing();
    open(prototypeOrganizingUrl(current.id));
    const page = mount(PrototypeOrganizingPage);
    await elapse(500);
    await visibility(true);
    await elapse(5000);
    expect(getPrototypeSession(current.id).status).toBe('organizing');
    await visibility(false);
    await elapse(20);
    expect(getPrototypeSession(current.id).status).toBe('complete');
    expect(page.find('[data-testid="view-organized-story"]').exists()).toBe(true);
  });

  it('completes an existing story supplement once despite revisiting the organizing page', async () => {
    const original = getPrototypeState().stories[0];
    const current = createOrganizing({ chapterId: original.chapter_id, contentId: original.content_id, storyId: original.id });
    open(prototypeOrganizingUrl(current.id));
    let page = mount(PrototypeOrganizingPage);
    await elapse(2000);
    expect(getPrototypeState().stories.find(story => story.id === original.id).paragraphs).toHaveLength(original.paragraphs.length + 1);
    page.unmount(); page = mount(PrototypeOrganizingPage);
    await elapse(10000);
    expect(getPrototypeState().stories.find(story => story.id === original.id).paragraphs).toHaveLength(original.paragraphs.length + 1);
    expect(page.get('[data-testid="view-organized-story"]').attributes('href')).toContain('story_id=' + original.id);
  });

  it.each(['', '&session_id=missing', '&session_id=', '&session_id=a&session_id=b'])('keeps invalid organizing context safe: %s', query => {
    open('/web2/organizing.html?prototype=1' + query);
    const page = mount(PrototypeOrganizingPage);
    expect(page.text()).toContain('暂时找不到这段讲述');
    expect(page.find('[data-testid="view-organized-story"]').exists()).toBe(false);
    expect(page.findAll('a').every(link => link.attributes('href') === prototypeHomeUrl())).toBe(true);
    expect(getPrototypeState().sessions).toHaveLength(0);
  });

  it.each([
    ['biography', () => prototypeBiographyUrl()],
    ['history', id => prototypeHistoryUrl(id)],
    ['map', () => prototypeHomeUrl(pair.chapterId)],
  ])('returns to its %s source', (from, expected) => {
    const current = createOrganizing();
    open(prototypeOrganizingUrl(current.id, { from }));
    const page = mount(PrototypeOrganizingPage);
    expect(page.get('.prototype-organizing-header a').attributes('href')).toBe(expected(current.id));
  });
});

describe('prototype saved recording history', () => {
  it('lists records by updated time and returns to the prototype profile', async () => {
    const first = startPrototypeSession(pair);
    pausePrototypeSession(first.id);
    await elapse(1000);
    const second = startPrototypeSession({ chapterId: 'origins', contentId: 'family_livelihood' });
    pausePrototypeSession(second.id);
    open(prototypeHistoryUrl());
    const page = mount(PrototypeHistoryPage);
    const links = page.findAll('.prototype-history-row');
    expect(links.map(link => link.attributes('href'))).toEqual([prototypeHistoryUrl(second.id), prototypeHistoryUrl(first.id)]);
    expect(page.get('.prototype-history-header a').attributes('href')).toBe('./profile.html?prototype=1');
  });

  it.each(['running', 'paused', 'organizing', 'complete'])('shows saved turns and the proper next action for %s', async status => {
    const current = startPrototypeSession(pair);
    advancePrototypeSession(current.id);
    if (status === 'paused') pausePrototypeSession(current.id);
    if (['organizing', 'complete'].includes(status)) organizePrototypeSession(current.id);
    if (status === 'complete') { await elapse(2000); completePrototypeOrganization(current.id); }
    open(prototypeHistoryUrl(current.id));
    const page = mount(PrototypeHistoryPage);
    const saved = getPrototypeSession(current.id);
    expect(page.findAll('.prototype-history-turn p').map(node => node.text())).toEqual(getPrototypeScenario(pair.chapterId, pair.contentId).turns.slice(0, 2).map(turn => turn.text));
    const link = page.get('[data-testid="history-continue"]');
    if (status === 'organizing') expect(link.attributes('href')).toBe(prototypeOrganizingUrl(current.id, { from: 'history' }));
    else if (status === 'complete') expect(link.attributes('href')).toBe(prototypeStoryUrl(pair.chapterId, pair.contentId, { sessionId: current.id, storyId: saved.storyId, from: 'history' }));
    else expect(link.attributes('href')).toBe(prototypeInterviewUrl(pair.chapterId, pair.contentId, { sessionId: current.id, from: 'history' }));
    expect(page.get('.prototype-history-header a').attributes('href')).toBe(prototypeHistoryUrl());
    expect(page.get('.prototype-history-header a').text()).toContain('返回讲述记录');
  });

  it('refreshes the history list from saved state on pageshow', async () => {
    open(prototypeHistoryUrl());
    const page = mount(PrototypeHistoryPage);
    expect(page.text()).toContain('还没有讲述记录');
    const current = startPrototypeSession(pair);
    pausePrototypeSession(current.id);
    window.dispatchEvent(new Event('pageshow'));
    await nextTick();
    expect(page.findAll('.prototype-history-row')).toHaveLength(1);
  });

  it('shows an error instead of another recording for an unknown history id', () => {
    startPrototypeSession(pair);
    open(prototypeHistoryUrl('missing'));
    const page = mount(PrototypeHistoryPage);
    expect(page.text()).toContain('暂时找不到这段讲述');
    expect(page.find('[data-testid="history-continue"]').exists()).toBe(false);
    expect(page.find('.prototype-history-turn').exists()).toBe(false);
  });
});

describe('prototype free talk continuity', () => {
  it('keeps free talk when resuming from history or organizing and attaches its result to the fixed childhood topic', async () => {
    let page = activePage(prototypeInterviewUrl());
    expect(page.get('h1').text()).toBe('随便聊聊');
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = getPrototypeState().sessions[0].id;
    expect(new URLSearchParams(location.search).has('chapter_id')).toBe(false);
    await elapse(1800);
    page.unmount();
    open(prototypeHistoryUrl(id));
    const historyPage = mount(PrototypeHistoryPage);
    const resumeUrl = historyPage.get('[data-testid="history-continue"]').attributes('href');
    expect(new URL(resumeUrl, location.href).searchParams.has('chapter_id')).toBe(false);
    expect(historyPage.get('h1').text()).toBe('随便聊聊');
    historyPage.unmount();
    open(prototypeOrganizingUrl(id));
    const unfinishedPage = mount(PrototypeOrganizingPage);
    const unfinishedResume = unfinishedPage.get('.prototype-organizing-action').attributes('href');
    expect(new URL(unfinishedResume, location.href).searchParams.has('chapter_id')).toBe(false);
    unfinishedPage.unmount();
    page = activePage(resumeUrl);
    expect(page.get('h1').text()).toBe('随便聊聊');
    expect(page.find('[data-testid="selected-fragment"]').exists()).toBe(false);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    page.unmount();
    open(navigate.mock.calls.at(-1)[0]);
    const organizing = mount(PrototypeOrganizingPage);
    await elapse(2000);
    expect(organizing.get('[data-testid="selected-chapter"]').text()).toBe('童年时光');
    expect(organizing.get('[data-testid="selected-fragment"]').text()).toBe('记得的一件童年小事');
    const completed = getPrototypeSession(id);
    const result = new URL(organizing.get('[data-testid="view-organized-story"]').attributes('href'), location.href);
    expect(result.searchParams.get('chapter_id')).toBe('childhood');
    expect(result.searchParams.get('content_id')).toBe('childhood_memory');
    expect(result.searchParams.get('session_id')).toBe(id);
    expect(result.searchParams.get('story_id')).toBe(completed.storyId);
    const story = getPrototypeState().stories.find(item => item.id === completed.storyId);
    expect(story.chapter_id).toBe('childhood');
    expect(story.content_id).toBe('childhood_memory');
    expect(story.paragraphs.length).toBeGreaterThan(0);
  });
});
