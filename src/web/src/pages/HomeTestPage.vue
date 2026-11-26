<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import DecadeSelection from '../components/DecadeSelection.vue';
import ChapterTopics from '../components/ChapterTopics.vue';
import catalogs from '../content/home-test-catalog.json';
import '../styles/prototype-home.css';
import '../styles/prototype-nav.css';
import '../styles/home-test.css';

const storageKey = 'manji.home-test.selection.v1';
const navigation = [
  { key: 'map', label: '人生轨迹' },
  { key: 'book', label: '传记' },
  { key: 'xiaonuan', label: '小暖' },
  { key: 'family', label: '家人' },
  { key: 'profile', label: '我的' },
];
function readSelection() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && [50, 60, 70].includes(saved.birthDecade)
      && (saved.occupation === null || typeof saved.occupation === 'string')) return saved;
  } catch (_) { /* The preview also works when browser storage is unavailable. */ }
  return null;
}
const selection = ref(readSelection());
const heading = ref(null), dialog = ref(null), preview = ref(null);
const chapters = computed(() => (catalogs[selection.value?.birthDecade] || []).map(chapter => ({
  ...chapter, core_contents: chapter.topics,
})));
const currentChapter = computed(() => selection.value?.chapterId || chapters.value[0]?.id || '');
function persist() {
  try {
    if (selection.value) sessionStorage.setItem(storageKey, JSON.stringify(selection.value));
    else sessionStorage.removeItem(storageKey);
  } catch (_) { /* Keep the current in-memory preview usable. */ }
}
async function confirmSelection(value) {
  if (selection.value || ![50, 60, 70].includes(value.birthDecade)) return;
  selection.value = { birthDecade: value.birthDecade, occupation: value.occupation || null };
  persist();
  await nextTick();
  heading.value?.focus();
}
async function resetTest() {
  dialog.value?.close();
  preview.value = null;
  selection.value = null;
  persist();
  await nextTick();
  heading.value?.focus();
}
function selectChapter(id) {
  if (!selection.value || !chapters.value.some(chapter => chapter.id === id)) return;
  selection.value = { ...selection.value, chapterId: id };
  persist();
}
async function showPreview(value) {
  preview.value = value;
  await nextTick();
  dialog.value?.showModal();
}
function selectTopic({ chapterId, contentId }) {
  const topic = chapters.value.find(chapter => chapter.id === chapterId)?.topics.find(item => item.id === contentId);
  if (topic) void showPreview({ title: topic.title, description: topic.description, topic: true });
}
function previewNavigation(item) {
  if (item.key === 'map') {
    dialog.value?.close();
    heading.value?.focus();
    return;
  }
  void showPreview({ title: item.label, description: '本测试页用于体验主人公资料选择和话题浏览。', topic: false });
}
onMounted(() => { document.title = '慢记 · 主页测试'; });
</script>

<template>
  <aside class="home-test-toolbar" aria-label="测试页工具">
    <div><strong>免登录测试</strong><span>选择仅保存在当前标签页</span></div>
    <button v-if="selection" type="button" @click="resetTest">重新测试</button>
  </aside>
  <main class="prototype-home connected-home" :class="{ 'is-choosing-profile': !selection }" data-testid="home-test-page">
    <header class="prototype-home-header"><a class="prototype-brand" href="./home-test.html"><svg class="prototype-time-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true"><circle cx="14" cy="14" r="10"/><path d="M14 8v6l4 3" /></svg>慢记</a><span v-if="!selection" class="prototype-home-section">人生轨迹</span></header>
    <section class="prototype-home-intro"><h1 ref="heading" tabindex="-1">{{ selection ? '人生轨迹' : '主人公资料' }}</h1></section>
    <DecadeSelection v-if="!selection" @confirm="confirmSelection" />
    <section v-else aria-label="我的年代话题">
      <div class="decade-current"><span>主人公：<strong>{{ selection.birthDecade }} 后<span v-if="selection.occupation"> · {{ selection.occupation }}</span></strong></span></div>
      <p v-if="selection.occupation" class="home-test-note">本页展示年代基础话题，职业补题不在测试页生成。</p>
      <ChapterTopics :chapters="chapters" :initial-chapter-id="currentChapter" @chapter-change="selectChapter" @select="selectTopic" />
    </section>
    <dialog ref="dialog" class="home-test-dialog" aria-labelledby="home-test-dialog-title">
      <template v-if="preview">
        <span class="home-test-dialog-label">{{ preview.topic ? '话题预览' : '免登录测试' }}</span>
        <h2 id="home-test-dialog-title">{{ preview.title }}</h2>
        <p>{{ preview.description }}</p>
        <p v-if="preview.topic" class="home-test-note">正式讲述不在本测试页启动。</p>
        <button type="button" autofocus @click="dialog.close()">返回测试页</button>
      </template>
    </dialog>
  </main>
  <nav class="prototype-nav home-test-nav" aria-label="主导航">
    <button v-for="item in navigation" :key="item.key" type="button" class="prototype-nav-item"
      :class="{ 'is-current': item.key === 'map', 'prototype-nav-xiaonuan': item.key === 'xiaonuan' }"
      :aria-current="item.key === 'map' ? 'page' : undefined" :aria-label="item.key === 'xiaonuan' ? '和小暖聊聊' : undefined"
      @click="previewNavigation(item)">
      <span class="prototype-nav-symbol"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path v-if="item.key === 'map'" d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16" />
        <path v-else-if="item.key === 'book'" d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 14h14M7 3v14m3-9h5m-5 4h5" />
        <path v-else-if="item.key === 'xiaonuan'" d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4" />
        <template v-else-if="item.key === 'family'"><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20v-1.5a6.5 6.5 0 0 1 13 0V20M16 5a3 3 0 0 1 0 6m2 2a5.5 5.5 0 0 1 3.5 5.2V20" /></template>
        <template v-else><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-1.5a5.5 5.5 0 0 1 5.5-5.5h3a5.5 5.5 0 0 1 5.5 5.5V20" /></template>
      </svg></span><span>{{ item.label }}</span>
    </button>
  </nav>
</template>
