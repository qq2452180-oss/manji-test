import { useLegacyPrototypeSnapshot } from './prototype-fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PrototypeInterviewPage from '../src/pages/PrototypeInterviewPage.vue';
import PrototypeOrganizingPage from '../src/pages/PrototypeOrganizingPage.vue';
import PrototypeHistoryPage from '../src/pages/PrototypeHistoryPage.vue';
import PrototypeStoryPage from '../src/pages/PrototypeStoryPage.vue';
import PrototypeBiographyPage from '../src/pages/PrototypeBiographyPage.vue';
import PrototypeHomePage from '../src/pages/PrototypeHomePage.vue';
import { lifeMapChapters } from '../src/lib/life-map-topics.js';
import {
  getPrototypeState, getPrototypeSession, getPrototypeSessionTurns,
  startPrototypeSession, pausePrototypeSession, advancePrototypeSession,
  savePrototypeTopicDraft, answerPrototypeTopic, choosePrototypeTopicQuestion,
  organizePrototypeSession, completePrototypeOrganization,
} from '../src/lib/prototype-state.js';
import { prototypeInterviewUrl, prototypeHomeUrl, prototypeHistoryUrl, prototypeStoryUrl } from '../src/lib/prototype-topic.js';
import { navigate } from '../src/lib/navigation.js';

vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn() }));

const chapter = lifeMapChapters[0], topic = chapter.core_contents[0];
const pair = { chapterId: chapter.id, contentId: topic.id };
const request = vi.fn(), microphone = vi.fn(), audio = vi.fn(), recorder = vi.fn();
let originalMediaDevices;
const open = (url, component = PrototypeInterviewPage) => {
  history.replaceState(null, '', url);
  return mount(component);
};
const openInterview = options => open(prototypeInterviewUrl(pair.chapterId, pair.contentId, options));
const saveAnswerButton = page => page.findAll('button').find(button => button.text() === '保存这段文字');
async function elapse(ms) { await vi.advanceTimersByTimeAsync(ms); await nextTick(); }
async function complete(id) {
  organizePrototypeSession(id);
  await elapse(2000);
  return completePrototypeOrganization(id);
}

beforeEach(() => {
  useLegacyPrototypeSnapshot();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T08:00:00.000Z'));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('Audio', audio);
  vi.stubGlobal('MediaRecorder', recorder);
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
});
afterEach(() => {
  expect(request).not.toHaveBeenCalled();
  expect(microphone).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
  expect(recorder).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else delete navigator.mediaDevices;
});

