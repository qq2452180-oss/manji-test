<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import VoiceRing from '../components/VoiceRing.vue';
import { prototypeBackLink, prototypeInterviewUrl, prototypeOrganizingUrl, prototypeStoryUrl } from '../lib/prototype-topic.js';
import { usePrototypeState, resolvePrototypeInterview, getPrototypeSession, getPrototypeSessionTurns, startPrototypeSession, pausePrototypeSession, resumePrototypeSession, advancePrototypeSession, organizePrototypeSession, savePrototypeTopicDraft, answerPrototypeTopic } from '../lib/prototype-state.js';
import { getPrototypeScenario } from '../lib/prototype-scenarios.js';
import { findLifeMapTopic } from '../lib/life-map-topics.js';
import { navigate } from '../lib/navigation.js';
import '../styles/prototype-interview.css';

const state = usePrototypeState();
const search = ref(location.search), refreshVersion = ref(0), error = ref('');
const context = computed(() => { state.value; refreshVersion.value; return resolvePrototypeInterview(search.value); });
const sessionId = ref(context.value.session?.id || '');
const session = computed(() => state.value.sessions.find(item => item.id === sessionId.value) || null);
const locallyPaused = ref(false);
const running = computed(() => session.value?.status === 'running' && !locallyPaused.value);
const libraryTopic = computed(() => context.value.kind === 'topic' && findLifeMapTopic(context.value.chapter.id, context.value.content.id));
const draft = ref(session.value?.draft || '');
const scenario = computed(() => getPrototypeScenario(context.value.chapter?.id || 'childhood', context.value.content?.id || 'childhood_memory'));
const title = computed(() => context.value.kind === 'topic' ? context.value.content.title : '随便聊聊');
const back = computed(() => prototypeBackLink(search.value, context.value));
const currentTurn = computed(() => {
  if (!session.value?.turnIndex) return null;
  return getPrototypeSessionTurns(session.value).at(-1) || null;
});
const finished = computed(() => ['organizing', 'complete'].includes(session.value?.status));
const canOrganize = computed(() => ['running', 'paused'].includes(session.value?.status) && session.value.turnIndex >= 2);
const from = () => new URLSearchParams(search.value).get('from') || undefined;
const resultUrl = computed(() => {
  const current = session.value;
  if (!current) return '';
  if (current.status === 'organizing') return prototypeOrganizingUrl(current.id, { from: from() });
  const story = state.value.stories.find(item => item.id === current.storyId);
  return prototypeStoryUrl(story?.chapter_id || current.chapterId, story?.content_id || current.contentId, { storyId: current.storyId, sessionId: current.id, from: from() });
});
let timer;
function stopTimer() { clearTimeout(timer); timer = undefined; }
function pause() {
  stopTimer();
  locallyPaused.value = true;
  const current = sessionId.value && getPrototypeSession(sessionId.value);
  try { if (current?.status === 'running') pausePrototypeSession(current.id); }
  catch (cause) { error.value = cause.message || '暂时无法保存暂停进度，请重试。'; }
}
function scheduleNext() {
  stopTimer();
  const current = session.value;
  if (libraryTopic.value || document.hidden || !running.value || !scenario.value || current.turnIndex >= scenario.value.turns.length) return;
  const id = current.id;
  timer = setTimeout(() => {
    timer = undefined;
    if (document.hidden || session.value?.id !== id || !running.value) return;
    try { advancePrototypeSession(id); scheduleNext(); }
    catch (cause) { pause(); error.value = cause.message || '暂时无法继续，请重试。'; }
  }, 1800);
}
function writeSessionUrl(current) {
  const params = new URLSearchParams(search.value);
  const url = prototypeInterviewUrl(context.value.chapter?.id, context.value.content?.id, {
    sessionId: current.id, storyId: params.get('story_id') || undefined,
    returnSessionId: params.get('return_session_id') || undefined,
    from: params.get('from') || undefined, back: params.get('back') || undefined,
  });
  history.replaceState(null, '', url);
  search.value = location.search;
}
function begin() {
  if (context.value.kind === 'invalid' || finished.value || running.value) return;
  error.value = '';
  try {
    if (session.value) resumePrototypeSession(session.value.id);
    else {
      const current = startPrototypeSession({ chapterId: context.value.chapter?.id, contentId: context.value.content?.id,
        freeTalk: context.value.kind === 'free', storyId: context.value.story?.id });
      sessionId.value = current.id;
      draft.value = current.draft || '';
      writeSessionUrl(current);
    }
    locallyPaused.value = false;
    scheduleNext();
  } catch (cause) { error.value = cause.message || '暂时无法开始，请重试。'; }
}
function finish() {
  if (libraryTopic.value && draft.value.trim()) {
    error.value = '请先保存这段文字，再整理。'; return;
  }
  if (!canOrganize.value) return;
  stopTimer(); error.value = '';
  try {
    const id = session.value.id;
    organizePrototypeSession(id);
    if (getPrototypeSession(id)?.status === 'organizing') navigate(prototypeOrganizingUrl(id, { from: from() }));
  } catch (cause) { pause(); error.value = cause.message || '暂时无法整理，请重试。'; }
}
function saveDraft(event) {
  draft.value = event.target.value;
  try { savePrototypeTopicDraft(sessionId.value, draft.value); error.value = ''; }
  catch (cause) { error.value = cause.message; }
}
function saveAnswer() {
  if (!running.value || !draft.value.trim()) return;
  try { answerPrototypeTopic(sessionId.value, draft.value); draft.value = ''; error.value = ''; }
  catch (cause) { error.value = cause.message; }
}
function refresh() {
  search.value = location.search; refreshVersion.value++;
  sessionId.value = context.value.session?.id || sessionId.value;
  pause();
}
function visibilityChanged() { if (document.hidden) pause(); }
onMounted(() => {
  refresh();
  document.title = `慢记 · ${context.value.kind === 'invalid' ? '讲述' : title.value}`;
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', refresh);
});
onBeforeUnmount(() => {
  pause();
  document.removeEventListener('visibilitychange', visibilityChanged);
  window.removeEventListener('pagehide', pause);
  window.removeEventListener('pageshow', refresh);
});
</script>

