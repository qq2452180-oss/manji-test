<script setup>
import { computed, onMounted, ref, shallowRef } from 'vue';
import * as api from '../lib/api.js';
import { setBiographyId } from '../lib/app-state.js';
import { chapterTime, storyParagraphs, storyPhotos, createReadingLoader } from '../lib/reading-data.js';
import { navigate } from '../lib/navigation.js';
import { loginUrl, requireUser, usePageLifecycle } from '../composables/page.js';
import PageHeader from '../components/PageHeader.vue';
import SiteNav from '../components/SiteNav.vue';
import PrivatePhoto from '../components/PrivatePhoto.vue';
import BookCover from '../components/BookCover.vue';
import '../styles/reading-pages.css';

const props = defineProps({ kind: { type: String, default: 'biography' } });
const params = new URLSearchParams(location.search);
const id = (params.get(props.kind + '_id') || params.get('id') || '').trim();
const titles = { biography: '我的传记', chapter: '章节', story: '故事' };
const failureTitles = { biography: '暂时无法读取传记', chapter: '这一章暂时没能打开', story: '暂时无法打开这篇故事' };
const loadingTitles = { biography: '正在翻开你的书…', chapter: '正在翻开这一章…', story: '正在读取故事正文……' };
const view = shallowRef({ status: 'loading' });
const visibleCount = ref(3), photoIndex = ref(0), reader = ref(null);
const isGuest = computed(() => reader.value?.is_guest === true);
const isMember = computed(() => reader.value && !reader.value.is_guest);
const entryPage = computed(() => isGuest.value ? 'login.html?trial=1' : isMember.value ? 'index.html' : 'welcome.html');
let disposed = false, identityVersion = 0;
const loader = createReadingLoader({ kind: props.kind, id, api, authorize: async () => {
  const generation = identityVersion, token = api.getAuthToken();
  const user = await requireUser();
  if (!disposed && generation === identityVersion && token === api.getAuthToken()) reader.value = user;
  return user;
}, onState(next) {
  if (next.status === 'loading' || next.status === 'guest') { reader.value = null; ++identityVersion; }
  view.value = next;
  visibleCount.value = 3; photoIndex.value = 0;
  if (next.status === 'ready' && props.kind === 'biography') setBiographyId(next.result.biography_id);
} });
const ready = computed(() => view.value.status === 'ready');
const result = computed(() => ready.value ? view.value.result : null);
const chapters = computed(() => result.value?.chapters || []);
const storyCount = computed(() => chapters.value.reduce((sum, chapter) => sum + Number(chapter.story_count || 0), 0));
const chapter = computed(() => result.value?.chapter || {});
const stories = computed(() => (result.value?.stories || []).filter(story => story.story_id && story.current_version));
const version = computed(() => result.value?.current_version || {});
const images = computed(() => storyPhotos(version.value));
const paragraphs = computed(() => storyParagraphs(version.value));
const shortDate = value => {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};
const storyDate = computed(() => {
  if (!shortDate(version.value.created_at)) return '';
  const date = new Date(version.value.created_at);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日整理`;
});
const href = (page, value) => `./${page}.html?id=${encodeURIComponent(value)}`;
function load() { if (!disposed) return loader.load(); }
function destroy() { disposed = true; loader.hide(); }
usePageLifecycle({ hide: () => loader.hide(), show: load,
  auth() { destroy(); navigate(loginUrl(), { replace: true }); }, destroy });
onMounted(() => { if (document.hidden) loader.hide(); else void load(); });
</script>

<template>
  <PageHeader :title="isGuest ? '体验预览' : titles[kind]" :back="kind === 'biography' || !reader ? entryPage : 'biography.html'" :home="entryPage" />
  <main :class="kind === 'story' ? 'page-body story-page' : `paper-page ${kind}-page${kind === 'biography' && isMember ? ' with-navigation' : ''}`">
    <section v-if="isGuest" class="trial-preview-note" aria-label="体验模式"><p>这里是本次体验的故事预览。</p><p>登录或注册后，可以继续讲述新的经历。</p><a class="paper-link" href="./login.html?trial=1">登录 / 注册，继续使用 →</a></section>
    <template v-if="kind === 'biography'">
      <div class="book-heading"><span class="paper-kicker">慢慢讲，慢慢成书</span><h1 class="paper-title">{{ isGuest ? '本次体验的故事' : '我的传记' }}</h1></div>
      <div class="book-display"><BookCover :title="result?.title || '我的传记'" /></div>
      <div v-if="ready" class="book-stats"><span>{{ chapters.length }} 章 · {{ storyCount }} 篇故事</span><span>{{ shortDate(result.updated_at) || '—' }} 更新</span></div>
    </template>
    <div v-if="!ready" class="paper-state" role="status" aria-live="polite">
      <p v-if="view.status === 'loading'" class="paper-muted">{{ loadingTitles[kind] }}</p>
      <template v-else-if="view.status === 'guest'">
        <h2 class="paper-section-title">{{ kind === 'biography' ? '你的故事，会在这里慢慢成书' : '登录后，继续读你的故事' }}</h2>
        <p class="paper-muted">{{ kind === 'biography' ? '登录后，打开属于你的传记。' : '每一篇故事，都只属于它的讲述者。' }}</p>
        <a class="paper-button" :href="loginUrl()">登录</a>
      </template>
      <template v-else><h2 class="paper-section-title">{{ failureTitles[kind] }}</h2><p class="paper-muted">{{ view.message }}</p><button class="paper-button secondary" @click="load">重新加载</button></template>
    </div>
    <div v-else-if="kind === 'biography'">
      <div class="contents-heading"><h2 class="paper-section-title">目录</h2><span class="paper-muted">沿着经历，慢慢读</span></div>
      <div v-if="!chapters.length" class="paper-state"><div class="empty-chapter">序</div><h2 class="paper-section-title">等待你的第一段经历</h2><p class="paper-muted">完成一次讲述并整理后，故事会出现在这里。</p></div>
      <a v-for="(item, index) in chapters" :key="item.chapter_id" class="chapter-row" :href="href('chapter', item.chapter_id)">
        <span class="chapter-number">{{ String(index + 1).padStart(2, '0') }}</span><div class="chapter-copy"><span class="chapter-title">{{ item.title }}</span><span class="paper-muted">{{ chapterTime(item) ? chapterTime(item) + ' · ' : '' }}{{ item.story_count || 0 }} 篇故事</span><p v-if="item.summary" class="chapter-excerpt">{{ item.summary }}</p></div><span class="chapter-arrow">›</span>
      </a>
      <a class="paper-link continue-link" :href="isGuest ? './login.html?trial=1' : './interview.html?new=1'">{{ isGuest ? '继续使用慢记' : '继续讲述新的经历 ＋' }}</a>
    </div>
    <div v-else-if="kind === 'chapter'">
      <span class="paper-kicker">我的传记 · 章节</span><h1 class="paper-title">{{ chapter.title }}</h1><p class="paper-muted">{{ chapterTime(chapter) ? chapterTime(chapter) + ' · ' : '' }}{{ stories.length }} 篇故事</p>
      <div v-if="chapter.summary" class="chapter-summary">{{ chapter.summary }}</div><p v-if="!stories.length" class="paper-state paper-muted">这一章还在等待新的故事。</p>
      <article v-for="(story, index) in stories.slice(0, visibleCount)" :key="story.story_id" class="chapter-story">
        <span class="paper-kicker">{{ String(index + 1).padStart(2, '0') }}</span><h2 class="chapter-story-title">{{ story.current_version.title || '未命名故事' }}</h2>
        <PrivatePhoto v-if="storyPhotos(story.current_version).length" :media-id="storyPhotos(story.current_version)[0].media_id" :index="0" />
        <p v-for="(text, paragraphIndex) in storyParagraphs(story.current_version)" :key="paragraphIndex" class="paper-paragraph">{{ text }}</p>
        <a class="paper-link story-link" :href="href('story', story.story_id)">{{ storyPhotos(story.current_version).length > 1 ? `打开这篇 · 查看 ${storyPhotos(story.current_version).length} 张照片` : '打开这一篇' }} ›</a>
      </article>
      <button v-if="visibleCount < stories.length" class="paper-button secondary continue-reading" @click="visibleCount += 3">继续往下读</button><a class="paper-link book-link" href="./biography.html">返回传记目录</a>
    </div>
    <div v-else class="story-content">
      <div class="aux-text story-intro">{{ isGuest ? '本次体验 · 正文' : '我的传记 · 正文' }}</div><h1 class="story-title">{{ String(version.title || '').trim() || '未命名故事' }}</h1><div v-if="storyDate" class="story-date">{{ storyDate }}</div>
      <div v-if="images.length" class="story-photos">
        <PrivatePhoto :key="images[photoIndex].media_id" :media-id="images[photoIndex].media_id" :index="photoIndex" />
        <div v-if="images.length > 1" class="story-photo-controls"><button class="story-photo-step" :disabled="photoIndex === 0" @click="photoIndex--">上一张</button><span class="story-photo-count">{{ photoIndex + 1 }} / {{ images.length }}</span><button class="story-photo-step" :disabled="photoIndex === images.length - 1" @click="photoIndex++">下一张</button></div>
        <p class="story-photo-hint">{{ images.length === 1 ? '本故事由这张照片的讲述整理而成' : '这些照片记录了这段讲述' }}</p>
      </div>
      <div class="story-body"><p v-for="(text, index) in paragraphs" :key="index" class="story-paragraph">{{ text }}</p><p v-if="!paragraphs.length" class="aux-text">这篇故事暂时没有正文。</p></div>
      <section v-if="isGuest" class="trial-result" aria-label="体验完成">
        <span class="paper-kicker">从一段回忆，到一篇故事</span><h2 class="paper-section-title">这是您的第一篇故事</h2>
        <p class="paper-muted">注册一个账号，就能保留这篇故事，以后再慢慢讲新的经历。</p>
        <a class="paper-button" href="./login.html?trial=1">注册账号，保留故事</a>
        <p class="paper-muted trial-session-note">本次体验可在当前标签页继续查看。</p>
      </section>
      <a class="return-link" href="./biography.html">{{ isGuest ? '返回体验预览' : '返回传记书' }}</a>
    </div>
  </main>
  <SiteNav v-if="kind === 'biography' && isMember" active="biography" />
</template>
