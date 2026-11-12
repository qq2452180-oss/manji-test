<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import * as api from '../lib/api.js';
import { loginAccounts, safeNext } from '../lib/login-helpers.js';
import { navigate } from '../lib/navigation.js';
import { usePageLifecycle } from '../composables/page.js';
import { finishFirstVisit, firstVisitReturnUrl } from '../lib/first-visit.js';
import '../styles/profile.css';
import '../styles/phone-login.css';

const params = new URLSearchParams(location.search);
const staticPreview = import.meta.env.VITE_STATIC_PREVIEW === 'true';
const debug = !staticPreview && params.get('debug') === '1';
const next = staticPreview ? './index.html' : safeNext(params.get('next') || params.get('return') || '', location.origin);
const phone = ref(''), code = ref(''), issuedPhone = ref(''), remaining = ref(0), success = ref(false);
const phoneInput = ref(null), codeInput = ref(null), successTitle = ref(null), errorField = ref('');
const normalizedPhone = computed(() => phone.value.trim());
const maskedPhone = computed(() => issuedPhone.value.replace(/^(\d{3})\d{4}(\d{4})$/, '$1 **** $2'));
let retryAt = 0, expiresAt = 0, timer = null;
const busy = ref(false), busyKind = ref(''), error = ref(params.get('reason') ? '请重新登录后继续。' : '');
const identity = ref(staticPreview ? 'anonymous' : 'checking'), identityError = ref(''), guest = computed(() => identity.value === 'guest');
const accountName = ref('');
const token = ref(''), accounts = ref([]), account = ref('0'), fileStatus = ref(''), developerError = ref(''), fileInput = ref(null);
let fileVersion = 0, attempt = 0, identityVersion = 0, alive = true, ownerToken = '';
const disabled = computed(() => busy.value || identity.value === 'checking' || identity.value === 'error');
const returning = computed(() => staticPreview ? './index.html' : guest.value ? './biography.html' : identity.value === 'member' ? next : firstVisitReturnUrl());
const returnLabel = computed(() => staticPreview ? '返回人生轨迹' : guest.value ? '返回体验预览' : identity.value === 'member' ? '返回已登录账号' : '返回欢迎页');

