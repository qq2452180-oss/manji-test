<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import ChapterTopics from '../components/ChapterTopics.vue';
import WorkflowNav from '../components/WorkflowNav.vue';
import { getAuthToken } from '../lib/api.js';
import { getCatalog, getHome, normalizeId } from '../lib/workflow-api.js';
import { homeUrl, interviewUrl, loginUrl, organizingUrl, storyUrl } from '../lib/workflow-navigation.js';
import { navigate } from '../lib/navigation.js';
import '../styles/prototype-home.css';

const params = new URLSearchParams(location.search);
let chapterId = '';
try { if (params.getAll('chapter_id').length === 1) chapterId = normalizeId(params.get('chapter_id')); }
catch (_) { /* An invalid optional filter falls back to the first available chapter. */ }
const chapters = ref([]), initialChapterId = ref(chapterId);
const loading = ref(true), error = ref(''), privateError = ref(''), authRequired = ref(false);
const progress = ref([]), progressLoading = ref(false);
const toldTopics = computed(() => progress.value.filter(item => item.story_id).map(item => ({
  chapterId: String(item.chapter_id), contentId: String(item.topic_id),
})));
let alive = true, version = 0;
async function load() {
  const epoch = ++version;
  loading.value = true; error.value = ''; privateError.value = ''; authRequired.value = false; progress.value = [];
  progressLoading.value = Boolean(getAuthToken());
  try {
    const catalog = await getCatalog();
    if (!alive || epoch !== version) return;
    chapters.value = catalog.chapters.map(chapter => ({ ...chapter, id: String(chapter.id), core_contents: chapter.topics.map(topic => ({ ...topic, id: String(topic.id) })) }));
  } catch (cause) { if (alive && epoch === version) error.value = cause.message; }
  finally { if (alive && epoch === version) loading.value = false; }
  if (!alive || epoch !== version || !getAuthToken()) return;
  try {
    const home = await getHome();
    if (alive && epoch === version) {
      if (!Array.isArray(home.topic_progress)) throw new Error('话题进度暂时无法读取，请重试。');
      progress.value = home.topic_progress;
    }
  } catch (cause) {
    if (alive && epoch === version) { privateError.value = cause.message; authRequired.value = cause.status === 401; }
  } finally {
    if (alive && epoch === version) progressLoading.value = false;
  }
}
function selectChapter(id) { initialChapterId.value = id; history.replaceState(null, '', homeUrl(id)); }
function selectTopic({ chapterId, contentId }) {
  if (progressLoading.value || privateError.value) return;
  const item = progress.value.find(value => String(value.topic_id) === contentId);
  if (item?.story_id) return navigate(storyUrl(item.story_id));
  if (item?.status === 'organizing' && item.session_id) return navigate(organizingUrl(item.session_id));
  if (item?.status === 'in_progress' && item.session_id) return navigate(interviewUrl({ chapterId, topicId: contentId, sessionId: item.session_id }));
  if (item && item.status !== 'not_started') { privateError.value = '话题进度暂时无法确认，请重试。'; return; }
  navigate(interviewUrl({ chapterId, topicId: contentId }));
}
function authChanged() { void load(); }
onMounted(() => { document.title = '慢记 · 人生轨迹'; void load(); window.addEventListener('pageshow', load); window.addEventListener('manji:auth-changed', authChanged); });
onBeforeUnmount(() => { alive = false; ++version; window.removeEventListener('pageshow', load); window.removeEventListener('manji:auth-changed', authChanged); });
</script>
<template>
  <main class="prototype-home" data-testid="connected-home-page">
    <header class="prototype-home-header"><a class="prototype-brand" :href="homeUrl()"><svg class="prototype-time-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true"><circle cx="14" cy="14" r="10"/><path d="M14 8v6l4 3" /></svg>慢记</a></header>
    <section class="prototype-home-intro"><h1>人生轨迹</h1></section>
    <p v-if="loading" class="connected-notice" role="status">正在读取章节和话题…</p>
    <div v-else-if="error" class="connected-notice connected-error" role="alert">{{ error }} <button class="connected-retry" @click="load">重试</button></div>
    <ChapterTopics v-else :chapters="chapters" :initial-chapter-id="initialChapterId" :told-topics="toldTopics" told-label="已讲述" :topics-disabled="progressLoading || !!privateError" @select="selectTopic" @chapter-change="selectChapter" />
    <p v-if="progressLoading && !loading" class="connected-notice" role="status">正在读取话题进度…</p>
    <p v-if="privateError" class="connected-notice connected-error" role="alert">{{ authRequired ? '登录状态已失效。' : privateError }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a><button v-else class="connected-retry" @click="load">重试</button></p>
  </main>
  <WorkflowNav active="map" />
</template>
