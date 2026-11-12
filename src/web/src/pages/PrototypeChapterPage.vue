<script setup>
import { computed, onMounted } from 'vue';
import { prototypeChapters } from '../lib/life-map-topics.js';
import { usePrototypeState } from '../lib/prototype-state.js';
import { prototypeBiographyUrl, prototypeHomeUrl, prototypeStoryUrl } from '../lib/prototype-topic.js';
import '../styles/prototype-library.css';

const params = new URLSearchParams(location.search);
const chapter = params.getAll('chapter_id').length === 1
  ? prototypeChapters.find(item => item.id === params.get('chapter_id'))
  : undefined;
const state = usePrototypeState();
const stories = computed(() => chapter ? state.value.stories.filter(story => story.chapter_id === chapter.id
  && chapter.core_contents.some(content => content.id === story.content_id)) : []);
function summary(story) {
  const letters = Array.from(String(story.paragraphs?.[0] || '').trim());
  return letters.length > 76 ? letters.slice(0, 76).join('') + '…' : letters.join('');
}
const storyUrl = story => prototypeStoryUrl(story.chapter_id, story.content_id, { storyId: story.id, from: 'chapter' });

onMounted(() => { document.title = `慢记 · ${chapter?.title || '章节'}`; });
</script>

<template>
  <main class="prototype-library prototype-chapter" data-testid="prototype-chapter-page">
    <header class="prototype-library-back-header">
      <a class="prototype-library-back" :href="prototypeBiographyUrl()"><span aria-hidden="true">‹</span>返回我的传记</a>
    </header>
    <template v-if="chapter">
      <header class="prototype-chapter-heading"><h1>{{ chapter.title }}</h1><p class="prototype-row-meta">{{ stories.length }} 篇故事</p></header>
      <div v-if="stories.length" class="prototype-chapter-stories">
        <article v-for="(story, index) in stories" :key="story.id" class="prototype-chapter-story" :aria-labelledby="`prototype-chapter-story-${index}`">
          <h2 :id="`prototype-chapter-story-${index}`">{{ story.title }}</h2>
          <p v-if="summary(story)" class="prototype-story-excerpt">{{ summary(story) }}</p>
          <a class="prototype-library-text-link" :href="storyUrl(story)">查看故事<span aria-hidden="true"> →</span></a>
        </article>
      </div>
      <section v-else class="prototype-library-empty">
        <p>这一章还没有故事。</p>
        <a class="prototype-library-button" :href="prototypeHomeUrl(chapter.id)">选一个片段，开始讲述</a>
      </section>
    </template>
    <section v-else class="prototype-library-empty prototype-invalid-chapter">
      <h1>暂时找不到这一章</h1>
      <a class="prototype-library-button" :href="prototypeBiographyUrl()">返回我的传记</a>
    </section>
  </main>
</template>