function stopCountdown() { if (timer !== null) clearInterval(timer); timer = null; }
function syncCountdown() {
  remaining.value = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  if (!remaining.value) stopCountdown();
}
function resumeCountdown() {
  stopCountdown(); syncCountdown();
  if (remaining.value) timer = setInterval(syncCountdown, 250);
}
function clearDemo() {
  stopCountdown(); retryAt = 0; expiresAt = 0;
  code.value = ''; issuedPhone.value = ''; remaining.value = 0; success.value = false;
}
function clearSecrets() { clearDemo(); phone.value = ''; token.value = ''; accounts.value = []; fileStatus.value = ''; }
function clearPrivate() { ++fileVersion; ++attempt; ++identityVersion; clearSecrets(); busy.value = false; }
watch(phone, () => { clearDemo(); error.value = ''; errorField.value = ''; }, { flush: 'sync' });
watch(code, () => { if (errorField.value === 'code') { error.value = ''; errorField.value = ''; } });
async function checkIdentity() {
  if (!alive || document.hidden) return;
  if (staticPreview) { identity.value = 'anonymous'; return; }
  const version = ++identityVersion, expected = api.getAuthToken();
  ownerToken = expected; identityError.value = ''; accountName.value = '';
  if (!expected) { identity.value = 'anonymous'; return; }
  finishFirstVisit();
  identity.value = 'checking';
  try {
    const user = await api.getCurrentUser({ redirectOnUnauthorized: false });
    if (!alive || version !== identityVersion) return;
    if (expected !== api.getAuthToken()) throw Object.assign(new Error(), { code: 'AUTH_CONTEXT_CHANGED' });
    identity.value = user.is_guest ? 'guest' : 'member';
    if (!user.is_guest) accountName.value = user.display_name || user.username || '当前账号';
  } catch (failure) {
    if (!alive || version !== identityVersion) return;
    if (failure.status === 401 && !api.getAuthToken()) { ownerToken = ''; identity.value = 'anonymous'; return; }
    identity.value = 'error';
    identityError.value = failure.code === 'AUTH_CONTEXT_CHANGED' ? '登录状态已变化，请重新确认后继续。' : '暂时无法确认本次体验，请检查网络后重试。';
  }
}
function canUseDemo() {
  if (!alive || document.hidden || disabled.value || success.value) return false;
  if (!staticPreview && ownerToken !== api.getAuthToken()) {
    clearDemo(); error.value = '登录状态已变化，请重新确认后继续。'; void checkIdentity(); return false;
  }
  return true;
}
function fail(message, field) {
  error.value = message; errorField.value = field;
  (field === 'phone' ? phoneInput : codeInput).value?.focus();
}
function validatePhone() {
  if (/^1[3-9]\d{9}$/.test(normalizedPhone.value)) return true;
  fail('请输入正确的 11 位手机号。', 'phone'); return false;
}
function sendCode() {
  if (!canUseDemo()) return;
  syncCountdown();
  if (remaining.value || !validatePhone()) return;
  error.value = ''; errorField.value = ''; code.value = '';
  issuedPhone.value = normalizedPhone.value;
  retryAt = Date.now() + 60000; expiresAt = Date.now() + 300000;
  resumeCountdown(); codeInput.value?.focus();
}
async function submitAccount() {
  if (!canUseDemo() || !validatePhone()) return;
  if (issuedPhone.value !== normalizedPhone.value) { fail('请先获取验证码。', 'code'); return; }
  if (!/^\d{6}$/.test(code.value)) { fail('请输入 6 位验证码。', 'code'); return; }
  if (Date.now() >= expiresAt) { fail('验证码已过期，请重新获取。', 'code'); return; }
  if (code.value !== '123456') { fail('验证码不正确，请重新输入。', 'code'); return; }
  // This is a local prototype only: never mint credentials or access an account.
  error.value = ''; errorField.value = ''; success.value = true; code.value = ''; stopCountdown();
  await nextTick();
  if (alive && !document.hidden && success.value) successTitle.value?.focus();
}
async function restartDemo() {
  clearDemo(); error.value = ''; errorField.value = '';
  await nextTick();
  if (alive && !document.hidden) phoneInput.value?.focus();
}
function chooseAccount() { token.value = accounts.value[Number(account.value)]?.token || ''; developerError.value = ''; }
async function readFile(event) {
  if (staticPreview) return;
  const file = event.target.files?.[0], version = ++fileVersion;
  event.target.value = '';
  if (!file || busy.value || !alive) return;
  accounts.value = []; token.value = ''; fileStatus.value = ''; developerError.value = '';
  try {
    if (file.size > 64 * 1024) throw new Error();
    const parsed = JSON.parse(await file.text());
    if (!alive || version !== fileVersion || busy.value) return;
    const result = loginAccounts(parsed);
    if (!result.length) throw new Error();
    accounts.value = result; account.value = '0'; chooseAccount();
    fileStatus.value = '已在本地读入 ' + result.length + ' 个测试账户。';
  } catch (_) { if (alive && version === fileVersion) developerError.value = '这个文件里没有找到可用的登录凭证，请选择 dev-login.json。'; }
}
async function loginDeveloper() {
  if (staticPreview || busy.value || !alive) return;
  const credential = token.value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) { developerError.value = '请粘贴完整的登录凭证，或选择登录文件。'; return; }
  const request = ++attempt, current = () => alive && attempt === request;
  ++fileVersion; ++identityVersion; busy.value = true; busyKind.value = 'developer'; developerError.value = '';
  try {
    api.setAuthToken(credential);
    await api.getCurrentUser();
    if (!current()) return;
    if (api.getAuthToken() !== credential) { developerError.value = '登录状态已改变，请重新登录。'; return; }
    clearSecrets(); navigate(next, { replace: true });
  } catch (failure) {
    if (!current()) return;
    if (api.getAuthToken() === credential) { try { api.setAuthToken(''); } catch (_) {} }
    developerError.value = failure.status === 401 ? '登录凭证已失效，请换用新的登录凭证。' : ['NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(failure.code) ? '暂时连接不上，请检查网络后重试。' : '登录未成功，请检查凭证后再试。';
    await checkIdentity();
  } finally { if (current()) { busy.value = false; busyKind.value = ''; if (identity.value === 'checking') await checkIdentity(); } }
}
onMounted(checkIdentity);
usePageLifecycle({
  hide() { ++identityVersion; identity.value = 'checking'; accountName.value = ''; stopCountdown(); },
  show() { if (!success.value) resumeCountdown(); if (!busy.value) void checkIdentity(); },
  auth() { if (!staticPreview && !busy.value) { clearSecrets(); void checkIdentity(); } },
  destroy() { alive = false; clearPrivate(); },
});
</script>

