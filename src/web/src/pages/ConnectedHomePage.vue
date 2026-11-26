<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import DecadeSelection from '../components/DecadeSelection.vue';
import ChapterTopics from '../components/ChapterTopics.vue';
import WorkflowNav from '../components/WorkflowNav.vue';
import { getAuthToken } from '../lib/api.js';
import { getCatalog, getHome, normalizeId, saveBirthDecade } from '../lib/workflow-api.js';
import { homeUrl, interviewUrl, loginUrl, organizingUrl, storyUrl } from '../lib/workflow-navigation.js';
import { navigate } from '../lib/navigation.js';
import '../styles/prototype-home.css';

const params = new URLSearchParams(location.search);
let chapterId = '';
try { if (params.getAll('chapter_id').length === 1) chapterId = normalizeId(params.get('chapter_id')); }
catch (_) { /* An invalid optional filter falls back to the first available chapter. */ }
const chapters = ref([]), initialChapterId = ref(chapterId);
const birthDecade = ref(null), saving = ref(false), saveError = ref('');
const occupation = ref(null), occupationError = ref(''), occupationStatus = ref('');
const homeHeading = ref(null);
const loading = ref(true), error = ref(''), privateError = ref(''), authRequired = ref(false);
const showingProfile = computed(() => !loading.value && !error.value && !birthDecade.value);
const progress = ref([]), progressLoading = ref(false);
const toldTopics = computed(() => progress.value.filter(item => item.story_id).map(item => ({
  chapterId: String(item.chapter_id), contentId: String(item.topic_id),
})));
let alive = true, version = 0, occupationPoll;
function stopOccupationPoll() { window.clearTimeout(occupationPoll); }
function scheduleOccupationPoll() {
  stopOccupationPoll();
  if (!alive || occupationStatus.value !== 'generating') return;
  const epoch = version;
  occupationPoll = window.setTimeout(async () => {
    if (!alive || epoch !== version) return;
    try {
      const catalog = await getCatalog();
      if (alive && epoch === version) showCatalog(catalog);
    } catch (cause) {
      if (alive && epoch === version) {
        occupationStatus.value = 'failed';
        occupationError.value = cause.message;
      }
    }
  }, 3000);
}
function showCatalog(catalog) {
  birthDecade.value = catalog.birth_decade;
  occupation.value = catalog.occupation || null;
  occupationError.value = catalog.occupation_error || '';
  occupationStatus.value = catalog.occupation_status || '';
  chapters.value = catalog.chapters.map(chapter => ({ ...chapter, id: String(chapter.id), core_contents: chapter.topics.map(topic => ({ ...topic, id: String(topic.id) })) }));
  scheduleOccupationPoll();
}
async function load() {
  const epoch = ++version;
  stopOccupationPoll();
  saving.value = false; saveError.value = ''; birthDecade.value = null; chapters.value = [];
  occupation.value = null; occupationError.value = ''; occupationStatus.value = '';
  loading.value = true; error.value = ''; privateError.value = ''; authRequired.value = false; progress.value = [];
  progressLoading.value = false;
  try {
    const catalog = await getCatalog();
    if (!alive || epoch !== version) return;
    showCatalog(catalog);
  } catch (cause) { if (alive && epoch === version) error.value = cause.message; }
  finally { if (alive && epoch === version) loading.value = false; }
  if (alive && epoch === version && birthDecade.value) await loadProgress(epoch);
}
async function loadProgress(epoch) {
  if (!getAuthToken()) return;
  progressLoading.value = true;
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
async function confirmDecade({ birthDecade: decade, occupation: selectedOccupation }) {
  if (saving.value) return;
  const epoch = ++version;
  stopOccupationPoll();
  saving.value = true; saveError.value = '';
  try {
    const catalog = await saveBirthDecade(decade, selectedOccupation);
    if (!alive || epoch !== version) return;
    if (birthDecade.value !== decade) {
      initialChapterId.value = '';
      history.replaceState(null, '', homeUrl());
    }
    showCatalog(catalog);
    progress.value = []; privateError.value = ''; authRequired.value = false;
    void loadProgress(epoch);
    await nextTick();
    homeHeading.value?.focus();
  } catch (cause) {
    if (alive && epoch === version) {
      if (cause.status === 409) await load();
      else saveError.value = cause.message;
    }
  } finally {
    if (alive && epoch === version) { saving.value = false; scheduleOccupationPoll(); }
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
onBeforeUnmount(() => { alive = false; ++version; stopOccupationPoll(); window.removeEventListener('pageshow', load); window.removeEventListener('manji:auth-changed', authChanged); });
</script>
<template>
  <main class="prototype-home connected-home" :class="{ 'is-choosing-profile': showingProfile }" data-testid="connected-home-page">
    <header class="prototype-home-header"><a class="prototype-brand" :href="homeUrl()"><svg class="prototype-time-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true"><circle cx="14" cy="14" r="10"/><path d="M14 8v6l4 3" /></svg>慢记</a><span v-if="showingProfile" class="prototype-home-section">人生轨迹</span></header>
    <section class="prototype-home-intro"><h1 ref="homeHeading" tabindex="-1">{{ showingProfile ? '主人公资料' : '人生轨迹' }}</h1></section>
    <p v-if="loading" class="connected-notice" role="status">正在读取您的年代选择…</p>
    <div v-else-if="error" class="connected-notice connected-error" role="alert">{{ error }} <button class="connected-retry" @click="load">重试</button></div>
    <template v-else>
      <DecadeSelection v-if="!birthDecade" :busy="saving" :error="saveError" @confirm="confirmDecade" />
      <section v-if="birthDecade" aria-label="我的年代话题">
        <div class="decade-current"><span>主人公：<strong>{{ birthDecade }} 后<span v-if="occupation"> · {{ occupation }}</span></strong></span></div>
        <p v-if="occupationStatus === 'generating'" class="connected-notice" role="status" data-testid="occupation-generating">正在补充职业话题，您可以先讲已有话题。</p>
        <p v-if="occupationError || occupationStatus === 'idle'" class="connected-notice" :class="{ 'connected-error': occupationError }" :role="occupationError ? 'alert' : 'status'">{{ occupationError || '职业话题尚未补充，您可以先讲已有话题。' }} <button type="button" class="connected-retry" :disabled="saving" @click="confirmDecade({ birthDecade, occupation })">{{ saving ? '正在保存…' : occupationError ? '重试补充' : '补充职业话题' }}</button></p>
        <p v-if="saveError" class="connected-error" role="alert">{{ saveError }}</p>
        <ChapterTopics :chapters="chapters" :initial-chapter-id="initialChapterId" :told-topics="toldTopics" told-label="已讲述" :topics-disabled="progressLoading || !!privateError" @select="selectTopic" @chapter-change="selectChapter" />
        <p v-if="progressLoading" class="connected-notice" role="status">正在读取话题进度…</p>
        <p v-if="privateError" class="connected-notice connected-error" role="alert">{{ authRequired ? '登录状态已失效。' : privateError }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a><button v-else class="connected-retry" @click="load">重试</button></p>
      </section>
    </template>
  </main>
  <WorkflowNav active="map" />
</template>
