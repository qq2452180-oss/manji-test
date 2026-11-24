<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getSmsCaptcha, sendSmsCode } from '../lib/api.js';
import { cooldownKey, readCooldown, readLatestCooldown, writeCooldown, SMS_LIMIT_LABELS } from '../lib/sms-cooldown.js';

const props = defineProps({
  disabled: Boolean,
  guest: Boolean,
  error: { type: String, default: '' },
});
const emit = defineEmits(['submit', 'clear-error']);
const phone = ref(''), code = ref('');
const phoneInput = ref(null), codeInput = ref(null);
const sendButton = ref(null), captchaDialog = ref(null);
const localError = ref(''), invalidField = ref('');
const sending = ref(false), lastSend = ref(null), now = ref(Date.now());
const captcha = ref(null), captchaAnswer = ref(''), captchaInput = ref(null);
const changingCaptcha = ref(false), captchaNotice = ref('');
const currentSend = computed(() => lastSend.value?.phone === phone.value.trim() ? lastSend.value : null);
const lastCooldown = ref(null);
const cooldown = computed(() => lastCooldown.value?.phone === phone.value.trim() ? lastCooldown.value : null);
const latestCooldown = ref(readLatestCooldown());
const displayedCooldown = computed(() => phone.value.trim() ? cooldown.value : latestCooldown.value);
const secondsLeft = computed(() => displayedCooldown.value
  ? Math.max(0, Math.ceil((displayedCooldown.value.retryAt - now.value) / 1000)) : 0);
const waitingToResend = computed(() => !!cooldown.value && secondsLeft.value > 0);
const dailyLimit = computed(() => secondsLeft.value && Object.hasOwn(SMS_LIMIT_LABELS, displayedCooldown.value.reason)
  ? SMS_LIMIT_LABELS[displayedCooldown.value.reason] : '');
const sendButtonLabel = computed(() => {
  if (sending.value) return '发送中…';
  if (waitingToResend.value) return dailyLimit.value ? '已达发送上限' : secondsLeft.value + ' 秒后重发';
  if (captcha.value) return '待图片验证';
  return currentSend.value ? '重新获取' : '获取验证码';
});
const retryDate = computed(() => dailyLimit.value ? new Date(displayedCooldown.value.retryAt).toLocaleString('zh-CN', {
  month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}) : '');
let timer, attempt = 0;
let storageKey = null, lookup = Promise.resolve();

function syncClock() {
  now.value = Date.now();
  if (now.value >= Math.max(currentSend.value?.expiresAt || 0, displayedCooldown.value?.retryAt || 0)) clearInterval(timer);
}
watch([currentSend, displayedCooldown], () => {
  clearInterval(timer);
  timer = setInterval(syncClock, 1000);
  syncClock();
}, { flush: 'sync', immediate: true });
function clearError() {
  localError.value = ''; invalidField.value = ''; captchaNotice.value = '';
  if (props.error) emit('clear-error');
}
function fail(message, field) {
  localError.value = message; invalidField.value = field;
  const input = { phone: phoneInput, code: codeInput, captcha: captchaInput }[field];
  input.value?.focus();
}
function validPhone() {
  if (/^1[3-9][0-9]{9}$/.test(phone.value.trim())) return true;
  fail('请输入正确的 11 位手机号。', 'phone');
  return false;
}
watch(phone, () => {
  const version = ++attempt, target = phone.value.trim();
  sending.value = false; storageKey = null;
  changingCaptcha.value = false; replaceCaptcha(null);
  code.value = ''; clearError(); syncClock();
  lookup = /^1[3-9][0-9]{9}$/.test(target) ? cooldownKey(target).then(key => {
    if (version !== attempt) return;
    storageKey = key;
    const saved = readCooldown(key);
    if (saved) lastCooldown.value = { phone: target, retryAt: saved.retryAt, reason: saved.reason };
  }) : Promise.resolve();
}, { flush: 'sync' });
watch(code, clearError, { flush: 'sync' });
watch(captchaAnswer, () => { if (invalidField.value === 'captcha') clearError(); }, { flush: 'sync' });

function replaceCaptcha(value) {
  if (!value && captchaDialog.value?.open) captchaDialog.value.close();
  captcha.value = value;
  captchaAnswer.value = '';
  if (value) nextTick(() => {
    const dialog = captchaDialog.value;
    if (!dialog || captcha.value?.id !== value.id) return;
    if (!dialog.open) dialog.showModal();
    if (!document.hidden) captchaInput.value?.focus();
  });
}

function dismissCaptcha() {
  if (sending.value) return;
  ++attempt;
  changingCaptcha.value = false;
  replaceCaptcha(null);
  clearError();
  nextTick(() => sendButton.value?.focus());
}

