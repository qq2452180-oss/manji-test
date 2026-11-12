<script setup>
import { computed, onMounted } from 'vue';
import { getHome, getInterview } from '../lib/workflow-api.js';
import { useWorkflowRead } from '../composables/workflow-read.js';
import { biographyUrl, homeUrl, interviewUrl, loginUrl, organizingUrl, storyUrl } from '../lib/workflow-navigation.js';
import '../styles/prototype-history.css';

const params = new URLSearchParams(location.search), sessionId = params.get('session_id');
const { data, loading, error, anonymous, authRequired, refresh } = useWorkflowRead(async () => {
  if (params.has('session_id') && (params.getAll('session_id').length !== 1 || !sessionId)) throw new Error('讲述链接无效。');
  return sessionId ? getInterview(sessionId) : getHome();
});
const onward = computed(() => !data.value || !sessionId ? null : data.value.status === 'completed'
  ? { href: storyUrl(data.value.story_id), label: '查看故事' }
  : ['writing_pending', 'revision_conflict'].includes(data.value.status) ? { href: organizingUrl(sessionId), label: '继续整理' }
    : { href: interviewUrl({ sessionId }), label: '继续讲述' });
onMounted(() => { document.title = '慢记 · 讲述记录'; });
</script>
<template>
  <main class="prototype-history" data-testid="connected-history-page">
    <header class="prototype-history-header"><a :href="homeUrl()">‹ 返回人生轨迹</a></header>
    <div class="prototype-history-content">
      <h1>{{ sessionId ? data?.selected_topic?.title || '讲述内容' : '讲述记录' }}</h1>
      <p v-if="loading" class="connected-notice" role="status">正在读取讲述…</p>
      <div v-else-if="error" class="connected-notice connected-error" role="alert">{{ error }} <button class="connected-retry" @click="refresh">重试</button> <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></div>
      <section v-else-if="anonymous" class="prototype-history-empty"><p>{{ sessionId ? '请使用开始这次讲述时的身份打开记录。' : '开始讲述后，可以回来查看保存的内容。' }}</p><a class="prototype-history-action" :href="homeUrl()">去人生轨迹</a><a class="prototype-history-action" :href="loginUrl()">登录查看已有记录</a></section>
      <template v-else-if="sessionId && data">
        <div class="prototype-history-turns" aria-label="讲述内容"><article v-for="message in data.messages" :key="message.id" class="prototype-history-turn" :class="{ 'is-user': message.role === 'user' }"><span>{{ message.role === 'assistant' ? '小暖' : '我' }}</span><p class="connected-transcript">{{ message.content }}</p></article></div>
        <footer v-if="onward" class="prototype-history-actions"><a class="prototype-history-action" :href="onward.href">{{ onward.label }}</a><a v-if="data.status === 'completed'" class="prototype-history-action" :href="biographyUrl()">查看传记</a></footer>
      </template>
      <div v-else class="prototype-history-list">
        <a v-if="data?.unfinished_interview" class="prototype-history-row" :href="data.unfinished_interview.needs_processing ? organizingUrl(data.unfinished_interview.session_id) : interviewUrl({ sessionId: data.unfinished_interview.session_id })"><span>{{ data.unfinished_interview.needs_processing ? '继续整理上次的讲述' : '继续上次的讲述' }}</span></a>
        <a v-for="story in data?.stories || []" :key="story.story_id" class="prototype-history-row" :href="storyUrl(story.story_id)"><span>{{ story.title }}</span></a>
        <p v-if="!data?.unfinished_interview && !data?.stories?.length" class="connected-notice">还没有讲述记录。</p>
      </div>
    </div>
  </main>
</template>
