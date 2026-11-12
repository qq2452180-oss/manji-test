<script setup>
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import '../styles/chapter-topics.css';

const props = defineProps({
  chapters: { type: Array, required: true },
  initialChapterId: { type: String, default: '' },
  toldTopics: { type: Array, default: () => [] },
  toldLabel: { type: String, default: '讲过' },
  topicsDisabled: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'chapter-change']);
const instanceId = useId();
const track = ref(null);
const tabElements = new Map();
const firstSelection = value => props.chapters.find(chapter => chapter.id === value)?.id || props.chapters[0]?.id || '';
const selectedId = ref(firstSelection(props.initialChapterId));
const selectedIndex = computed(() => props.chapters.findIndex(chapter => chapter.id === selectedId.value));
const panelId = chapterId => `chapter-topics-panel-${instanceId}-${chapterId}`;
const tabId = chapterId => `chapter-topics-tab-${instanceId}-${chapterId}`;
const number = value => String(value + 1).padStart(2, '0');
const hasStory = (chapterId, contentId) => props.toldTopics.some(topic => topic.chapterId === chapterId && topic.contentId === contentId);

function setTabElement(chapterId, element) {
  if (element) tabElements.set(chapterId, element);
  else tabElements.delete(chapterId);
}

async function revealSelection({ focus = false, animate = true } = {}) {
  await nextTick();
  const rail = track.value, tab = tabElements.get(selectedId.value);
  if (!rail || !tab?.isConnected) return;
  if (focus) tab.focus({ preventScroll: true });
  const railRect = rail.getBoundingClientRect(), tabRect = tab.getBoundingClientRect();
  const inset = 6;
  let nextLeft = rail.scrollLeft;
  if (tabRect.left < railRect.left + inset) nextLeft += tabRect.left - railRect.left - inset;
  else if (tabRect.right > railRect.right - inset) nextLeft += tabRect.right - railRect.right + inset;
  nextLeft = Math.max(0, Math.min(nextLeft, rail.scrollWidth - rail.clientWidth));
  if (Math.abs(nextLeft - rail.scrollLeft) < 1) return;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  // Only the timeline moves; changing a chapter never scrolls the page vertically.
  rail.scrollTo?.({ left: nextLeft, behavior: animate && !reducedMotion ? 'smooth' : 'auto' });
}

function selectChapter(chapterId, options) {
  if (!props.chapters.some(chapter => chapter.id === chapterId)) return;
  selectedId.value = chapterId;
  emit('chapter-change', chapterId);
  void revealSelection(options);
}
function stepChapter(direction) {
  const chapter = props.chapters[selectedIndex.value + direction];
  if (chapter) selectChapter(chapter.id);
}
function onTabKeydown(event, index) {
  let nextIndex;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % props.chapters.length;
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + props.chapters.length) % props.chapters.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = props.chapters.length - 1;
  else return;
  event.preventDefault();
  selectChapter(props.chapters[nextIndex].id, { focus: true });
}

watch(() => props.initialChapterId, value => selectChapter(firstSelection(value), { animate: false }));
watch(() => props.chapters, chapters => {
  if (!chapters.some(chapter => chapter.id === selectedId.value)) selectedId.value = firstSelection(props.initialChapterId);
  void revealSelection({ animate: false });
});
onMounted(() => { void revealSelection({ animate: false }); });

function chooseTopic(chapterId, contentId) {
  if (props.topicsDisabled) return;
  const chapter = props.chapters.find(item => item.id === chapterId);
  if (!chapter?.core_contents?.some(content => content.id === contentId)) return;
  emit('select', { chapterId, contentId });
}
</script>

<template>
  <section class="chapter-topics chapter-timeline" aria-label="人生章节时间轴">
    <template v-if="chapters.length">
      <div class="chapter-timeline-toolbar">
        <div class="chapter-timeline-navigation" role="group" aria-label="切换章节">
          <button class="chapter-timeline-step" type="button" aria-label="上一章" :disabled="selectedIndex <= 0" @click="stepChapter(-1)"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 7-5 5 5 5" /></svg></button>
          <button class="chapter-timeline-step" type="button" aria-label="下一章" :disabled="selectedIndex >= chapters.length - 1" @click="stepChapter(1)"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10 7 5 5-5 5" /></svg></button>
        </div>
      </div>
      <div ref="track" class="chapter-timeline-track" role="tablist" aria-label="人生章节" aria-orientation="horizontal">
        <button
          v-for="(chapter, index) in chapters"
          :id="tabId(chapter.id)"
          :key="chapter.id"
          :ref="element => setTabElement(chapter.id, element)"
          class="chapter-topic-choice"
          :class="{ 'is-selected': selectedId === chapter.id }"
          type="button"
          role="tab"
          :aria-selected="selectedId === chapter.id"
          :aria-controls="panelId(chapter.id)"
          :tabindex="selectedId === chapter.id ? 0 : -1"
          :data-testid="`chapter-${chapter.id}`"
          @click="selectChapter(chapter.id)"
          @keydown="onTabKeydown($event, index)"
        >
          <span class="chapter-timeline-number" aria-hidden="true">{{ number(index) }}</span>
          <span class="chapter-timeline-node" aria-hidden="true"></span>
          <span class="chapter-topic-name">{{ chapter.title }}</span>
        </button>
      </div>
      <section
        v-for="chapter in chapters"
        :id="panelId(chapter.id)"
        :key="chapter.id"
        class="chapter-topic-panel"
        :hidden="selectedId !== chapter.id"
        role="tabpanel"
        :aria-labelledby="tabId(chapter.id)"
        :tabindex="selectedId === chapter.id ? 0 : -1"
      >
        <template v-if="selectedId === chapter.id">
          <header class="chapter-topic-panel-heading"><h2>{{ chapter.title }}</h2></header>
          <div class="chapter-topic-list">
            <article
              v-for="(content, contentIndex) in chapter.core_contents"
              :key="content.id"
              class="chapter-topic-card"
            >
              <button
                class="chapter-topic-row"
                type="button"
                :data-testid="`topic-${content.id}`"
                :disabled="topicsDisabled"
                @click="chooseTopic(chapter.id, content.id)"
              >
                <span class="chapter-topic-row-number" aria-hidden="true">{{ number(contentIndex) }}</span>
                <span class="chapter-topic-row-copy">
                  <span class="chapter-topic-row-title">{{ content.title }}</span>
                  <span v-if="content.description || content.prompt" class="chapter-topic-prompt">{{ content.description || content.prompt }}</span>
                </span>
                <span v-if="hasStory(chapter.id, content.id)" class="chapter-topic-status">{{ toldLabel }}</span>
                <svg class="chapter-topic-row-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
              </button>
            </article>
          </div>
        </template>
      </section>
    </template>
    <p v-else class="chapter-topic-footnote" role="status">章节正在准备中。</p>
  </section>
</template>
