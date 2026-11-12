<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import * as api from '../lib/api.js';
import { navigate } from '../lib/navigation.js';
import { requireMember, usePageLifecycle } from '../composables/page.js';
import PageHeader from '../components/PageHeader.vue';
import SiteNav from '../components/SiteNav.vue';
import '../styles/profile.css';

const user = ref(null), avatarUrl = ref(''), signedIn = ref(Boolean(api.getAuthToken()));
const loading = ref(true), loggingOut = ref(false), notice = ref(''), explanation = ref(null), dialog = ref(null);
const previousGuest = ref(false), restoringGuest = ref(false), restoreError = ref('');
let version = 0, alive = true, visible = !document.hidden, guestReturnToken = '';
const name = computed(() => loading.value ? '正在加载…' : user.value ? user.value.display_name || user.value.username || (user.value.is_guest ? '初次体验' : '慢记用户') : signedIn.value ? '我的资料' : '欢迎来到慢记');
const caption = computed(() => user.value ? '每一段经历，都值得记下。' : signedIn.value ? '你的故事，在这里慢慢成书。' : '登录后，开始记录自己的故事。');
function releaseAvatar() { if (avatarUrl.value) URL.revokeObjectURL(avatarUrl.value); avatarUrl.value = ''; }
function clear() { ++version; user.value = null; previousGuest.value = false; releaseAvatar(); explanation.value = null; dialog.value?.close(); notice.value = ''; }
async function loadProfile() {
  if (!alive || !visible || loggingOut.value || restoringGuest.value) return;
  const request = ++version, token = api.getAuthToken();
  const current = () => alive && visible && request === version && token === api.getAuthToken();
  releaseAvatar(); user.value = null; notice.value = ''; signedIn.value = Boolean(token); loading.value = true;
  try {
    const result = await requireMember({ isCurrent: current });
    if (!result || !current()) return;
    user.value = result; loading.value = false;
    previousGuest.value = !result.is_guest && api.hasPreviousGuest();
    if (result.avatar_media_id) {
      try { const blob = await api.getPhotoBlob(result.avatar_media_id); if (current()) avatarUrl.value = URL.createObjectURL(blob); }
      catch (_) { /* The default avatar keeps the profile usable. */ }
    }
  } catch (_) { if (current()) notice.value = '个人资料暂时没有加载出来，请重试。'; }
  finally { if (current()) loading.value = false; }
}
async function explain(title, copy) { explanation.value = { title, copy }; await nextTick(); if (alive && visible && explanation.value) dialog.value?.showModal(); }
function closeDialog() { dialog.value?.close(); explanation.value = null; }
async function logout() {
  if (loggingOut.value || restoringGuest.value) return;
  loggingOut.value = true; clear();
  try { await api.logout(); } catch (_) { /* The API clears this tab even if logout fails. */ }
  finally { if (alive) { loggingOut.value = false; signedIn.value = Boolean(api.getAuthToken()); navigate('./login.html', { replace: true }); } }
}
async function returnToGuest() {
  if (restoringGuest.value || loggingOut.value || !alive || !visible) return;
  restoringGuest.value = true; restoreError.value = '';
  try {
    await api.restoreGuest();
    if (alive) {
      guestReturnToken = api.getAuthToken();
      if (visible) navigate('./biography.html', { replace: true });
    }
  } catch (error) {
    if (alive && visible) {
      restoreError.value = error.message || '暂时无法返回体验，请稍后重试。';
      previousGuest.value = api.hasPreviousGuest();
    }
  } finally { if (alive) restoringGuest.value = false; }
}
usePageLifecycle({
  hide() { visible = false; clear(); },
  show() {
    visible = true;
    if (guestReturnToken && guestReturnToken === api.getAuthToken()) { navigate('./biography.html', { replace: true }); return; }
    guestReturnToken = ''; void loadProfile();
  },
  auth() { guestReturnToken = ''; clear(); signedIn.value = Boolean(api.getAuthToken()); loading.value = false; if (!loggingOut.value) void loadProfile(); },
  destroy() { alive = false; visible = false; guestReturnToken = ''; clear(); },
});
onMounted(loadProfile);
</script>

