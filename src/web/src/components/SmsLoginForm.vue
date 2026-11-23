<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { sendSmsCode } from '../lib/api.js';

const props = defineProps({
  disabled: Boolean,
  guest: Boolean,
  error: { type: String, default: '' },
});
const emit = defineEmits(['submit', 'clear-error']);
const phone = ref(''), code = ref('');
const phoneInput = ref(null), codeInput = ref(null);
const localError = ref(''), invalidField = ref('');
const sending = ref(false), lastSend = ref(null), now = ref(Date.now());
const currentSend = computed(() => lastSend.value?.phone === phone.value.trim() ? lastSend.value : null);
const remaining = computed(() => currentSend.value ? Math.max(0, Math.ceil((currentSend.value.retryAt - now.value) / 1000)) : 0);
const sendStatus = computed(() => {
  if (!currentSend.value) return '';
  if (now.value >= currentSend.value.expiresAt) return '上次发送的验证码已过期，可以重新获取。';
  return '验证码已发送至尾号 ' + currentSend.value.phone.slice(-4) + ' 的手机。';
});
let timer, attempt = 0;

function syncClock() {
  now.value = Date.now();
  if (!lastSend.value || now.value >= Math.max(lastSend.value.expiresAt, lastSend.value.retryAt)) clearInterval(timer);
}
function clearError() {
  localError.value = ''; invalidField.value = '';
  if (props.error) emit('clear-error');
}
function fail(message, field) {
  localError.value = message; invalidField.value = field;
  (field === 'phone' ? phoneInput : codeInput).value?.focus();
}
function validPhone() {
  if (/^1[3-9][0-9]{9}$/.test(phone.value.trim())) return true;
  fail('请输入正确的 11 位手机号。', 'phone');
  return false;
}
watch(phone, () => {
  ++attempt; sending.value = false;
  code.value = ''; clearError(); syncClock();
}, { flush: 'sync' });
watch(code, clearError, { flush: 'sync' });

async function send() {
  syncClock();
  if (props.disabled || sending.value || remaining.value) return;
  clearError();
  if (!validPhone()) return;
  const target = phone.value.trim();
  const version = ++attempt;
  sending.value = true;
  try {
    const { retry_after, expires_in } = await sendSmsCode(target);
    if (version !== attempt) return;
    now.value = Date.now();
    lastSend.value = { phone: target, retryAt: now.value + retry_after * 1000, expiresAt: now.value + expires_in * 1000 };
    clearInterval(timer);
    timer = setInterval(syncClock, 1000);
    code.value = '';
  } catch (error) {
    if (version === attempt) localError.value = error.message || '验证码发送失败，请稍后再试。';
    return;
  } finally {
    if (version === attempt) sending.value = false;
  }
  await nextTick();
  if (version === attempt && !document.hidden) codeInput.value?.focus();
}
function submit() {
  if (props.disabled || sending.value) return;
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
  lastSend.value = null; phone.value = ''; code.value = ''; clearError(); syncClock();
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
      <label class="paper-field-label" for="login-code">验证码</label>
      <div class="code-input-wrap" :class="{ 'field-invalid': invalidField === 'code' }">
        <input id="login-code" ref="codeInput" v-model="code" name="code" class="paper-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="请输入 6 位验证码" required :disabled="disabled || sending" :aria-invalid="invalidField === 'code'" :aria-describedby="invalidField === 'code' || error ? 'sms-login-error' : undefined">
        <button type="button" class="send-code" data-testid="send-code" :disabled="disabled || sending || remaining > 0" @click="send">{{ sending ? '发送中…' : remaining ? remaining + ' 秒后重发' : currentSend ? '重新获取' : '获取验证码' }}</button>
      </div>
      <p v-if="sendStatus" class="sms-send-status" role="status">{{ sendStatus }}</p>
    </div>
    <p v-if="localError || error" id="sms-login-error" class="notice account-error" role="alert">{{ localError || error }}</p>
    <p v-if="guest" class="guest-account-note">手机登录会打开该手机号的账号。要保留当前访谈和故事，请选择“注册并保留我的故事”。</p>
    <button type="submit" class="btn btn-primary account-submit" :disabled="disabled || sending">{{ disabled ? '正在登录…' : '登录慢记' }}</button>
  </form>
</template>

<style scoped>
.sms-send-status { margin-top: 8px; color: #776d64; font-size: 14px; line-height: 1.6; }
</style>
