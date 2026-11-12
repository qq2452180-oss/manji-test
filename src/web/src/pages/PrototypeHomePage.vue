<script setup>
import { computed, onMounted, ref } from 'vue';
import ChapterTopics from '../components/ChapterTopics.vue';
import PrototypeNav from '../components/PrototypeNav.vue';
import { lifeMapChapters } from '../lib/life-map-topics.js';
import { navigate } from '../lib/navigation.js';
import { prototypeHomeUrl, prototypeInterviewUrl, prototypeStoryUrl } from '../lib/prototype-topic.js';
import { getPrototypeStories } from '../lib/prototype-stories.js';
import { usePrototypeState, selectPrototypeChapter } from '../lib/prototype-state.js';
import '../styles/prototype-home.css';

const state = usePrototypeState();
const requestedChapterId = new URLSearchParams(location.search).get('chapter_id') || state.value.selectedChapterId;
const initialChapterId = lifeMapChapters.find(chapter => chapter.id === requestedChapterId)?.id || lifeMapChapters[0].id;
const error = ref('');
function selectChapter(chapterId) {
  history.replaceState(history.state, '', prototypeHomeUrl(chapterId));
  try { selectPrototypeChapter(chapterId); error.value = ''; }
  catch (cause) { error.value = cause.message; }
}
const toldTopics = computed(() => state.value.stories.map(story => ({ chapterId: story.chapter_id, contentId: story.content_id })));
onMounted(() => { document.title = '慢记 · 人生轨迹'; selectChapter(initialChapterId); });
function selectTopic({ chapterId, contentId }) {
  const target = getPrototypeStories(chapterId, contentId).length
    ? prototypeStoryUrl(chapterId, contentId)
    : prototypeInterviewUrl(chapterId, contentId);
  if (!target) return;
  // Keep the chosen chapter when the browser returns to this home entry.
  history.replaceState(history.state, '', prototypeHomeUrl(chapterId));
  navigate(target);
}
</script>

<template>
  <main class="prototype-home" data-testid="prototype-home-page">
    <header class="prototype-home-header">
      <a class="prototype-brand" href="./index.html?prototype=1" aria-label="慢记首页"><svg class="prototype-time-mark" viewBox="0 0 28 28" fill="none" aria-hidden="true"><circle cx="14" cy="14" r="10"/><path d="M14 8v6l4 3" /></svg>慢记</a>
    </header>
    <section class="prototype-home-intro" aria-labelledby="home-title">
      <h1 id="home-title">人生轨迹</h1>
    </section>
    <p v-if="error" role="alert">{{ error }}</p>
    <ChapterTopics :chapters="lifeMapChapters" :initial-chapter-id="initialChapterId" :told-topics="toldTopics" @select="selectTopic" @chapter-change="selectChapter" />
    <PrototypeNav active="map" />
  </main>
</template>
