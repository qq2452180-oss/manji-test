<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import * as workflow from '../lib/workflow-api.js';
import { ApiError, getAuthToken } from '../lib/api.js';
import { biographyUrl, homeUrl, interviewUrl, loginUrl, storyUrl } from '../lib/workflow-navigation.js';
import '../styles/prototype-organizing.css';

const params = new URLSearchParams(location.search);
const sessionId = params.getAll('session_id').length === 1 && /^[1-9]\d*$/.test(params.get('session_id') || '')
  && Number.isSafeInteger(Number(params.get('session_id'))) ? params.get('session_id') : '';
const phase = ref('loading'), error = ref(''), busy = ref(false), topic = ref(null), storyId = ref('');
const returnStoryId = ref(params.getAll('story_id').length === 1 && /^[1-9]\d*$/.test(params.get('story_id') || '')
  && Number.isSafeInteger(Number(params.get('story_id'))) ? params.get('story_id') : '');
const authChanged = ref(false), authRequired = ref(false), visible = ref(!document.hidden), needsReply = ref(false), legacyReadOnly = ref(false);
const resultUrl = computed(() => storyId.value ? storyUrl(storyId.value, { sessionId }) : '');
const backUrl = computed(() => returnStoryId.value ? storyUrl(returnStoryId.value) : homeUrl(topic.value?.chapter_id));
let alive = true, generation = 0, identityPending = false, finishPending = false, owner = getAuthToken();
const current = version => alive && visible.value && generation === version && !authChanged.value;

