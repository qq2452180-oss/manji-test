<script setup>
import { computed, onMounted, ref } from 'vue';
import * as api from '../lib/api.js';
import * as pointers from '../lib/app-state.js';
import { navigate } from '../lib/navigation.js';
import { formatDate, loginUrl, usePageLifecycle } from '../composables/page.js';
import { entryUrl, resolveEntry } from '../lib/first-visit.js';
import PageHeader from '../components/PageHeader.vue';
import SiteNav from '../components/SiteNav.vue';
import '../styles/home.css';

const stories = ref([]), draft = ref(null), organization = ref(null);
const loading = ref(true), error = ref(''), notice = ref('');
const memberReady = ref(false);
let version = 0, alive = true, visible = !document.hidden;
const draftUrl = computed(() => './' + (draft.value?.flow_version === 'interview' ? 'interview' : 'history') + '.html?session_id=' + encodeURIComponent(draft.value?.session_id || '') + (draft.value?.flow_version === 'interview' ? '&resume=1' : ''));
const draftHistory = computed(() => './history.html?session_id=' + encodeURIComponent(draft.value?.session_id || ''));
const draftPreview = computed(() => (draft.value?.turns?.at(-1)?.assistant_text || draft.value?.opening_assistant_text || '上次的讲述已保存，可以从停下的地方接着讲。').slice(0, 100));
const organizationTitle = computed(() => organization.value?.error_code === 'NO_MATERIAL' ? '这次讲述已保存，素材还不足以整理' : organization.value?.status === 'FAILED' ? '这次整理需要重试' : organization.value?.status === 'SUCCEEDED' ? '新的故事已整理好' : '小暖正在整理故事');

function clear() { ++version; memberReady.value = false; stories.value = []; draft.value = null; organization.value = null; error.value = ''; notice.value = ''; loading.value = true; }
async function readDraft(current) {
  // The account's saved session survives a closed browser or a new login.
  // Local pointers remain useful for legacy records and organizing progress.
  const saved = await api.getUnfinishedInterview();
  if (!current()) return null;
  const ids = [...new Set([saved.session_id, ...pointers.getActiveSessionIds()].filter(Boolean))];
  for (const id of ids) {
    if (!current()) return null;
    let session;
    try { session = await api.getSession(id); }
    catch (failure) {
      if (!current()) return null;
      if (failure.status === 404) { pointers.removeActiveSessionId(id); continue; }
      throw failure;
    }
    if (!current()) return null;
    if (session.activity_state === 'FINISHING') { pointers.setOrganizationSessionId(id); pointers.removeActiveSessionId(id); continue; }
    if (session.status === 'ACTIVE' && session.activity_state !== 'FINISHED') {
      if (session.flow_version === 'interview') pointers.setActiveSessionId(id);
      return session;
    }
    pointers.removeActiveSessionId(id);
  }
  return null;
}
async function loadHome() {
  if (!alive || !visible) return;
  const request = ++version, token = api.getAuthToken();
  const current = () => alive && visible && request === version && token === api.getAuthToken();
  memberReady.value = false; loading.value = true; error.value = ''; notice.value = '';
  try {
    const context = await resolveEntry({ isCurrent: current });
    if (!context || !current()) return;
    if (context.destination !== 'home') {
      navigate(context.destination === 'login' ? loginUrl({ trial: context.user?.is_guest === true }) : entryUrl(context), { replace: true }); return;
    }
    memberReady.value = true;
    const draftRequest = readDraft(current);
    // A finishing draft creates the organization pointer before it is read.
    const organizationRequest = draftRequest.catch(() => null).then(() => {
      if (!current()) return null;
      const id = pointers.getOrganizationSessionId();
      return id ? api.getOrganization(id) : null;
    });
    const [homeResult, draftResult, organizationResult] = await Promise.allSettled([api.readHomeData(), draftRequest, organizationRequest]);
    if (!current()) return;
    if (homeResult.status === 'fulfilled') {
      pointers.setBiographyId(homeResult.value.biography.biography_id);
      stories.value = (homeResult.value.stories || []).slice(0, 5);
    } else { stories.value = []; error.value = homeResult.reason.message || '暂时无法读取故事。'; }
    draft.value = draftResult.status === 'fulfilled' ? draftResult.value : null;
    organization.value = organizationResult.status === 'fulfilled' ? organizationResult.value : null;
    notice.value = draftResult.status === 'rejected' ? '上次的讲述暂时无法确认。请重新加载，记录仍然保留。' : organizationResult.status === 'rejected' ? '暂时无法确认故事整理进度。' : '';
  } catch (failure) { if (current()) { notice.value = failure.message || '暂时无法打开首页。'; stories.value = []; } }
  finally { if (current()) loading.value = false; }
}
usePageLifecycle({
  hide() { visible = false; clear(); },
  show() { visible = true; void loadHome(); },
  auth() { clear(); navigate(loginUrl(), { replace: true }); },
  destroy() { alive = false; visible = false; clear(); },
});
onMounted(loadHome);
</script>

