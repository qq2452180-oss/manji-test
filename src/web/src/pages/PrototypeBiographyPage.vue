<script setup>
import { computed, onMounted } from 'vue';
import PrototypeNav from '../components/PrototypeNav.vue';
import PrototypeMemoryImage from '../components/PrototypeMemoryImage.vue';
import { usePrototypeState } from '../lib/prototype-state.js';
import { composePrototypeBiography } from '../lib/prototype-biography.js';
import { prototypeInterviewUrl } from '../lib/prototype-topic.js';
import { getPrototypeStoryImage } from '../lib/prototype-images.js';
import { LIFE_MAP_BIOGRAPHY_TITLE, isFictionalDemoStory } from '../lib/life-map-demo.js';
import '../styles/prototype-library.css';

const state = usePrototypeState();
const demoCount = computed(() => state.value.stories.filter(isFictionalDemoStory).length);
const draftLabel = computed(() => demoCount.value ? '修订初稿' : '草稿');
const stages = computed(() => composePrototypeBiography(state.value.stories).map(stage => ({
  ...stage,
  images: stage.sources.flatMap(source => {
    const image = getPrototypeStoryImage(source.chapterId || stage.id, source.contentId);
    return image ? [{ ...image, id: source.storyId, afterParagraph: source.paragraphStart + Math.min(1, source.paragraphCount - 1) }] : [];
  }),
})));
const startUrl = prototypeInterviewUrl(undefined, undefined, { from: 'biography' });

onMounted(() => { document.title = '慢记 · 我的传记'; });
</script>

<template>
  <main class="prototype-library prototype-biography prototype-library-with-nav" data-testid="prototype-biography-page">
    <header class="prototype-library-header prototype-draft-header">
      <div><h1>我的传记</h1><p class="prototype-draft-label" id="prototype-draft-description">{{ draftLabel }}</p></div>
    </header>

    <div v-if="demoCount" class="prototype-draft-introduction">
      <p class="prototype-draft-book-title">{{ LIFE_MAP_BIOGRAPHY_TITLE }}</p>
    </div>

    <article v-if="stages.length" class="prototype-biography-draft" data-testid="prototype-biography-draft" aria-label="人生传记草稿" aria-describedby="prototype-draft-description" tabindex="0">
      <section v-for="stage in stages" :key="stage.id" class="prototype-draft-stage" :aria-labelledby="`biography-heading-${stage.id}`" :data-testid="`biography-stage-${stage.id}`">
        <h2 :id="`biography-heading-${stage.id}`">{{ stage.title }}</h2>
        <p v-if="stage.transition" class="prototype-draft-transition">{{ stage.transition }}</p>
        <template v-for="(paragraph, index) in stage.paragraphs" :key="index">
          <p class="prototype-draft-paragraph">{{ paragraph }}</p>
          <PrototypeMemoryImage v-for="image in stage.images.filter(item => item.afterParagraph === index)" :key="image.id" :image="image" />
        </template>
      </section>
    </article>
    <section v-else class="prototype-library-empty prototype-draft-empty">
      <p>讲下的故事，会在这里慢慢成书。</p>
      <a class="prototype-library-button" :href="startUrl">和小暖聊聊</a>
    </section>
  </main>
  <PrototypeNav active="book" />
</template>
