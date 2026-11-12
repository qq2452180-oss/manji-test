<script setup>
import { computed, onMounted, ref, shallowRef } from 'vue';
import * as api from '../lib/api.js';
import { savedMessages } from '../lib/messages.js';
import { navigate } from '../lib/navigation.js';
import { loginUrl, requireUser, formatDate, usePageLifecycle } from '../composables/page.js';
import PageHeader from '../components/PageHeader.vue';
import PrivatePhoto from '../components/PrivatePhoto.vue';
import '../styles/history.css';

const id = new URLSearchParams(location.search).get('session_id') || '';
const session = shallowRef(null), status = ref('正在翻开访谈记录…'), retry = ref(false);
let request = 0, visible = !document.hidden, disposed = false;
const messages = computed(() => session.value ? savedMessages(session.value) : []);
const metadata = computed(() => {
  const value = session.value;
  if (!value) return '';
  const progress = value.activity_state === 'FINISHING' ? '正在保存并整理' : { ACTIVE: '还没讲完', COMPLETED: '已结束', CANCELLED: '已取消' }[value.status] || '已保存';
  return `${value.mode === 'PHOTO' ? '照片访谈' : '对话访谈'} · ${progress} · ${formatDate(value.started_at)}`;
});
const onward = computed(() => {
  if (!session.value) return null;
  if (session.value.activity_state === 'FINISHING' || session.value.status === 'COMPLETED') return { text: '查看整理结果', href: `./organizing.html?session_id=${encodeURIComponent(id)}` };
  if (session.value.status === 'ACTIVE' && session.value.flow_version === 'interview') return { text: '继续聊', href: `./interview.html?session_id=${encodeURIComponent(id)}` };
  return null;
});
function clear() { request++; session.value = null; status.value = '正在翻开访谈记录…'; retry.value = false; }
async function load() {
  if (!visible || disposed) return;
  clear();
  const version = ++request, token = api.getAuthToken();
  const current = () => visible && !disposed && version === request && token === api.getAuthToken();
  try {
    if (!await requireUser() || !current()) return;
    if (!id) throw new Error('没有找到要查看的访谈，请从首页重新进入。');
    const value = await api.getSession(id);
    if (!current()) return;
    if (!value || value.session_id !== id) throw new Error('访谈记录不完整，请重试。');
    session.value = value;
    status.value = messages.value.length ? '' : '这次访谈还没有保存对话。';
  } catch (error) { if (current()) { status.value = error.message || '暂时无法打开访谈记录。'; retry.value = true; } }
}
usePageLifecycle({ hide() { visible = false; clear(); }, show() { visible = true; void load(); },
  auth() { disposed = true; visible = false; clear(); navigate(loginUrl(), { replace: true }); },
  destroy() { disposed = true; visible = false; clear(); } });
onMounted(load);
</script>

<template>
  <PageHeader title="访谈记录" />
  <main class="page-body transcript-page">
    <header class="transcript-heading"><span class="transcript-kicker">访谈记录</span><h1 class="reading-sheet-title">我们聊过的话</h1><p class="transcript-meta">{{ metadata }}</p></header>
    <p class="paper-muted" role="status">{{ status }}</p><button v-if="retry" class="paper-link" @click="load">重新加载</button>
    <div class="chat-messages"><article v-for="message in messages" :key="message.id" class="chat-message" :class="{ 'from-user': message.role === 'user' }"><span class="chat-speaker">{{ message.role === 'user' ? '我' : '小暖' }}</span>
      <div v-if="message.photos.length" class="photo-strip"><PrivatePhoto v-for="(mediaId, index) in message.photos" :key="mediaId" :media-id="mediaId" :index="index" /></div>
      <p v-if="message.text" class="chat-bubble">{{ message.text }}</p><span v-if="message.state" class="chat-caption">{{ message.state }}</span>
    </article></div>
    <p v-if="messages.length" class="transcript-footnote">这里只展示已经保存的讲述和回复。</p><div class="paper-footer"><a v-if="onward" class="paper-button" :href="onward.href">{{ onward.text }}</a><a class="paper-button secondary" href="./index.html">返回首页</a></div>
  </main>
</template>