<template>
  <main class="prototype-interview" data-testid="prototype-interview-page">
    <header class="prototype-interview-header">
      <a class="prototype-interview-back" :href="back.href" @click="pause"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg><span>{{ back.label }}</span></a>
      <span class="prototype-interview-label">{{ libraryTopic ? '话题讲述' : '讲述' }}</span>
    </header>
    <section v-if="context.kind === 'invalid'" class="prototype-interview-unavailable">
      <h1>这个片段暂时无法打开</h1><a :href="back.href">{{ back.label }}</a>
    </section>
    <template v-else>
      <section class="prototype-interview-topic" aria-labelledby="prototype-interview-title">
        <p v-if="context.kind === 'topic'" class="prototype-interview-chapter" data-testid="selected-chapter">{{ context.chapter.title }}</p>
        <h1 id="prototype-interview-title" :data-testid="context.kind === 'topic' ? 'selected-fragment' : undefined">{{ title }}</h1>
        <p v-if="!session && context.content" class="prototype-interview-description" data-testid="topic-opening-question">{{ context.content.description }}</p>
      </section>
      <div class="prototype-interview-voice" :class="{ 'is-topic-library': libraryTopic }">
        <VoiceRing v-if="!libraryTopic" :state="session && !running ? 'paused' : 'listening'" :level="0" />
        <div class="prototype-interview-caption" aria-live="polite" aria-atomic="true">
          <template v-if="finished"><p>{{ session.status === 'complete' ? '这段讲述已经整理好了' : '这段讲述正在整理' }}</p></template>
          <template v-else-if="currentTurn"><span>{{ currentTurn.role === 'assistant' ? '小暖' : '我' }}</span><p data-testid="prototype-caption">{{ currentTurn.text }}</p><small v-if="!running">已暂停</small></template>
        </div>
        <div v-if="libraryTopic && !finished" class="prototype-topic-note">
          <p class="prototype-topic-note-hint">文字保存在当前标签页，关闭后不会保留。</p>
          <template v-if="session">
            <label for="topic-answer">这段回忆</label>
            <textarea id="topic-answer" :value="draft" :disabled="!running" rows="5" placeholder="想到哪里，就写到哪里…" @input="saveDraft"></textarea>
            <button type="button" class="prototype-interview-secondary" :disabled="!running || !draft.trim()" @click="saveAnswer">保存这段文字</button>
          </template>
        </div>
      </div>
      <footer class="prototype-interview-actions">
        <p v-if="error" class="prototype-interview-error" role="alert">{{ error }}</p>
        <a v-if="finished" class="prototype-interview-action" :href="resultUrl" data-testid="interview-result">{{ session.status === 'complete' ? '查看故事' : '查看整理进度' }}</a>
        <template v-else>
          <button v-if="running" class="prototype-interview-action" type="button" data-testid="pause-interview" @click="pause">暂停</button>
          <button v-else class="prototype-interview-action" type="button" data-testid="start-interview" @click="begin">{{ session ? '继续讲述' : '开始讲述' }}</button>
          <button v-if="session" class="prototype-interview-secondary" type="button" :disabled="!canOrganize" data-testid="finish-interview" @click="finish">结束并整理</button>
        </template>
      </footer>
    </template>
  </main>
</template>
