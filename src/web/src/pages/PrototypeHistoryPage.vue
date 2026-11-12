<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { prototypeChapters } from '../lib/life-map-topics.js';
import { prototypeHomeUrl, prototypeHistoryUrl, prototypeInterviewUrl, prototypeOrganizingUrl, prototypeStoryUrl, prototypeSource } from '../lib/prototype-topic.js';
import { usePrototypeState, resolvePrototypeSession, getPrototypeSessionTurns } from '../lib/prototype-state.js';
import '../styles/prototype-history.css';

const state = usePrototypeState();
const search = ref(location.search), refreshVersion = ref(0);
const detailMode = computed(() => new URLSearchParams(search.value).has('session_id'));
const session = computed(() => { state.value; refreshVersion.value; return detailMode.value ? resolvePrototypeSession(search.value) : null; });
const timestamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const sessions = computed(() => [...state.value.sessions].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt)));
function topicFor(current) {
  const chapter = prototypeChapters.find(item => item.id === current?.chapterId);
  const content = chapter?.core_contents.find(item => item.id === current?.contentId);
  return { chapter, content, title: current?.freeTalk ? '随便聊聊' : content?.title || '讲述记录' };
}
const topic = computed(() => topicFor(session.value));
const storyBack = computed(() => {
  const params = new URLSearchParams(search.value), current = session.value;
  if (!current || params.getAll('back').length !== 1 || params.get('back') !== 'story') return null;
  const story = state.value.stories.find(item => item.id === current.storyId
    && item.chapter_id === current.chapterId && item.content_id === current.contentId);
  if (!story) return null;
  const returnSessionId = params.getAll('return_session_id').length === 1 ? params.get('return_session_id') : '';
  const returnSession = returnSessionId ? resolvePrototypeSession(new URLSearchParams({
    session_id: returnSessionId, story_id: story.id, chapter_id: story.chapter_id, content_id: story.content_id,
  })) : null;
  return { label: '返回故事', href: prototypeStoryUrl(story.chapter_id, story.content_id, {
    storyId: story.id, from: prototypeSource(search.value),
    sessionId: returnSession?.status === 'complete' ? returnSession.id : undefined,
  }) };
});
const back = computed(() => storyBack.value || (detailMode.value
  ? { label: '返回讲述记录', href: prototypeHistoryUrl() }
  : { label: '返回我的', href: './profile.html?prototype=1' }));
const turns = computed(() => {
  const current = session.value;
  if (!current) return [];
  return getPrototypeSessionTurns(current);
});
const labels = { running: '讲述中', paused: '已暂停', organizing: '整理中', complete: '已整理' };
const onward = computed(() => {
  const current = session.value;
  if (!current) return null;
  if (current.status === 'organizing') return { label: '查看整理进度', href: prototypeOrganizingUrl(current.id, { from: 'history' }) };
  if (current.status === 'complete') {
    if (storyBack.value) return { label: '查看故事', href: storyBack.value.href };
    const story = state.value.stories.find(item => item.id === current.storyId);
    return { label: '查看故事', href: prototypeStoryUrl(story?.chapter_id || current.chapterId, story?.content_id || current.contentId,
      { storyId: current.storyId, sessionId: current.id, from: 'history' }) };
  }
  return { label: '继续讲述', href: prototypeInterviewUrl(current.freeTalk ? undefined : current.chapterId, current.freeTalk ? undefined : current.contentId, { sessionId: current.id, from: 'history' }) };
});
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function refresh() { search.value = location.search; refreshVersion.value++; }
onMounted(() => { document.title = '慢记 · 讲述记录'; refresh(); window.addEventListener('pageshow', refresh); });
onBeforeUnmount(() => window.removeEventListener('pageshow', refresh));
</script>

<template>
  <main class="prototype-history" data-testid="prototype-history-page">
    <header class="prototype-history-header">
      <a :href="back.href"><span aria-hidden="true">‹</span> {{ back.label }}</a>
      <span v-if="detailMode && session">{{ session.turns ? '话题讲述' : '讲述记录' }}</span>
    </header>
    <div class="prototype-history-content">
      <template v-if="!detailMode">
        <h1>讲述记录</h1>
        <div v-if="sessions.length" class="prototype-history-list">
          <a v-for="item in sessions" :key="item.id" class="prototype-history-row" :href="prototypeHistoryUrl(item.id)" :data-testid="`history-session-${item.id}`">
            <div class="prototype-history-row-copy"><span class="prototype-history-row-title">{{ topicFor(item).title }}</span><span class="prototype-history-row-meta">{{ labels[item.status] }}<span aria-hidden="true"> · </span>{{ dateLabel(item.updatedAt) }}</span></div>
            <span class="prototype-history-arrow" aria-hidden="true">→</span>
          </a>
        </div>
        <section v-else class="prototype-history-empty"><p>还没有讲述记录</p><a class="prototype-history-action" :href="prototypeHomeUrl()">去人生轨迹</a></section>
      </template>
      <section v-else-if="!session" class="prototype-history-empty is-invalid"><h1>暂时找不到这段讲述</h1><a class="prototype-history-action" :href="prototypeHistoryUrl()">返回讲述记录</a></section>
      <template v-else>
        <p v-if="topic.chapter && !session.freeTalk" class="prototype-history-chapter" data-testid="selected-chapter">{{ topic.chapter.title }}</p>
        <h1 :data-testid="topic.content && !session.freeTalk ? 'selected-fragment' : undefined">{{ topic.title }}</h1>
        <p class="prototype-history-meta">{{ labels[session.status] }}<span aria-hidden="true"> · </span>{{ dateLabel(session.updatedAt) }}</p>
        <div class="prototype-history-turns" aria-label="讲述内容">
          <article v-for="(turn, index) in turns" :key="index" class="prototype-history-turn" :class="{ 'is-user': turn.role === 'user' }" :data-testid="`history-turn-${index}`"><span>{{ turn.role === 'assistant' ? '小暖' : '我' }}</span><p>{{ turn.text }}</p></article>
        </div>
        <footer v-if="onward" class="prototype-history-actions"><a class="prototype-history-action" :href="onward.href" data-testid="history-continue">{{ onward.label }}</a></footer>
      </template>
    </div>
  </main>
</template>
