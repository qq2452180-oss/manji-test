<script setup>
import { onMounted, ref } from 'vue';
import { usePageLifecycle } from '../composables/page.js';
import { entryUrl, firstVisitStartUrl, markWelcomeShown, resolveEntry } from '../lib/first-visit.js';
import { navigate } from '../lib/navigation.js';
import '../styles/welcome.css';

const phase = ref('checking'), error = ref(''), startUrl = ref(firstVisitStartUrl());
let alive = true, visible = !document.hidden, version = 0;
const lines = [
  '你好，我是小暖。',
  '我是一个用聊天的方式，帮您记录人生故事的语音伙伴。',
  '您讲，我听；讲过的话，我会帮您整理成一本书。',
];
// Match the live captions' fallback reading pace, without starting media.
const readingTime = text => Math.max(400, Math.min(3000, Array.from(text).length * 180));
const delays = [0, readingTime(lines[0]), readingTime(lines[0]) + readingTime(lines[1])];

async function checkEntry() {
  if (!alive || !visible) return;
  const request = ++version;
  phase.value = 'checking'; error.value = '';
  const current = () => alive && visible && request === version;
  try {
    const context = await resolveEntry({ isCurrent: current });
    if (!context || !current()) return;
    if (context.destination !== 'welcome') { navigate(entryUrl(context), { replace: true }); return; }
    markWelcomeShown(); startUrl.value = firstVisitStartUrl(); phase.value = 'welcome';
  } catch (_) {
    if (current()) { phase.value = 'error'; error.value = '暂时连接不上，请检查网络后再试。'; }
  }
}
usePageLifecycle({
  hide() { visible = false; ++version; phase.value = 'checking'; },
  show() { visible = true; void checkEntry(); },
  auth() { ++version; phase.value = 'checking'; if (visible) void checkEntry(); },
  destroy() { alive = false; visible = false; ++version; },
});
onMounted(checkEntry);
</script>

<template>
  <main v-if="phase === 'welcome'" class="intro-page welcome-page">
    <section class="intro-main" aria-labelledby="welcome-title">
      <div class="welcome-lines">
        <h1 id="welcome-title" class="welcome-line" :style="{ '--reveal-delay': delays[0] + 'ms' }">{{ lines[0] }}</h1>
        <p v-for="(line, index) in lines.slice(1)" :key="line" class="intro-copy welcome-line" :style="{ '--reveal-delay': delays[index + 1] + 'ms' }">{{ line }}</p>
      </div>
    </section>
    <footer class="intro-actions"><a class="btn btn-primary intro-primary" :href="startUrl">开始</a></footer>
  </main>
  <main v-else class="intro-page intro-loading" :aria-busy="phase === 'checking'">
    <template v-if="phase === 'error'"><p class="intro-error" role="alert">{{ error }}</p><button class="btn btn-primary intro-primary" type="button" @click="checkEntry">重试</button></template>
    <p v-else role="status">正在准备…</p>
  </main>
</template>
