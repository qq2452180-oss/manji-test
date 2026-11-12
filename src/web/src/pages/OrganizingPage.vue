<script setup>
import { computed, onMounted, ref, shallowRef } from 'vue';
import * as api from '../lib/api.js';
import * as state from '../lib/app-state.js';
import { createOrganizingController } from '../lib/organizing-controller.js';
import { navigate } from '../lib/navigation.js';
import { loginUrl, requireUser, usePageLifecycle } from '../composables/page.js';
import PageHeader from '../components/PageHeader.vue';
import '../styles/organizing.css';

const sessionId = new URLSearchParams(location.search).get('session_id')?.trim() || '';
const view = shallowRef({ phase: 'loading', title: '', storyId: '', message: '', busy: false, retryAllowed: true, materialIssue: false });
const reader = ref(null);
const entryPage = computed(() => reader.value?.is_guest ? 'biography.html' : reader.value ? 'index.html' : 'welcome.html');
const entryLabel = computed(() => reader.value?.is_guest ? '返回体验预览' : reader.value ? '回到讲述首页' : '返回欢迎页');
let identityVersion = 0;
const controller = createOrganizingController({ sessionId, api, state, authorize: async () => {
  const version = identityVersion, token = api.getAuthToken();
  const user = await requireUser();
  if (version === identityVersion && token === api.getAuthToken()) reader.value = user;
  return user;
}, onChange: value => { view.value = value; } });
const phase = computed(() => view.value.phase === 'loading' ? 'working' : view.value.phase);
function clearIdentity() { reader.value = null; ++identityVersion; }
usePageLifecycle({ hide() { clearIdentity(); controller.setVisible(false); }, show: () => controller.setVisible(true),
  auth() { clearIdentity(); controller.destroy(); navigate(loginUrl(), { replace: true }); }, destroy() { clearIdentity(); controller.destroy(); } });
onMounted(() => { if (document.hidden) controller.setVisible(false); else void controller.refresh(); });
</script>

<template>
  <PageHeader :title="reader?.is_guest ? '体验结果' : '整理讲述'" :back="entryPage" :home="entryPage" />
  <main class="organizing-page" aria-live="polite">
    <section v-if="phase === 'working'" class="status-block" data-phase="working"><h1 class="page-title">正在整理这段讲述</h1><p class="subline">整理好后可以在这里查看</p><div class="progress" aria-hidden="true"><div class="progress-bar"></div></div><p class="status-detail">{{ view.message }}</p><button class="primary-action" disabled>查看整理结果</button><button v-if="view.phase === 'working'" class="small-action" :disabled="view.busy" @click="controller.refresh()">刷新进度</button><a class="quiet-action" :href="'./' + entryPage">{{ entryLabel }}</a></section>
    <section v-else-if="phase === 'done'" class="status-block" data-phase="done"><div class="done-mark">✓</div><h1 class="page-title">整理好了</h1><p class="subline">{{ view.title }}</p><p v-if="view.message" class="status-detail">{{ view.message }}</p><a class="primary-action" :href="`./story.html?id=${encodeURIComponent(view.storyId)}`">看看这次写的</a><a class="quiet-action" :href="'./' + entryPage">{{ entryLabel }}</a></section>
    <section v-else-if="phase === 'failed'" class="status-block" data-phase="failed"><div class="error-mark">!</div><h1 class="page-title">这次没有整理成功</h1><p class="subline">{{ view.message }}</p><button v-if="view.retryAllowed" class="primary-action" :disabled="view.busy" @click="controller.retry()">{{ view.busy ? '请稍候…' : '重新整理' }}</button><a class="quiet-action" :href="'./' + entryPage">{{ entryLabel }}</a></section>
    <section v-else-if="phase === 'empty'" class="status-block" data-phase="empty"><h1 class="page-title">下次再接着聊</h1><p class="subline">{{ view.message }}</p><a class="primary-action" :href="'./' + entryPage">{{ entryLabel }}</a></section>
    <section v-else class="status-block" data-phase="error"><h1 class="page-title">暂时没能查看进度</h1><p class="subline">{{ view.message }}</p><button class="primary-action" :disabled="view.busy" @click="controller.refresh()">重试</button><a class="quiet-action" :href="'./' + entryPage">{{ entryLabel }}</a></section>
  </main>
</template>