<template>
  <template v-if="memberReady">
  <PageHeader title="" back="" />
  <main class="paper-page with-navigation tell-page">
    <span class="paper-kicker">慢记 · 讲述</span>
    <section v-if="draft" data-testid="draft">
      <h1 class="paper-title">接着上次，慢慢聊。</h1>
      <div class="draft-card">
        <div class="draft-card-header">
          <span class="draft-card-icon" aria-hidden="true">
            <svg v-if="draft.mode === 'PHOTO'" viewBox="0 0 24 24" fill="none" focusable="false"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" focusable="false"><path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3.5-.7L4 20l1.2-4.5a9 9 0 0 1-.7-3.5 8 8 0 0 1 8-8H13a7.5 7.5 0 0 1 7 7v.5Z"/><path d="M8.5 10h7m-7 4h4"/></svg>
          </span>
          <span class="draft-card-title">上次的讲述</span>
          <span class="draft-card-kind">{{ draft.mode === 'PHOTO' ? '照片访谈' : '对话访谈' }}</span>
        </div>
        <p class="draft-card-preview">{{ draftPreview }}</p>
        <div class="draft-card-actions">
          <a v-if="draft.flow_version === 'interview'" class="draft-card-history" :href="draftHistory">查看记录</a>
          <a class="draft-card-continue" :href="draftUrl">{{ draft.flow_version === 'interview' ? '继续聊' : '查看历史' }}<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></a>
        </div>
      </div>
    </section>
    <section v-else><h1 class="paper-title">从一张照片，讲起。</h1><p class="paper-muted">选几张照片，小暖会看着照片，陪您聊聊那时候的事。</p></section>
    <button v-if="organization" class="organization-notice" data-testid="organization" @click="navigate('./organizing.html?session_id=' + encodeURIComponent(organization.session_id))"><span>{{ organizationTitle }}</span><span>查看进度 ›</span></button>
    <p v-if="notice" class="soft-notice" role="status">{{ notice }}</p>
    <button v-if="notice" class="paper-link draft-retry" type="button" :disabled="loading" @click="loadHome">重新加载</button>
    <div class="recent-heading"><h2 class="paper-section-title">最近整理</h2><a class="paper-link" href="./biography.html">读传记 ›</a></div>
    <div class="recent-content" aria-live="polite">
      <p v-if="loading" class="paper-state paper-muted">正在翻开你的故事…</p>
      <template v-else-if="error"><p class="error-message">{{ error }}</p><button class="paper-link" @click="loadHome">重新加载</button></template>
      <div v-else-if="!stories.length" class="empty-stories"><span class="empty-heading">你的第一篇故事，留在这里</span><p class="paper-muted">讲完后，小暖会把它整理成文字。</p></div>
      <button v-for="story in stories" v-else :key="story.story_id || story.id" class="recent-story" @click="navigate('./story.html?story_id=' + encodeURIComponent(story.story_id || story.id))"><span class="recent-copy"><span class="recent-title">{{ story.current_version?.title || '刚整理好的故事' }}</span><span class="paper-muted">{{ formatDate(story.current_version?.created_at) }} · 已整理成故事</span></span><span class="recent-arrow">›</span></button>
    </div>
    <a class="photo-interview-card" href="./interview.html?new=1&entry=PHOTO">
      <span class="photo-interview-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" focusable="false"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>
      </span>
      <span class="photo-interview-label">图片访谈</span>
      <svg class="photo-interview-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>
    </a>
  </main>
  <SiteNav active="tell" />
  </template>
  <main v-else class="paper-page">
    <p class="paper-muted" role="status">{{ loading ? '正在确认登录状态…' : notice || '正在打开入口…' }}</p>
    <button v-if="notice" class="paper-button secondary" type="button" @click="loadHome">重新确认</button>
  </main>
</template>
