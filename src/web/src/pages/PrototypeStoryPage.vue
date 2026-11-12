<script setup>
import { computed, onMounted } from 'vue';
import PrototypeMemoryImage from '../components/PrototypeMemoryImage.vue';
import { getPrototypeStoryImage } from '../lib/prototype-images.js';
import { prototypeBackLink, prototypeHomeUrl, prototypeInterviewUrl, prototypeHistoryUrl, prototypeSource } from '../lib/prototype-topic.js';
import { resolvePrototypeStory, usePrototypeState } from '../lib/prototype-state.js';
import '../styles/prototype-story.css';

const state = usePrototypeState();
const context = computed(() => { state.value; return resolvePrototypeStory(location.search); });
const stories = computed(() => context.value.stories);
const demoRecording = computed(() => state.value.sessions.find(session => session.source === 'fictional-demo'
  && stories.value.some(story => story.id === session.storyId)));
const answersUrl = computed(() => demoRecording.value ? prototypeHistoryUrl(demoRecording.value.id, {
  storyId: demoRecording.value.storyId, back: 'story', from: prototypeSource(location.search),
  returnSessionId: new URLSearchParams(location.search).get('session_id') || undefined,
}) : '');
const homeUrl = computed(() => prototypeHomeUrl(context.value.chapter?.id));
const back = computed(() => prototypeBackLink(location.search, context.value));
const interviewUrl = computed(() => context.value.kind === 'topic' ? prototypeInterviewUrl(context.value.chapter.id, context.value.content.id) : '');
const supplementUrl = computed(() => context.value.kind === 'topic' && stories.value.length ? prototypeInterviewUrl(context.value.chapter.id, context.value.content.id, { storyId: stories.value[0].id, from: prototypeSource(location.search), back: 'story', returnSessionId: new URLSearchParams(location.search).get('session_id') || undefined }) : '');

onMounted(() => {
  const title = stories.value[0]?.title || (context.value.kind === 'topic' ? context.value.content.title : '故事');
  document.title = `慢记 · ${title}`;
});
</script>

<template>
  <main class="prototype-story" data-testid="prototype-story-page">
    <header class="prototype-story-header">
      <a class="prototype-story-back" :href="back.href">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        <span>{{ back.label }}</span>
      </a>
    </header>

    <div class="prototype-story-reading">
      <template v-if="context.kind === 'topic'">
        <p class="prototype-story-context">
          <span data-testid="selected-chapter">{{ context.chapter.title }}</span>
          <span class="prototype-story-context-divider" aria-hidden="true">·</span>
          <span data-testid="selected-fragment">{{ context.content.title }}</span>
        </p>

        <template v-if="stories.length">
          <article
            v-for="(story, index) in stories"
            :key="story.id"
            class="prototype-story-article"
            :aria-labelledby="`prototype-story-heading-${index}`"
            :data-testid="`demo-story-${story.id}`"
          >
            <component :is="index === 0 ? 'h1' : 'h2'" :id="`prototype-story-heading-${index}`">{{ story.title }}</component>
            <template v-for="(paragraph, paragraphIndex) in story.paragraphs" :key="paragraphIndex">
              <p>{{ paragraph }}</p>
              <PrototypeMemoryImage v-if="paragraphIndex === Math.min(1, story.paragraphs.length - 1)" :image="getPrototypeStoryImage(story.chapter_id, story.content_id)" />
            </template>
          </article>
          <footer class="prototype-story-actions">
            <a class="prototype-story-action" :href="supplementUrl" data-testid="continue-topic">继续补充<span aria-hidden="true"> →</span></a>
            <a v-if="demoRecording" class="prototype-story-source" :href="answersUrl" data-testid="story-answers">查看这篇的问答</a>
          </footer>
        </template>

        <section v-else class="prototype-story-empty">
          <h1>这段故事还没开始</h1>
          <a class="prototype-story-action" :href="interviewUrl" data-testid="start-topic">开始讲述<span aria-hidden="true"> →</span></a>
        </section>
      </template>

      <section v-else class="prototype-story-empty is-unavailable">
        <h1>暂时找不到这段故事</h1>
        <a class="prototype-story-action" :href="homeUrl">返回人生轨迹</a>
      </section>
    </div>
  </main>
</template>
