<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { prototypeChapters } from '../lib/life-map-topics.js';
import { prototypeBackLink, prototypeHomeUrl, prototypeInterviewUrl, prototypeStoryUrl } from '../lib/prototype-topic.js';
import { usePrototypeState, resolvePrototypeSession, completePrototypeOrganization } from '../lib/prototype-state.js';
import '../styles/prototype-organizing.css';

const state = usePrototypeState();
const search = ref(location.search), refreshVersion = ref(0), error = ref('');
const session = computed(() => { state.value; refreshVersion.value; return resolvePrototypeSession(search.value); });
const chapter = computed(() => prototypeChapters.find(item => item.id === session.value?.chapterId));
const content = computed(() => chapter.value?.core_contents.find(item => item.id === session.value?.contentId));
const homeUrl = computed(() => prototypeHomeUrl(chapter.value?.id));
const back = computed(() => session.value ? prototypeBackLink(search.value, { chapter: chapter.value, content: content.value, session: session.value }) : { href: homeUrl.value, label: '返回人生轨迹' });
const title = computed(() => session.value?.freeTalk && session.value.status !== 'complete' ? '随便聊聊' : content.value?.title || '随便聊聊');
const from = () => new URLSearchParams(search.value).get('from') || undefined;
const storyUrl = computed(() => {
  const current = session.value;
  if (!current || current.status !== 'complete') return '';
  const story = state.value.stories.find(item => item.id === current.storyId);
  return prototypeStoryUrl(story?.chapter_id || current.chapterId, story?.content_id || current.contentId,
    { storyId: current.storyId, sessionId: current.id, from: from() });
});
const interviewUrl = computed(() => session.value ? prototypeInterviewUrl(session.value.freeTalk ? undefined : session.value.chapterId, session.value.freeTalk ? undefined : session.value.contentId,
  { sessionId: session.value.id, from: from() }) : '');
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
let timer, mounted = false;
function stopTimer() { clearTimeout(timer); timer = undefined; }
function scheduleCompletion() {
  stopTimer();
  const current = session.value;
  if (!mounted || document.hidden || current?.status !== 'organizing') return;
  const started = timestamp(current.organizingAt);
  if (!Number.isFinite(started)) { error.value = '暂时无法读取整理进度。'; return; }
  const id = current.id;
  timer = setTimeout(() => {
    timer = undefined;
    if (document.hidden || session.value?.id !== id || session.value.status !== 'organizing') return;
    try { completePrototypeOrganization(id); scheduleCompletion(); }
    catch (cause) { error.value = cause.message || '暂时无法完成整理，请重试。'; }
  }, Math.max(20, started + 2000 - Date.now()));
}
function refresh() { search.value = location.search; refreshVersion.value++; scheduleCompletion(); }
function visibilityChanged() { if (document.hidden) stopTimer(); else refresh(); }
function retry() { error.value = ''; scheduleCompletion(); }
watch(() => [session.value?.id, session.value?.status, session.value?.organizingAt], scheduleCompletion);
onMounted(() => {
  mounted = true;
  document.title = '慢记 · 整理讲述';
  refresh();
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', stopTimer);
  window.addEventListener('pageshow', refresh);
});
onBeforeUnmount(() => {
  mounted = false; stopTimer();
  document.removeEventListener('visibilitychange', visibilityChanged);
  window.removeEventListener('pagehide', stopTimer);
  window.removeEventListener('pageshow', refresh);
});
</script>

<template>
  <main class="prototype-organizing" data-testid="prototype-organizing-page">
    <header class="prototype-organizing-header"><a :href="back.href"><span aria-hidden="true">‹</span> {{ back.label }}</a><span>整理讲述</span></header>
    <section v-if="!session" class="prototype-organizing-content">
      <h1>暂时找不到这段讲述</h1><a class="prototype-organizing-action" :href="homeUrl">返回人生轨迹</a>
    </section>
    <section v-else class="prototype-organizing-content" aria-live="polite">
      <p v-if="chapter" class="prototype-organizing-chapter" data-testid="selected-chapter">{{ chapter.title }}</p>
      <p class="prototype-organizing-fragment" :data-testid="content ? 'selected-fragment' : undefined">{{ title }}</p>
      <template v-if="session.status === 'organizing'">
        <div class="prototype-organizing-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h1>正在整理这段讲述</h1>
        <p class="prototype-organizing-copy">稍等片刻，故事就整理好了。</p>
      </template>
      <template v-else-if="session.status === 'complete'">
        <div class="prototype-organizing-done" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m8 16 5 5 11-11" /></svg></div>
        <h1>这段讲述已经整理好了</h1>
        <a class="prototype-organizing-action" :href="storyUrl" data-testid="view-organized-story">查看故事</a>
      </template>
      <template v-else>
        <h1>这段讲述还没整理</h1>
        <a class="prototype-organizing-action" :href="interviewUrl">继续讲述</a>
      </template>
      <template v-if="error"><p class="prototype-organizing-error" role="alert">{{ error }}</p><button class="prototype-organizing-retry" type="button" @click="retry">重试整理</button></template>
    </section>
  </main>
</template>
