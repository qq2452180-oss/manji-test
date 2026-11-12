<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ensureIdentity } from '../lib/workflow-api.js';
import { loginUrl } from '../lib/workflow-navigation.js';
import { navigate, reloadPage } from '../lib/navigation.js';

const allowed = ref(false), error = ref('');
let alive = true, version = 0;
async function verify() {
  const epoch = ++version;
  allowed.value = false; error.value = '';
  try {
    await ensureIdentity();
    if (alive && epoch === version) allowed.value = true;
  } catch (cause) {
    if (!alive || epoch !== version) return;
    if (cause.status === 401) navigate(loginUrl(), { replace: true });
    else error.value = cause.message || '暂时无法确认登录状态，请重试。';
  }
}
function restored(event) { if (event.persisted) reloadPage(); }
onMounted(() => {
  void verify();
  window.addEventListener('manji:auth-changed', verify);
  window.addEventListener('pageshow', restored);
});
onBeforeUnmount(() => {
  alive = false; ++version;
  window.removeEventListener('manji:auth-changed', verify);
  window.removeEventListener('pageshow', restored);
});
</script>

<template>
  <slot v-if="allowed" />
  <main v-else class="paper-page app-shell">
    <div v-if="error" class="connected-notice connected-error" role="alert"><p>{{ error }}</p><button class="connected-retry" @click="verify">重新确认</button></div>
    <p v-else class="connected-notice" role="status">正在确认登录状态…</p>
  </main>
</template>