function setCooldown(target, seconds, reason = 'SMS_COOLDOWN') {
  const retryAt = Date.now() + seconds * 1000;
  lastCooldown.value = { phone: target, retryAt, reason };
  latestCooldown.value = reason === 'SMS_IP_LIMIT' ? null : lastCooldown.value;
  writeCooldown(storageKey, reason, retryAt);
}
function applyRetryDelay(target, error) {
  const reason = error.code === 'SMS_DELIVERY_FAILED' ? error.details?.rate_limit_code || 'SMS_COOLDOWN' : error.code;
  const seconds = error.details?.retry_after;
  if ((error.status !== 429 && error.code !== 'SMS_DELIVERY_FAILED') || !Number.isSafeInteger(seconds) || seconds <= 0
    || (reason !== 'SMS_COOLDOWN' && !Object.hasOwn(SMS_LIMIT_LABELS, reason))) return false;
  setCooldown(target, seconds, reason);
  return true;
}
async function changeCaptcha() {
  if (!captcha.value || props.disabled || changingCaptcha.value || sending.value) return;
  const version = attempt, target = phone.value.trim();
  clearError();
  changingCaptcha.value = true;
  try {
    const replacement = await getSmsCaptcha(target);
    if (version === attempt) replaceCaptcha(replacement);
  } catch (error) {
    if (version !== attempt) return;
    if (error.code === 'SMS_CAPTCHA_NOT_REQUIRED') {
      replaceCaptcha(null);
      captchaNotice.value = '现在可以直接获取短信验证码。';
    } else if (applyRetryDelay(target, error)) {
      replaceCaptcha(null);
    } else {
      localError.value = error.message || '图片验证码暂时无法更换，请重试。';
    }
  } finally {
    if (version === attempt) changingCaptcha.value = false;
  }
}
async function send() {
  syncClock();
  if (props.disabled || sending.value || changingCaptcha.value || waitingToResend.value || !validPhone()) return;
  const version = attempt, target = phone.value.trim();
  clearError();
  if (captcha.value && !/^[0-9]{4}$/.test(captchaAnswer.value)) {
    fail('请输入图片中的 4 位数字。', 'captcha');
    return;
  }
  sending.value = true;
  try {
    await lookup;
    syncClock();
    if (version !== attempt || props.disabled || waitingToResend.value) return;
    const result = captcha.value
      ? await sendSmsCode(target, { id: captcha.value.id, answer: captchaAnswer.value })
      : await sendSmsCode(target);
    if (version !== attempt) return;
    replaceCaptcha(null);
    lastSend.value = { phone: target, expiresAt: Date.now() + result.expires_in * 1000 };
    setCooldown(target, result.retry_after, result.rate_limit_code);
    code.value = '';
  } catch (error) {
    if (version !== attempt) return;
    if (error.code === 'SMS_CAPTCHA_REQUIRED' || error.code === 'SMS_CAPTCHA_INVALID') {
      replaceCaptcha(error.details.captcha);
      if (error.code === 'SMS_CAPTCHA_INVALID') {
        invalidField.value = 'captcha';
        localError.value = '图片验证码有误或已过期，请输入新图片中的 4 位数字。';
      }
      return;
    }
    replaceCaptcha(null);
    if (applyRetryDelay(target, error)) {
      if (error.status === 429) return;
    } else {
      // A failed request without a retry delay supersedes the previous phone's hint.
      setCooldown(target, 0);
    }
    localError.value = error.message || '验证码发送失败，请稍后再试。';
    return;
  } finally {
    if (version === attempt) sending.value = false;
  }
  await nextTick();
  if (version === attempt && !document.hidden) codeInput.value?.focus();
}
function submit() {
  if (props.disabled || sending.value || captcha.value) return;
  clearError();
  if (!validPhone()) return;
  if (!/^[0-9]{6}$/.test(code.value)) {
    fail('请输入 6 位数字验证码。', 'code');
    return;
  }
  emit('submit', phone.value.trim(), code.value);
}
function resetIdentity() {
  ++attempt; sending.value = false;
  changingCaptcha.value = false; replaceCaptcha(null);
  latestCooldown.value = null;
  lastCooldown.value = null; lastSend.value = null; phone.value = ''; code.value = ''; clearError(); syncClock();
}
onMounted(() => {
  document.addEventListener('visibilitychange', syncClock);
  window.addEventListener('manji:auth-changed', resetIdentity);
});
onBeforeUnmount(() => {
  ++attempt;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', syncClock);
  window.removeEventListener('manji:auth-changed', resetIdentity);
});
</script>

