<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import SmsLoginForm from '../components/SmsLoginForm.vue';
import { getAuthToken, getCurrentUser, loginAccount, loginWithSms, registerAccount } from '../lib/api.js';
import { safeNext } from '../lib/login-helpers.js';
import { navigate } from '../lib/navigation.js';
import '../styles/profile.css';
import '../styles/phone-login.css';

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next') || '', location.origin, '/web/');
function initialMode(isGuest) {
  const requested = params.get('mode');
  if (['sms', 'login', 'register'].includes(requested)) return requested;
  return isGuest ? 'register' : 'sms';
}
const mode = ref(initialMode(false));
const username = ref(''), password = ref(''), confirmation = ref('');
const identity = ref(null), checking = ref(true), identityError = ref(''), error = ref(''), busy = ref(false);
const guest = computed(() => identity.value?.is_guest === true);
const member = computed(() => identity.value?.is_guest === false);
const disabled = computed(() => checking.value || busy.value || !!identityError.value);
let alive = true, version = 0, owner = '';

async function checkIdentity() {
  const epoch = ++version;
  owner = getAuthToken(); identity.value = null; identityError.value = ''; checking.value = true;
  mode.value = initialMode(false);
  try {
    const user = await getCurrentUser({ redirectOnUnauthorized: false });
    if (alive && epoch === version) {
      identity.value = user;
      mode.value = initialMode(user.is_guest);
    }
  } catch (cause) {
    if (alive && epoch === version && cause.status !== 401) identityError.value = cause.message || '暂时无法确认登录状态，请重试。';
  } finally {
    if (alive && epoch === version) { owner = getAuthToken(); checking.value = false; }
  }
}
function switchMode(value) {
  if (disabled.value) return;
  mode.value = value; password.value = ''; confirmation.value = ''; error.value = '';
}
async function authenticate(action) {
  if (disabled.value || member.value) return;
  if (owner !== getAuthToken()) { error.value = '登录状态已变化，请重新确认后继续。'; await checkIdentity(); return; }
  const switchingAccount = guest.value && mode.value !== 'register';
  const epoch = ++version;
  busy.value = true; error.value = '';
  try {
    await action();
    if (!alive || epoch !== version) return;
    password.value = ''; confirmation.value = '';
    // An existing account has different record IDs from this guest's records.
    navigate(switchingAccount ? '/web/index.html' : next, { replace: true });
  } catch (cause) {
    if (!alive || epoch !== version) return;
    error.value = cause.message || '暂时无法登录，请重试。';
    if (cause.code === 'AUTH_CONTEXT_CHANGED' || owner !== getAuthToken()) {
      busy.value = false;
      authChanged();
      return;
    }
    if (cause.code === 'REGISTRATION_LOGIN_REQUIRED') { mode.value = 'login'; confirmation.value = ''; }
  } finally {
    if (alive && epoch === version) { busy.value = false; owner = getAuthToken(); }
  }
}
function submitSms(phone, code) {
  return authenticate(() => loginWithSms(phone, code));
}
function submitPassword() {
  if (!/^[a-z0-9_]{3,32}$/i.test(username.value.trim())) { error.value = '账号需为 3 至 32 位字母、数字或下划线。'; return; }
  if (!password.value) { error.value = '请输入密码。'; return; }
  if (mode.value === 'register' && password.value !== confirmation.value) { error.value = '两次输入的密码不一致。'; return; }
  const action = mode.value === 'register' ? registerAccount : loginAccount;
  return authenticate(() => action(username.value, password.value));
}
function authChanged() { if (!busy.value) { username.value = ''; password.value = ''; confirmation.value = ''; void checkIdentity(); } }
onMounted(() => { document.title = '慢记 · 登录'; void checkIdentity(); window.addEventListener('manji:auth-changed', authChanged); });
onBeforeUnmount(() => { alive = false; ++version; password.value = ''; confirmation.value = ''; window.removeEventListener('manji:auth-changed', authChanged); });
</script>

<template>
  <main class="page-body login-page account-login-page phone-login-page">
    <a v-if="member" class="login-back" :href="next">‹ 返回慢记</a>
    <div class="login-brand"><div class="brand-mark" aria-hidden="true">慢</div><h1 class="brand-title">慢记</h1></div>
    <section class="login-actions" aria-label="账号登录">
      <p v-if="checking" class="account-status" role="status">正在确认登录状态…</p>
      <div v-else-if="identityError" class="account-check-error" role="alert"><p>{{ identityError }}</p><button class="paper-link" @click="checkIdentity">重新确认</button></div>
      <div v-else-if="member" class="guest-account-note"><p>您已登录，可以继续查看自己的故事和传记。</p><a class="paper-link" :href="next">继续使用 →</a><a class="paper-link" href="./profile.html">管理登录状态 →</a></div>
      <template v-else-if="mode === 'sms'">
        <h2 class="login-heading">手机号登录</h2>
        <p class="login-note">如果手机号尚未注册，短信验证通过后会自动创建账号。</p>
        <SmsLoginForm :disabled="disabled" :guest="guest" :error="error" @submit="submitSms" @clear-error="error = ''" />
        <div v-if="guest" class="other-login-methods">
          <button class="paper-link" :disabled="disabled" @click="switchMode('register')">注册并保留我的故事</button>
        </div>
      </template>
      <template v-else>
        <h2 class="login-heading">{{ mode === 'register' ? (guest ? '注册并保留我的故事' : '注册账号') : '账号密码登录' }}</h2>
        <p class="login-note">{{ mode === 'register' ? '设置账号和密码，下次回来就能接着聊。' : '用原来的账号登录，找回已经讲下的故事。' }}</p>
        <div v-if="guest" class="guest-account-note" role="note"><p>{{ mode === 'register' ? '这个浏览器中有之前的访谈记录。注册后，已有访谈、故事和传记都会保留在你的账号里。' : '这个浏览器中有之前的访谈记录，可先注册账号保存。登录已有账号会打开该账号的内容，旧记录不会自动合并。' }}</p></div>
        <form class="account-form" novalidate @submit.prevent="submitPassword">
          <div class="paper-field"><label class="paper-field-label" for="account-username">账号</label><input id="account-username" v-model="username" class="paper-input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" placeholder="3 至 32 位字母、数字或下划线" :disabled="disabled" required></div>
          <div class="paper-field"><label class="paper-field-label" for="account-password">密码</label><input id="account-password" v-model="password" class="paper-input" name="password" type="password" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" :disabled="disabled" required></div>
          <div v-if="mode === 'register'" class="paper-field"><label class="paper-field-label" for="account-confirm">再次输入密码</label><input id="account-confirm" v-model="confirmation" class="paper-input" name="confirmation" type="password" autocomplete="new-password" :disabled="disabled" required></div>
          <p v-if="error" class="notice account-error" role="alert">{{ error }}</p>
          <button class="btn btn-primary account-submit" type="submit" :disabled="disabled">{{ busy ? '正在处理…' : mode === 'register' ? '注册并继续' : '登录并继续' }}</button>
        </form>
        <p v-if="mode === 'register'" class="login-footnote">请妥善记住账号和密码，目前暂不支持找回密码。</p>
        <div class="other-login-methods">
          <button class="paper-link" :disabled="disabled" @click="switchMode('sms')">用手机号登录</button>
          <button v-if="guest && mode === 'login'" class="paper-link" :disabled="disabled" @click="switchMode('register')">注册并保留我的故事</button>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.other-login-methods { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; column-gap: 10px; margin-top: 20px; }
.other-login-methods .paper-link { min-height: 44px; padding: 8px 0; font-size: 15px; }
</style>
