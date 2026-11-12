<script setup>
import { onMounted, ref } from 'vue';
import WorkflowNav from '../components/WorkflowNav.vue';
import { getCurrentUser, setAuthToken } from '../lib/api.js';
import { useWorkflowRead } from '../composables/workflow-read.js';
import { biographyUrl, historyUrl, interviewUrl, loginUrl } from '../lib/workflow-navigation.js';
import '../styles/prototype-library.css';
const family = location.pathname.endsWith('/preview.html');
const { data: user, loading, error, anonymous, authRequired, refresh } = useWorkflowRead(() => family ? null : getCurrentUser({ redirectOnUnauthorized: false, preserveAuthOnUnauthorized: true }));
const restartError = ref('');
function signOut() {
  restartError.value = '';
  try { setAuthToken(''); }
  catch (_) { restartError.value = '暂时无法退出，请允许浏览器存储后重试。'; }
}
onMounted(() => { document.title = `慢记 · ${family ? '家人' : '我的空间'}`; });
</script>
<template>
  <main class="prototype-library prototype-library-with-nav">
    <header class="prototype-library-header"><h1>{{ family ? '家人' : '我的空间' }}</h1></header>
    <p v-if="family" class="prototype-family-empty">家人功能后续开放</p>
    <template v-else>
      <p v-if="loading" class="connected-notice">正在读取…</p>
      <section v-else-if="authRequired" class="connected-notice connected-error" role="alert">
        <p>登录状态已失效，请登录原来的账号找回记录。</p>
        <a :href="loginUrl()">重新登录 →</a>
      </section>
      <div v-else-if="error" class="connected-notice connected-error" role="alert">{{ error }} <button class="connected-retry" @click="refresh">重试</button></div>
      <section v-else class="connected-saved">
        <template v-if="anonymous">
          <h2>让故事留在自己的账号里</h2><p class="connected-notice">登录后，可以找回已经讲下的故事和传记。</p>
          <a :href="loginUrl()">登录已有账号 →</a><a :href="loginUrl({ register: true })">注册账号 →</a>
        </template>
        <template v-else-if="user?.is_guest">
          <h2>请先注册或登录</h2><p class="connected-notice">注册账号后，可以保留之前的访谈、故事和传记。</p>
          <a :href="loginUrl({ register: true })">注册并保留我的故事 →</a><a :href="loginUrl() + '&mode=login'">登录已有账号 →</a>
        </template>
        <template v-else>
          <h2>已登录</h2><p class="connected-notice">讲过的内容已保存在账号里，可以随时接着聊。</p>
          <p class="connected-notice"><button class="connected-retry" @click="signOut">退出当前浏览器</button></p>
        </template>
        <p v-if="restartError" class="connected-error" role="alert">{{ restartError }}</p>
      </section>
      <div v-if="user?.is_guest === false && !authRequired" class="connected-saved"><a :href="interviewUrl()">和小暖聊聊 →</a><a :href="historyUrl()">讲述记录 →</a><a :href="biographyUrl()">我的传记 →</a></div>
    </template>
  </main>
  <WorkflowNav :active="family ? 'family' : 'profile'" />
</template>