describe('new life map topic narration', () => {
  it('carries consecutive saved answers through draft recovery, organization, history, story, biography and map', async () => {
    const originalStories = getPrototypeState().stories;
    const legacy = startPrototypeSession({ chapterId: 'origins', contentId: 'hometown' });
    advancePrototypeSession(legacy.id); pausePrototypeSession(legacy.id);
    const legacySnapshot = getPrototypeSession(legacy.id);
    let page = openInterview();
    expect(page.get('[data-testid="selected-fragment"]').text()).toBe(topic.title);
    expect(page.get('[data-testid="topic-opening-question"]').text()).toBe(topic.prompt);
    expect(page.find('.prototype-question-guide').exists()).toBe(false);
    expect(page.text()).not.toContain('看看其他问题');
    expect(page.find('.voice-ring').exists()).toBe(false);
    expect(getPrototypeState().sessions).toHaveLength(1);
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = new URLSearchParams(location.search).get('session_id');
    expect(getPrototypeSessionTurns(getPrototypeSession(id))).toEqual([{ role: 'assistant', text: topic.prompt }]);
    await elapse(10000);
    expect(getPrototypeSession(id).turnIndex).toBe(1);

    const firstAnswer = '我住过的老屋旁边有一棵树。\n\n放学后，我常在那里等家里人回来。';
    await page.get('#topic-answer').setValue(firstAnswer);
    expect(getPrototypeSession(id).draft).toBe(firstAnswer);
    expect(getPrototypeSessionTurns(getPrototypeSession(id))).toHaveLength(1);
    page.unmount();
    page = openInterview({ sessionId: id });
    expect(getPrototypeSession(id).status).toBe('paused');
    expect(page.get('#topic-answer').element.value).toBe(firstAnswer);
    expect(page.get('#topic-answer').element.disabled).toBe(true);
    await page.get('[data-testid="start-interview"]').trigger('click');
    await saveAnswerButton(page).trigger('click');
    expect(getPrototypeSession(id).draft).toBe('');
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(firstAnswer);
    expect(page.find('.prototype-question-guide').exists()).toBe(false);
    const secondAnswer = '有时邻居会送来自己种的菜，我们一起坐着聊天。';
    await page.get('#topic-answer').setValue(secondAnswer);
    await saveAnswerButton(page).trigger('click');
    expect(getPrototypeSessionTurns(getPrototypeSession(id))).toEqual([
      { role: 'assistant', text: topic.prompt },
      { role: 'user', text: firstAnswer },
      { role: 'user', text: secondAnswer },
    ]);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    const organizingUrl = navigate.mock.calls.at(-1)[0];
    expect(getPrototypeSession(id).status).toBe('organizing');
    page.unmount();

    const organizing = open(organizingUrl, PrototypeOrganizingPage);
    expect(organizing.get('[data-testid="selected-chapter"]').text()).toBe(chapter.title);
    expect(organizing.get('[data-testid="selected-fragment"]').text()).toBe(topic.title);
    await elapse(2000);
    const completed = getPrototypeSession(id);
    expect(completed.status).toBe('complete');
    const story = getPrototypeState().stories.find(item => item.id === completed.storyId);
    expect(story.paragraphs).toEqual([...firstAnswer.split('\n\n'), secondAnswer]);
    expect(story.paragraphs).not.toContain(topic.prompt);
    const storyUrl = organizing.get('[data-testid="view-organized-story"]').attributes('href');
    organizing.unmount();

    const historyPage = open(prototypeHistoryUrl(id), PrototypeHistoryPage);
    expect(historyPage.findAll('.prototype-history-turn p').map(node => node.text())).toEqual([
      topic.prompt, firstAnswer, secondAnswer,
    ]);
    expect(historyPage.text()).toContain('话题讲述');
    expect(historyPage.get('[data-testid="history-continue"]').attributes('href')).toContain('story_id=' + completed.storyId);
    historyPage.unmount();
    const storyPage = open(storyUrl, PrototypeStoryPage);
    expect(storyPage.find('.prototype-story-label').exists()).toBe(false);
    expect(storyPage.findAll('.prototype-story-article > p').map(node => node.text())).toEqual(story.paragraphs);
    expect(storyPage.get('[data-testid="continue-topic"]').attributes('href')).toContain('story_id=' + completed.storyId);
    storyPage.unmount();
    const biography = open('./biography.html?prototype=1', PrototypeBiographyPage);
    expect(biography.get('[data-testid="biography-stage-L1"]').findAll('.prototype-draft-paragraph').map(node => node.text())).toEqual(story.paragraphs);
    biography.unmount();
    const home = open(prototypeHomeUrl(chapter.id), PrototypeHomePage);
    const told = home.get(`[data-testid="topic-${topic.id}"]`);
    expect(told.get('.chapter-topic-status').text()).toBe('讲过');
    await told.trigger('click');
    expect(navigate).toHaveBeenLastCalledWith(prototypeStoryUrl(chapter.id, topic.id));
    expect(getPrototypeState().stories.filter(item => originalStories.some(old => old.id === item.id))).toEqual(originalStories);
    expect(getPrototypeSession(legacy.id)).toEqual(legacySnapshot);
  });

  it('restores a saved draft when reopening the topic from the map without a session ID', async () => {
    const saved = startPrototypeSession(pair);
    savePrototypeTopicDraft(saved.id, '上次没有写完的回忆。');
    pausePrototypeSession(saved.id);
    const page = openInterview();
    expect(new URLSearchParams(location.search).has('session_id')).toBe(false);
    expect(page.find('#topic-answer').exists()).toBe(false);
    await page.get('[data-testid="start-interview"]').trigger('click');
    expect(new URLSearchParams(location.search).get('session_id')).toBe(saved.id);
    expect(getPrototypeState().sessions).toHaveLength(1);
    expect(page.get('#topic-answer').element.value).toBe('上次没有写完的回忆。');
    expect(page.get('#topic-answer').element.disabled).toBe(false);
  });

  it('restores an existing follow-up and pending draft, then preserves both answers through organization', async () => {
    const session = startPrototypeSession(pair);
    const firstAnswer = '最初住过的屋子，门前有一块空地。';
    const pendingAnswer = '说到这个细节，我还记得屋里的木头桌子。';
    answerPrototypeTopic(session.id, firstAnswer);
    choosePrototypeTopicQuestion(session.id, 1);
    savePrototypeTopicDraft(session.id, pendingAnswer);
    pausePrototypeSession(session.id);
    const before = getPrototypeSession(session.id);
    const page = openInterview({ sessionId: session.id });
    expect(page.find('.prototype-question-guide').exists()).toBe(false);
    expect(page.text()).not.toContain('看看其他问题');
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(topic.followups[0]);
    expect(page.get('#topic-answer').element.value).toBe(pendingAnswer);
    expect(page.get('#topic-answer').element.disabled).toBe(true);
    expect(getPrototypeSession(session.id)).toEqual(before);
    await page.get('[data-testid="start-interview"]').trigger('click');
    expect(page.get('[data-testid="prototype-caption"]').text()).toBe(topic.followups[0]);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(page.get('[role="alert"]').text()).toContain('请先保存这段文字');
    expect(navigate).not.toHaveBeenCalled();
    await saveAnswerButton(page).trigger('click');
    expect(getPrototypeSessionTurns(getPrototypeSession(session.id))).toEqual([
      { role: 'assistant', text: topic.prompt },
      { role: 'user', text: firstAnswer },
      { role: 'assistant', text: topic.followups[0] },
      { role: 'user', text: pendingAnswer },
    ]);
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(getPrototypeSession(session.id).status).toBe('organizing');
    page.unmount();
    await elapse(2000);
    const completed = completePrototypeOrganization(session.id);
    const story = getPrototypeState().stories.find(item => item.id === completed.storyId);
    expect(story.paragraphs).toEqual([firstAnswer, pendingAnswer]);
    const historyPage = open(prototypeHistoryUrl(session.id), PrototypeHistoryPage);
    expect(historyPage.findAll('.prototype-history-turn p').map(node => node.text())).toEqual([
      topic.prompt, firstAnswer, topic.followups[0], pendingAnswer,
    ]);
  });

  it('does not create a story from empty answers, drafts, elapsed time or question selection alone', async () => {
    const count = getPrototypeState().stories.length;
    const session = startPrototypeSession(pair);
    answerPrototypeTopic(session.id, ' \n ');
    savePrototypeTopicDraft(session.id, '还没有提交的文字');
    for (const index of [1, 2, 3, 0]) choosePrototypeTopicQuestion(session.id, index);
    advancePrototypeSession(session.id);
    expect(getPrototypeSession(session.id).turnIndex).toBe(1);
    expect(getPrototypeSessionTurns(getPrototypeSession(session.id))).toEqual([{ role: 'assistant', text: topic.prompt }]);
    organizePrototypeSession(session.id);
    await elapse(30000);
    completePrototypeOrganization(session.id);
    expect(getPrototypeSession(session.id).status).toBe('running');
    expect(getPrototypeState().stories).toHaveLength(count);
  });

  it('keeps longer question/answer records and appends supplements exactly once', async () => {
    const session = startPrototypeSession(pair);
    const answers = ['老屋门前有块空地。', '那时我常在门口玩。', '后来空地上种了花。'];
    answers.forEach((answer, index) => {
      answerPrototypeTopic(session.id, answer);
      if (index < answers.length - 1) choosePrototypeTopicQuestion(session.id, index + 1);
    });
    expect(getPrototypeSession(session.id).turnIndex).toBe(6);
    const original = await complete(session.id);
    const originalStory = getPrototypeState().stories.find(story => story.id === original.storyId);
    expect(originalStory.paragraphs).toEqual(answers);
    const supplement = startPrototypeSession({ ...pair, storyId: original.storyId });
    answerPrototypeTopic(supplement.id, '补充一件事：我记得门槛已经磨得很平。');
    await complete(supplement.id);
    completePrototypeOrganization(supplement.id);
    await elapse(10000);
    completePrototypeOrganization(supplement.id);
    const stories = getPrototypeState().stories.filter(story => story.chapter_id === pair.chapterId && story.content_id === pair.contentId);
    expect(stories).toHaveLength(1);
    expect(stories[0].id).toBe(original.storyId);
    expect(stories[0].createdAt).toBe(originalStory.createdAt);
    expect(stories[0].paragraphs).toEqual([...answers, '补充一件事：我记得门槛已经磨得很平。']);
  });

  it('requires saving the current draft before finishing and keeps paused answers unchanged', async () => {
    const page = openInterview();
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = new URLSearchParams(location.search).get('session_id');
    await page.get('#topic-answer').setValue('第一段已经写好了。');
    await saveAnswerButton(page).trigger('click');
    await page.get('#topic-answer').setValue('第二段还在写。');
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(page.get('[role="alert"]').text()).toContain('请先保存这段文字');
    expect(navigate).not.toHaveBeenCalled();
    expect(getPrototypeSession(id).status).toBe('running');
    await page.get('[data-testid="pause-interview"]').trigger('click');
    const before = getPrototypeSessionTurns(getPrototypeSession(id));
    answerPrototypeTopic(id, '不应在暂停时进入正文');
    choosePrototypeTopicQuestion(id, 1);
    expect(getPrototypeSessionTurns(getPrototypeSession(id))).toEqual(before);
    expect(getPrototypeSession(id).draft).toBe('第二段还在写。');
  });

  it('rejects another topic’s session and story without showing its saved words', async () => {
    const session = startPrototypeSession(pair);
    answerPrototypeTopic(session.id, '这段文字属于第一个话题。');
    const completed = await complete(session.id);
    const other = lifeMapChapters[1].core_contents[0];
    const page = open(prototypeInterviewUrl('L2', other.id, { sessionId: session.id, storyId: completed.storyId }));
    expect(page.text()).toContain('这个片段暂时无法打开');
    expect(page.text()).not.toContain('这段文字属于第一个话题。');
    expect(page.find('#topic-answer').exists()).toBe(false);
    page.unmount();
    const story = open(prototypeStoryUrl('L2', other.id, { storyId: completed.storyId }), PrototypeStoryPage);
    expect(story.text()).toContain('暂时找不到这段故事');
    expect(story.text()).not.toContain('这段文字属于第一个话题。');
  });

  it('preserves typed text and saved progress on storage failures, then retries without duplicating an answer', async () => {
    const page = openInterview();
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = new URLSearchParams(location.search).get('session_id');
    const before = getPrototypeSession(id);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const answer = '写到一半时，存储暂时不可用。';
    await page.get('#topic-answer').setValue(answer);
    expect(page.get('[role="alert"]').text()).toContain('无法保存进度');
    expect(page.get('#topic-answer').element.value).toBe(answer);
    expect(getPrototypeSession(id)).toEqual(before);
    await saveAnswerButton(page).trigger('click');
    expect(page.get('[role="alert"]').text()).toContain('无法保存进度');
    expect(page.get('#topic-answer').element.value).toBe(answer);
    expect(getPrototypeSession(id)).toEqual(before);
    write.mockRestore();
    await saveAnswerButton(page).trigger('click');
    expect(getPrototypeSessionTurns(getPrototypeSession(id))).toEqual([{ role: 'assistant', text: topic.prompt }, { role: 'user', text: answer }]);
    expect(page.get('#topic-answer').element.value).toBe('');
    expect(page.find('[role="alert"]').exists()).toBe(false);
  });

  it('does not finish or navigate when saving the organization fails', async () => {
    const page = openInterview();
    await page.get('[data-testid="start-interview"]').trigger('click');
    const id = new URLSearchParams(location.search).get('session_id');
    await page.get('#topic-answer').setValue('只保留已经写下来的这句话。');
    await saveAnswerButton(page).trigger('click');
    const before = getPrototypeSession(id);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(page.get('[role="alert"]').text()).toContain('无法保存进度');
    expect(navigate).not.toHaveBeenCalled();
    expect(getPrototypeSession(id)).toEqual(before);
    write.mockRestore();
    await page.get('[data-testid="start-interview"]').trigger('click');
    await page.get('[data-testid="finish-interview"]').trigger('click');
    expect(getPrototypeSession(id).status).toBe('organizing');
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