async function run(finish = false, rebase = false) {
  if (!alive || !visible.value || busy.value || authChanged.value) return;
  if (!sessionId) { phase.value = 'error'; error.value = '暂时找不到这段讲述，请从首页重新打开。'; return; }
  busy.value = true; error.value = ''; authRequired.value = false; needsReply.value = false; legacyReadOnly.value = false; phase.value = 'loading';
  const version = generation;
  try {
    if (!getAuthToken()) throw new ApiError('请先登录原来的账号，再重新打开这段讲述。', { status: 401, code: 'AUTH_REQUIRED' });
    identityPending = !getAuthToken();
    try { await workflow.ensureIdentity(); owner = getAuthToken(); }
    finally { identityPending = false; }
    if (!current(version)) return;
    const session = await workflow.getInterview(sessionId);
    if (!current(version)) return;
    topic.value = session.selected_topic || null;
    returnStoryId.value = session.target_story_id ? String(session.target_story_id)
      : session.story_id ? String(session.story_id) : '';
    if (session.status === 'completed' && session.story_id && !finishPending) {
      storyId.value = String(session.story_id); phase.value = 'done'; return;
    }
    if (session.status === 'revision_conflict' && !rebase) {
      phase.value = 'conflict'; error.value = '原故事已有更新，补充内容仍然保留。请按最新故事重新整理。'; return;
    }
    if (!topic.value && session.interview_scope !== 'global' && session.status !== 'completed'
      && !(session.status === 'writing_pending' && ['memory_update', 'summary'].includes(session.next_node))) {
      legacyReadOnly.value = true; phase.value = 'legacy'; return;
    }
    if (session.status === 'reply_pending' || session.save_pending) {
      needsReply.value = true;
      throw new Error('本轮回复还未完成，请返回讲述页重试后再整理。');
    }
    if (!finish) { phase.value = 'waiting'; return; }
    phase.value = 'working';
    finishPending = true;
    const result = rebase ? await workflow.finishInterview(sessionId, { rebase: true }) : await workflow.finishInterview(sessionId);
    if (result.status !== 'completed' || !result.story_id) throw new Error('整理尚未完成，已有讲述已保留，可以继续整理。');
    finishPending = false;
    if (!current(version)) return;
    storyId.value = String(result.story_id); phase.value = 'done';
  } catch (cause) {
    if (current(version)) {
      phase.value = cause.code === 'STORY_VERSION_CONFLICT' ? 'conflict' : 'error';
      error.value = cause.message || '整理暂未完成，已有讲述已保留。';
      authRequired.value = cause.status === 401;
    }
  } finally {
    if (alive) {
      busy.value = false;
      // Read only after the previous request has settled. Never poll GET while
      // finish holds the session lock, or automatically repeat a failed finish.
      if (visible.value && !authChanged.value && generation !== version) void run(false);
    }
  }
}
function changedIdentity() {
  if (identityPending && !owner && !topic.value && !storyId.value) return;
  generation++; authChanged.value = true; authRequired.value = false; topic.value = null; storyId.value = ''; returnStoryId.value = ''; legacyReadOnly.value = false;
  phase.value = 'error'; error.value = '登录状态已变化，请返回首页重新打开。';
}
function hide() { visible.value = false; generation++; }
function show() { visible.value = true; if (!busy.value && !authChanged.value) void run(false); }
function visibility() { document.hidden ? hide() : show(); }
onMounted(() => {
  document.title = '慢记 · 整理讲述';
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  window.addEventListener('manji:auth-changed', changedIdentity);
  void run(true);
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
  <main class="prototype-organizing" data-testid="connected-organizing-page">
    <header class="prototype-organizing-header"><a :href="backUrl"><span aria-hidden="true">‹</span> {{ returnStoryId ? '返回故事' : '返回人生轨迹' }}</a><span>整理讲述</span></header>
    <section v-if="visible" class="prototype-organizing-content" aria-live="polite">
      <p v-if="topic" class="prototype-organizing-fragment">{{ topic.title }}</p>
      <template v-if="phase === 'loading' || phase === 'working'">
        <div class="prototype-organizing-mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <h1>{{ phase === 'loading' ? '正在读取这段讲述' : '正在整理这段讲述' }}</h1>
        <p class="prototype-organizing-copy">讲述已保留，整理完成后就可以查看故事和更新后的传记。</p>
      </template>
      <template v-else-if="phase === 'done'">
        <div class="prototype-organizing-done" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m8 16 5 5 11-11" /></svg></div>
        <h1>这段讲述已经整理好了</h1>
        <p class="prototype-organizing-copy">故事已保存，可以查看故事和传记。</p>
        <a class="prototype-organizing-action" :href="resultUrl" data-testid="view-organized-story">查看故事</a>
        <a class="prototype-organizing-retry" :href="biographyUrl()" data-testid="view-organized-biography">查看传记</a>
      </template>
      <template v-else>
        <h1>{{ authChanged ? '请重新打开这段讲述' : legacyReadOnly ? '原讲述仍然保留' : '这段讲述尚未整理完成' }}</h1>
        <p v-if="legacyReadOnly" class="prototype-organizing-copy">这段旧讲述没有所属话题，请选一个话题开始新的访谈。</p>
        <p v-if="error" class="prototype-organizing-error" role="alert">{{ error }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></p>
        <a v-if="legacyReadOnly && !authChanged" class="prototype-organizing-action" :href="homeUrl()" data-testid="legacy-select-topic">选话题开始新访谈</a>
        <a v-else-if="needsReply && !authChanged" class="prototype-organizing-action" :href="interviewUrl({ sessionId, storyId: returnStoryId || undefined })">返回讲述</a>
        <button v-else-if="phase === 'conflict' && !authChanged" class="prototype-organizing-action" type="button" :disabled="busy" data-testid="rebase-organization" @click="run(true, true)">按最新故事重新整理</button>
        <button v-else-if="sessionId && !authChanged" class="prototype-organizing-action" type="button" :disabled="busy" data-testid="retry-organization" @click="run(true)">继续整理</button>
        <a v-else class="prototype-organizing-action" :href="homeUrl()">返回人生轨迹</a>
      </template>
    </section>
  </main>
</template>
