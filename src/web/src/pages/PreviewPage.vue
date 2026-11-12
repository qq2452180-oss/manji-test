<script setup>
import { onMounted, ref } from 'vue';
import * as api from '../lib/api.js';
import { navigate } from '../lib/navigation.js';
import { requireMember, usePageLifecycle } from '../composables/page.js';
import PageHeader from '../components/PageHeader.vue';
import SiteNav from '../components/SiteNav.vue';
import '../styles/preview.css';
const kind = new URLSearchParams(location.search).get('kind');
const redirect = Boolean(kind && kind !== 'family');
const member = ref(false), loading = ref(true), error = ref('');
let version = 0, alive = true, visible = !document.hidden;
function clear() { ++version; member.value = false; loading.value = true; error.value = ''; }
async function loadMember() {
  if (!alive || !visible) return;
  clear();
  const request = version, token = api.getAuthToken();
  const current = () => alive && visible && request === version && token === api.getAuthToken();
  try {
    const user = await requireMember({ isCurrent: current });
    if (!current() || !user) return;
    member.value = true;
    if (redirect) navigate('./interview.html?new=1' + (kind === 'photo' ? '&entry=PHOTO' : kind === 'text' ? '&interaction=text' : ''), { replace: true });
  } catch (_) {
    if (current()) error.value = '暂时无法确认账号，请检查网络后重试。';
  } finally { if (current()) loading.value = false; }
}
onMounted(loadMember);
usePageLifecycle({
  hide() { visible = false; clear(); },
  show() { visible = true; void loadMember(); },
  auth() { clear(); void loadMember(); },
  destroy() { alive = false; visible = false; clear(); },
});
</script>

<template>
  <template v-if="member && !redirect"><PageHeader title="家人" back="" /><main class="page-body has-nav preview-page"><section class="reading-sheet family-sheet"><p class="kicker">一家人的记忆</p><h1 class="reading-sheet-title">有些往事，<span class="line">可以一起想起来。</span></h1><p class="aux-text family-description">以后，你可以邀请家人一起补充那些珍贵的片段。</p><p class="family-empty">家人功能后续开放</p></section></main><SiteNav active="family" /></template>
  <main v-else class="page-body">
    <div v-if="error" class="paper-state" role="alert"><p>{{ error }}</p><button class="paper-link" type="button" @click="loadMember">重新确认</button></div>
    <p v-else class="paper-state paper-muted" role="status">{{ loading ? '正在确认账号…' : member && redirect ? '正在打开访谈…' : '正在打开登录…' }}</p>
  </main>
</template>
