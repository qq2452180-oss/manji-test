<script setup>
import { computed, onMounted } from 'vue';
import WorkflowNav from '../components/WorkflowNav.vue';
import { getBiography, getChapter, normalizeId } from '../lib/workflow-api.js';
import { biographyUrl, homeUrl, loginUrl, storyUrl } from '../lib/workflow-navigation.js';
import { useWorkflowRead } from '../composables/workflow-read.js';
import '../styles/prototype-library.css';

const params = new URLSearchParams(location.search);
const chapterPage = location.pathname.endsWith('/chapter.html');
let chapterId = null, linkError = '';
if (chapterPage) {
  try {
    if (params.getAll('chapter_id').length !== 1) throw new Error();
    chapterId = normalizeId(params.get('chapter_id'));
  } catch (_) { linkError = '章节链接无效，请重新选择。'; }
}
const { data: library, loading, error, anonymous, authRequired, refresh } = useWorkflowRead(async () => {
  if (linkError) throw new Error(linkError);
  if (chapterPage) {
    return { chapters: [await getChapter(chapterId)], body: null };
  }
  const biography = await getBiography();
  return { chapters: [], body: typeof biography.body === 'string' ? biography.body.trim() : null };
}, () => ({ chapters: [], body: null }));
const chapters = computed(() => library.value.chapters);
const biographyBody = computed(() => library.value.body);
const paragraphs = body => String(body || '').split(/\n\s*\n/).filter(part => part.trim());
onMounted(() => { document.title = '慢记 · 我的传记'; });
</script>
<template>
  <main class="prototype-library prototype-biography prototype-library-with-nav" data-testid="connected-library-page">
    <header v-if="chapterPage" class="prototype-library-back-header"><a class="prototype-library-back" :href="biographyUrl()">‹ 返回我的传记</a></header>
    <header class="prototype-library-header prototype-draft-header"><div><h1>{{ chapterPage ? chapters[0]?.chapter?.title || '章节' : '我的传记' }}</h1><p class="prototype-draft-label">{{ chapterPage ? '这一章的故事' : '讲下的故事，会在这里慢慢成书。' }}</p></div></header>
    <div v-if="linkError" class="connected-notice connected-error" role="alert">{{ linkError }} <a :href="homeUrl()">重新选择章节 →</a></div>
    <p v-else-if="loading" class="connected-notice" role="status">{{ chapterPage ? '正在读取故事…' : '正在读取传记…' }}</p>
    <div v-else-if="error" class="connected-notice connected-error" role="alert">
      {{ authRequired ? '登录状态已失效。' : error }}
      <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a>
      <button v-else class="connected-retry" @click="refresh">重试</button>
    </div>
    <article v-else-if="!chapterPage && biographyBody" class="prototype-biography-draft" aria-label="我的传记" data-testid="biography-manuscript">
      <p v-for="(paragraph, index) in paragraphs(biographyBody)" :key="index" class="prototype-draft-paragraph connected-transcript">{{ paragraph }}</p>
    </article>
    <article v-else-if="chapterPage && chapters.some(item => item.stories.length)" class="prototype-biography-draft" aria-label="我的故事">
      <section v-for="item in chapters" :key="item.chapter.chapter_id" class="prototype-draft-stage">
        <section v-for="story in item.stories" :key="story.story_id" class="prototype-chapter-story">
          <h3><a :href="storyUrl(story.story_id)">{{ story.title }}</a></h3>
          <p v-for="(paragraph, index) in paragraphs(story.body)" :key="index" class="prototype-draft-paragraph connected-transcript">{{ paragraph }}</p>
          <a class="prototype-library-text-link" :href="storyUrl(story.story_id)">查看故事 →</a>
        </section>
      </section>
    </article>
    <section v-else class="prototype-library-empty prototype-draft-empty">
      <p>{{ chapterPage ? '这里还没有故事，想到什么就聊一点。' : '那些值得记下的日子，会在这里慢慢汇成你的传记。' }}</p>
      <a v-if="chapterPage" class="prototype-library-button" :href="homeUrl(chapterId)">选一个话题</a>
      <a v-if="anonymous" class="prototype-library-text-link" :href="loginUrl()">登录查看已有记录</a>
    </section>
  </main>
  <WorkflowNav active="book" />
</template>