<template>
  <main class="page-body login-page account-login-page phone-login-page">
    <div class="login-topline">
    <span v-if="busy || identity === 'checking'" class="login-back" aria-disabled="true">‹ 正在确认，请稍候</span>
    <a v-else-if="returning && identity !== 'error'" class="login-back" :href="returning">‹ {{ returnLabel }}</a>
    <span v-else aria-hidden="true"></span>
    </div>
    <section class="login-brand"><div class="brand-mark" aria-hidden="true">慢</div><h1 class="brand-title">慢记</h1><p class="brand-caption">把值得记住的，慢慢讲下来。</p></section>
    <section class="login-actions" aria-label="手机号验证码登录">
      <div v-if="identity === 'member'" class="guest-account-note member-account-note" role="status"><p>您已登录：{{ accountName }}</p><a class="paper-link" :href="next">继续使用这个账号 →</a></div>
      <div v-if="guest" class="guest-account-note"><p>已有体验记录仍可返回预览。</p></div>
      <p v-if="identity === 'checking'" class="account-status" role="status">正在确认登录状态…</p>
      <div v-else-if="identityError" class="account-check-error" role="alert"><p>{{ identityError }}</p><button type="button" class="paper-link" @click="checkIdentity">重新确认</button></div>
      <section v-if="success" class="phone-login-success" data-testid="login-success" aria-labelledby="login-success-title">
        <div class="phone-success-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m8 16 5 5 11-11" /></svg></div>
        <h2 id="login-success-title" ref="successTitle" class="login-heading" tabindex="-1">验证完成</h2>
        <p class="login-note">{{ maskedPhone }} 已完成验证码校验。</p>
        <a class="btn btn-primary account-submit" href="./index.html?prototype=1" data-testid="prototype-home">进入首页<span aria-hidden="true">→</span></a>
        <button class="paper-link restart-demo" type="button" data-testid="restart-demo" @click="restartDemo">重新输入</button>
      </section>
      <template v-else>
      <h2 class="login-heading">手机号登录</h2>
      <p class="login-note">不用记密码，用验证码轻松登录。</p>
      <form class="account-form" data-testid="account-form" novalidate @submit.prevent="submitAccount">
        <div class="paper-field">
          <label class="paper-field-label" for="login-phone">手机号</label>
          <div class="phone-input-wrap" :class="{ 'field-invalid': errorField === 'phone' }"><span class="phone-prefix" aria-hidden="true">+86</span><input id="login-phone" ref="phoneInput" v-model="phone" class="paper-input" type="tel" name="phone" inputmode="numeric" autocomplete="tel-national" maxlength="11" placeholder="请输入手机号" :disabled="busy" :aria-invalid="errorField === 'phone'" :aria-describedby="errorField === 'phone' ? 'login-error' : undefined"></div>
        </div>
        <div class="paper-field">
          <label class="paper-field-label" for="login-code">验证码</label>
          <div class="code-input-wrap" :class="{ 'field-invalid': errorField === 'code' }"><input id="login-code" ref="codeInput" v-model="code" class="paper-input" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="请输入 6 位验证码" :disabled="busy" :aria-invalid="errorField === 'code'" :aria-describedby="errorField === 'code' ? 'login-error' : issuedPhone ? 'demo-code-hint' : undefined"><button class="send-code" type="button" data-testid="send-code" :disabled="disabled || remaining > 0" @click="sendCode">{{ remaining > 0 ? `${remaining} 秒后重发` : issuedPhone ? '重新获取' : '获取验证码' }}</button></div>
          <p v-if="issuedPhone" id="demo-code-hint" class="demo-code-hint" role="status">本次验证码：<strong>123456</strong><span>5 分钟内有效，无需查看短信。</span></p>
        </div>
        <p v-if="error" id="login-error" class="notice account-error" role="alert">{{ error }}</p>
        <button class="btn btn-primary account-submit" type="submit" :disabled="disabled">登录慢记<span aria-hidden="true">→</span></button>
      </form>
      </template>
      <p class="login-footnote prototype-note">验证码显示在本页，无需查看短信。</p>
      <details v-if="debug" class="developer-login"><summary>开发调试入口</summary>
        <p class="login-note">可使用已有登录凭证进入。</p>
        <form data-testid="developer-login-form" @submit.prevent="loginDeveloper">
          <input ref="fileInput" type="file" accept=".json,application/json" class="sr-only" tabindex="-1" :disabled="busy" data-testid="login-file" @change="readFile">
          <button class="btn btn-secondary" type="button" :disabled="busy" @click="fileInput?.click()">选择登录文件</button>
          <p class="login-file-status" role="status">{{ fileStatus }}</p>
          <div v-if="accounts.length > 1" class="paper-field"><label class="paper-field-label" for="account">选择测试账户</label><select id="account" v-model="account" class="paper-input" :disabled="busy" @change="chooseAccount"><option v-for="(item, index) in accounts" :key="index" :value="String(index)">{{ item.label }}</option></select></div>
          <div class="paper-field"><label class="paper-field-label" for="login-token">登录凭证</label><input id="login-token" v-model="token" class="paper-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256" placeholder="在这里粘贴 token" required :disabled="busy"></div>
          <p v-if="developerError" class="notice" role="alert">{{ developerError }}</p><button class="btn btn-primary" type="submit" :disabled="busy">{{ busyKind === 'developer' ? '正在验证…' : '使用测试凭证登录' }}</button>
        </form><p class="login-footnote">登录文件只在当前浏览器读取，不会上传。</p>
      </details>
    </section>
  </main>
</template>
