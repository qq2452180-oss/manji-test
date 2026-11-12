<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import * as workflow from '../lib/workflow-api.js';
import { ApiError, getAuthToken } from '../lib/api.js';
import { homeUrl, interviewUrl, loginUrl, organizingUrl, historyUrl } from '../lib/workflow-navigation.js';
import '../styles/prototype-story.css';

const params = new URLSearchParams(location.search);
const storyId = params.getAll('story_id').length === 1 && /^[1-9]\d*$/.test(params.get('story_id') || '')
  && Number.isSafeInteger(Number(params.get('story_id'))) ? params.get('story_id') : '';
const story = ref(null), topic = ref(null), loading = ref(true), error = ref('');
const visible = ref(!document.hidden), authChanged = ref(false), authRequired = ref(false);
const paragraphs = computed(() => (story.value?.body || '').split(/\n\s*\n/).map(text => text.trim()).filter(Boolean));
const sourceId = computed(() => story.value?.source_session_id ? String(story.value.source_session_id) : '');
const sources = computed(() => Array.isArray(story.value?.source_sessions) ? story.value.source_sessions
  : story.value?.source_sessions === undefined && sourceId.value ? [{ session_id: sourceId.value }] : []);
const supplement = computed(() => story.value?.active_supplement);
const continuation = computed(() => {
  if (story.value?.pending_processing?.session_id) return organizingUrl(story.value.pending_processing.session_id, { storyId });
  if (!topic.value?.id) return '';
  if (supplement.value?.status === 'organizing') return organizingUrl(supplement.value.session_id, { storyId });
  return interviewUrl({ topicId: topic.value.id, chapterId: topic.value.chapter_id, storyId,
    sessionId: supplement.value?.session_id });
});
const continuationLabel = computed(() => story.value?.pending_processing ? '继续整理'
  : supplement.value?.status === 'organizing' ? '继续整理补充'
  : '继续补充');
let alive = true, generation = 0, busy = false, identityPending = false, owner = getAuthToken();
const current = version => alive && visible.value && generation === version && !authChanged.value;

async function load() {
  if (!alive || !visible.value || busy || authChanged.value) return;
  if (!storyId) { loading.value = false; error.value = '暂时找不到这篇故事，请从首页重新打开。'; return; }
  busy = true; loading.value = true; error.value = ''; authRequired.value = false;
  const version = generation;
  try {
    if (!getAuthToken()) throw new ApiError('请先登录原来的账号，再重新打开这篇故事。', { status: 401, code: 'AUTH_REQUIRED' });
    identityPending = !getAuthToken();
    try { await workflow.ensureIdentity(); owner = getAuthToken(); }
    finally { identityPending = false; }
    if (!current(version)) return;
    const result = await workflow.getStory(storyId);
    if (!current(version)) return;
    story.value = result; topic.value = result.selected_topic || null;
    document.title = `慢记 · ${result.title || '故事'}`;
  } catch (cause) {
    if (current(version)) { story.value = null; error.value = cause.message || '故事暂时无法读取，请重试。'; authRequired.value = cause.status === 401; }
  } finally {
    if (alive) {
      busy = false; loading.value = false;
      if (visible.value && !authChanged.value && generation !== version) void load();
    }
  }
}
function changedIdentity() {
  if (identityPending && !owner && !story.value) return;
  generation++; authChanged.value = true; authRequired.value = false; story.value = null; topic.value = null;
  document.title = '慢记 · 故事';
  loading.value = false; error.value = '登录状态已变化，请返回首页重新打开故事。';
}
function hide() { visible.value = false; generation++; }
function show() { visible.value = true; if (!busy && !authChanged.value) void load(); }
function visibility() { document.hidden ? hide() : show(); }
onMounted(() => {
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  window.addEventListener('manji:auth-changed', changedIdentity);
  void load();
});
onBeforeUnmount(() => {
  alive = false; generation++;
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('pagehide', hide);
  window.removeEventListener('pageshow', show);
  window.removeEventListener('manji:auth-changed', changedIdentity);
});
</script>

<template>
  <main class="prototype-story" data-testid="connected-story-page">
    <header class="prototype-story-header"><a class="prototype-story-back" :href="homeUrl(topic?.chapter_id || story?.chapter_id)"><span aria-hidden="true">‹</span> 返回人生轨迹</a></header>
    <div v-if="visible" class="prototype-story-reading">
      <template v-if="story && !authChanged">
        <p v-if="topic" class="prototype-story-context"><span>{{ topic.title }}</span></p>
        <article class="prototype-story-article">
          <h1>{{ story.title }}</h1><p v-for="(paragraph, index) in paragraphs" :key="index" data-testid="story-paragraph">{{ paragraph }}</p>
        </article>
        <footer class="prototype-story-actions">
          <a v-if="continuation" class="prototype-story-action" :href="continuation" data-testid="continue-topic">{{ continuationLabel }}<span aria-hidden="true"> →</span></a>
          <a v-else class="prototype-story-action" :href="homeUrl(story.chapter_id)" data-testid="select-story-topic">选一个话题继续讲述<span aria-hidden="true"> →</span></a>
          <a v-for="(source, index) in sources" :key="source.session_id" class="prototype-story-source" :href="historyUrl(source.session_id)" data-testid="story-answers">{{ sources.length === 1 ? '查看讲述记录' : `查看第 ${index + 1} 次讲述问答` }}</a>
        </footer>
      </template>
      <section v-else class="prototype-story-empty">
        <h1>{{ loading ? '正在读取故事…' : '暂时无法打开这篇故事' }}</h1>
        <p v-if="error" role="alert">{{ error }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></p>
        <button v-if="!loading && storyId && !authChanged" class="prototype-story-action" type="button" data-testid="retry-story" @click="load">重新读取</button>
        <a v-else-if="!loading" class="prototype-story-action" :href="homeUrl()">返回人生轨迹</a>
      </section>
    </div>
  </main>
</template>