<template>
  <template v-if="user">
  <PageHeader title="我的" back="" />
  <main class="page-body has-nav profile-page">
    <section class="identity-card" aria-label="个人资料"><div class="identity-main">
      <img v-if="avatarUrl" class="avatar" :src="avatarUrl" alt="我的头像" @error="releaseAvatar"><div v-else class="avatar avatar-placeholder" aria-hidden="true"><div class="avatar-head" /><div class="avatar-body" /></div>
      <div class="identity-copy"><h1 class="identity-name">{{ name }}</h1><p class="identity-caption">{{ caption }}</p></div>
    </div><a v-if="user && !loggingOut" class="edit-link" href="./profile-edit.html"><span>{{ user.display_name && user.avatar_media_id ? '编辑资料' : '完善头像和名字' }}</span><span aria-hidden="true">›</span></a><a v-if="!signedIn && !loading && !loggingOut" class="btn btn-primary login-action" href="./login.html?next=%2Fweb2%2Fprofile.html">登录慢记</a></section>
    <div v-if="notice" class="profile-notice" role="status"><span>{{ notice }}</span><button class="retry-link" type="button" @click="loadProfile">重新加载</button></div>
    <section class="profile-menu" aria-label="我的服务">
      <button v-if="previousGuest" class="profile-menu-row previous-guest" type="button" :disabled="restoringGuest || loggingOut" @click="returnToGuest"><div class="book-icon" aria-hidden="true"><i /></div><span class="menu-copy"><span class="menu-title">{{ restoringGuest ? '正在返回…' : '返回本次体验' }}</span><span class="menu-caption">尚未并入账号，仅在当前标签页保留入口</span></span><span class="menu-arrow" aria-hidden="true">›</span></button>
      <a class="profile-menu-row" :href="user ? './biography.html' : './login.html?next=%2Fweb2%2Fbiography.html'"><div class="book-icon" aria-hidden="true"><i /></div><span class="menu-copy"><span class="menu-title">我的传记</span><span class="menu-caption">翻一翻，已经记下的故事</span></span><span class="menu-arrow" aria-hidden="true">›</span></a>
      <button class="profile-menu-row" type="button" @click="explain('我的会员', '会员服务暂未开放。你可以继续讲述、整理和阅读自己的故事。')"><div class="menu-icon membership-icon" aria-hidden="true"><i /></div><span class="menu-copy"><span class="menu-title">我的会员</span><span class="menu-caption">会员服务，敬请期待</span></span><span class="menu-arrow" aria-hidden="true">›</span></button>
      <button class="profile-menu-row" type="button" @click="explain('浏览器授权', '点击浏览器地址栏左侧的网站设置，可以允许或关闭麦克风权限。只有开始通话时才会申请麦克风；暂停或离开通话页会关闭收音。')"><div class="menu-icon settings-icon" aria-hidden="true"><i /><i /><i /></div><span class="menu-copy"><span class="menu-title">系统设置</span><span class="menu-caption">了解浏览器麦克风授权</span></span><span class="menu-arrow" aria-hidden="true">›</span></button>
    </section>
    <p v-if="restoreError" class="profile-notice" role="alert">{{ restoreError }}</p>
    <footer class="profile-footer"><p class="footer-note">慢慢讲，慢慢记。</p><button v-if="signedIn || loggingOut" class="logout-link" type="button" :disabled="loggingOut || restoringGuest" @click="logout">{{ loggingOut ? '正在退出…' : '退出登录' }}</button></footer>
  </main>
  <dialog ref="dialog" class="dialog" aria-labelledby="profile-dialog-title" @click.self="closeDialog" @cancel="explanation = null"><div class="dialog-header"><h2 id="profile-dialog-title">{{ explanation?.title }}</h2><button type="button" aria-label="关闭" @click="closeDialog">×</button></div><p class="paper-muted">{{ explanation?.copy }}</p><button class="paper-button dialog-done" type="button" @click="closeDialog">知道了</button></dialog>
  <SiteNav active="profile" />
  </template>
  <main v-else class="page-body profile-page">
    <p class="loading-copy" role="status">{{ loading ? '正在确认登录状态…' : notice || '正在打开登录页面…' }}</p>
    <button v-if="notice" class="retry-link" type="button" @click="loadProfile">重新确认</button>
  </main>
</template>