<template>
  <form class="account-form" novalidate @submit.prevent="submit">
    <div class="paper-field">
      <label class="paper-field-label" for="login-phone">手机号</label>
      <div class="phone-input-wrap" :class="{ 'field-invalid': invalidField === 'phone' }">
        <span class="phone-prefix" aria-label="中国大陆区号">+86</span>
        <input id="login-phone" ref="phoneInput" v-model="phone" name="phone" class="paper-input" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="11" placeholder="请输入 11 位手机号" required :disabled="disabled" :aria-invalid="invalidField === 'phone'" :aria-describedby="invalidField === 'phone' ? 'sms-login-error' : undefined">
      </div>
    </div>
    <div class="paper-field">
      <label class="paper-field-label" for="login-code">短信验证码</label>
      <div class="code-input-wrap" :class="{ 'field-invalid': invalidField === 'code' }">
        <input id="login-code" ref="codeInput" v-model="code" name="code" class="paper-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="请输入 6 位验证码" required :disabled="disabled || sending" :aria-invalid="invalidField === 'code'" :aria-describedby="invalidField === 'code' || error ? 'sms-login-error' : undefined">
        <button ref="sendButton" type="button" class="send-code" data-testid="send-code" :disabled="disabled || sending || waitingToResend || !!captcha" @click="send">{{ sendButtonLabel }}</button>
      </div>
      <p v-if="currentSend && now >= currentSend.expiresAt" class="sms-send-status" role="status">上次发送的验证码已过期。</p>
      <p v-if="dailyLimit" class="sms-send-status" role="status">{{ cooldown ? dailyLimit : '上次使用的手机号近 24 小时的验证码发送次数已达上限' }}，可于 {{ retryDate }} 重新获取。</p>
      <p v-else-if="secondsLeft && !cooldown" class="sms-send-status" role="timer">上次使用的手机号可在 {{ secondsLeft }} 秒后重新获取验证码。</p>
      <p v-if="captchaNotice" class="sms-send-status" role="status">{{ captchaNotice }}</p>
    </div>
    <p v-if="!captcha && (localError || error)" id="sms-login-error" class="notice account-error" role="alert">{{ localError || error }}</p>
    <p v-if="guest" class="guest-account-note">手机登录会打开该手机号的账号。要保留当前访谈和故事，请选择“注册并保留我的故事”。</p>
    <button type="submit" class="btn btn-primary account-submit" :disabled="disabled || sending">{{ disabled ? '正在登录…' : '登录' }}</button>
  </form>
  <dialog v-if="captcha" ref="captchaDialog" class="dialog sms-captcha" aria-labelledby="sms-captcha-title"
    @cancel.prevent="dismissCaptcha" @click.self="dismissCaptcha">
    <form class="captcha-content" novalidate @submit.prevent="send">
      <header class="dialog-header">
        <h2 id="sms-captcha-title">图片验证码</h2>
        <button type="button" aria-label="关闭" :disabled="sending" @click="dismissCaptcha">×</button>
      </header>
      <div class="captcha-image-row">
        <img :src="captcha.image" width="168" height="60" alt="图片验证码">
        <button type="button" class="paper-link" :disabled="disabled || sending || changingCaptcha" @click="changeCaptcha">{{ changingCaptcha ? '正在换图…' : '换一张' }}</button>
      </div>
      <input id="login-captcha" ref="captchaInput" v-model="captchaAnswer" class="paper-input" name="captcha"
        type="text" inputmode="numeric" autocomplete="off" maxlength="4" aria-label="图中的 4 位数字" placeholder="请输入图中的 4 位数字"
        :disabled="disabled || sending || changingCaptcha" :aria-invalid="invalidField === 'captcha'"
        :aria-describedby="localError ? 'sms-captcha-error' : undefined" @keydown.enter.prevent="send">
      <p v-if="localError" id="sms-captcha-error" class="notice" role="alert">{{ localError }}</p>
      <button type="submit" class="btn btn-primary" :disabled="disabled || sending || changingCaptcha">{{ sending ? '发送中…' : '验证并发送短信' }}</button>
    </form>
  </dialog>
</template>

<style scoped>
.sms-send-status { margin-top: 8px; color: #776d64; font-size: 14px; line-height: 1.6; }
.sms-captcha { width: min(340px, calc(100% - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; box-shadow: 0 16px 48px #34251d33; }
.sms-captcha::backdrop { background: #261e1880; }
.captcha-content { display: grid; gap: 14px; padding: 20px; }
.captcha-content .dialog-header { margin: 0; }
.captcha-content h2 { margin: 0; font-size: 22px; }
.captcha-content .dialog-header button { font-size: 24px; line-height: 1; }
.captcha-content .notice { margin: 0; }
.captcha-content .paper-input[aria-invalid="true"] { border-color: #b4523e; }
.captcha-image-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.captcha-image-row img { display: block; width: 168px; max-width: 100%; height: auto; border: 1px solid #d9cdbf; border-radius: 8px; }
</style>
