<script setup>
import { computed } from 'vue';
import VoiceRing from './VoiceRing.vue';
import { NARRATION_TEXT } from '../lib/onboarding-narration.js';
import '../styles/voice-onboarding.css';

const props = defineProps({
  stage: { type: String, default: 'permission' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
  level: { type: Number, default: 0 },
  narration: { type: Object, default: () => ({}) },
  hasPreview: { type: Boolean, default: false },
});
defineEmits(['authorize', 'start', 'play', 'pause', 'preview']);

const guideLines = Array.isArray(NARRATION_TEXT.guide) ? NARRATION_TEXT.guide : [NARRATION_TEXT.guide];
const isGuide = computed(() => props.stage === 'guide');
const isRequesting = computed(() => props.stage === 'requesting');
const title = computed(() => isGuide.value ? '小暖带您开始聊天' : '让小暖听见您');
const currentCaptionIndex = computed(() => {
  const index = Number.isInteger(props.narration.index) && props.narration.index >= 0
    ? props.narration.index : guideLines.indexOf(props.narration.text);
  return Math.max(0, Math.min(index, guideLines.length - 1));
});
const captionLines = computed(() => guideLines.slice(0, currentCaptionIndex.value + 1));
const isPaused = computed(() => Boolean(props.narration.paused));
const authorizeLabel = computed(() => {
  if (isRequesting.value) return '正在等待允许…';
  if (props.stage === 'denied') return '已开启，重试';
  return '开启麦克风';
});
</script>

<template>
  <main class="voice-onboarding" :class="'onboarding-' + stage" aria-labelledby="voice-onboarding-title">
    <header class="onboarding-topbar">
      <span class="onboarding-brand">小暖</span>
      <div v-if="isGuide" class="onboarding-pause-hint">
        <button class="onboarding-pause" type="button" :aria-label="isPaused ? '继续讲解' : '暂停讲解'" :disabled="busy || (!isPaused && !narration.playing)" @click="$emit(isPaused ? 'play' : 'pause')">
          <svg v-if="isPaused" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m9 5 11 7-11 7z" /></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
        </button>
        <span v-if="isPaused">讲解已暂停，<br>可以点这里继续</span>
        <span v-else>正式聊天时，<br>也可以点这里暂停</span>
      </div>
    </header>

    <section class="onboarding-main">
      <VoiceRing v-if="!isGuide" class="onboarding-permission-ring" state="idle" />
      <VoiceRing v-else class="onboarding-ring" :state="narration.playing ? 'speaking' : narration.loading ? 'idle' : 'listening'" :level="level" />
      <h1 id="voice-onboarding-title" :class="{ 'sr-only': isGuide }">{{ title }}</h1>

      <template v-if="isGuide">
        <div class="onboarding-caption" role="log" aria-label="小暖的讲解" aria-live="polite" aria-atomic="false" aria-relevant="additions">
          <p v-for="(line, index) in captionLines" :key="index" :class="{ 'is-current': index === currentCaptionIndex, 'is-read': index < currentCaptionIndex }">{{ line }}</p>
        </div>
      </template>

      <template v-else>
        <template v-if="stage === 'denied'">
          <p class="onboarding-copy onboarding-error" role="alert">{{ error || '麦克风没有打开，我现在还听不见您。' }}</p>
          <details class="onboarding-details onboarding-permission-help">
            <summary>如何开启麦克风</summary>
            <div class="onboarding-details-copy">
              <p>在浏览器地址栏旁找到网站信息或权限设置，把这个网站的“麦克风”改为“允许”。</p>
              <p>如果浏览器仍无法使用麦克风，请到手机或电脑的系统设置里，允许这个浏览器使用麦克风。</p>
              <p>不同浏览器的位置可能不同。设置好后，回到这里点“已开启，重试”。</p>
            </div>
          </details>
        </template>
        <template v-else>
          <div class="onboarding-copy onboarding-permission-copy">
            <p class="onboarding-permission-lead"><span>麦克风打开后，</span><span>我就能听见您了。</span></p>
            <p class="onboarding-permission-hint">要是弹出询问，您选<strong>“允许”</strong>就好。</p>
          </div>
          <p v-if="isRequesting" class="onboarding-waiting" role="status">请在浏览器的询问中选择允许</p>
          <p v-if="error" class="onboarding-error" role="alert">{{ error }}</p>
        </template>
      </template>
    </section>

    <footer class="onboarding-actions">
      <p v-if="isGuide && error" class="onboarding-error" role="alert">{{ error }}</p>
      <button v-if="isGuide" class="paper-button onboarding-primary" type="button" :disabled="busy" @click="$emit('start')">{{ busy ? '正在准备…' : '准备好了，咱们开始吧' }}</button>
      <button v-else class="paper-button onboarding-primary" type="button" :disabled="busy || isRequesting" @click="$emit('authorize')">{{ authorizeLabel }}</button>
      <button v-if="hasPreview" class="onboarding-link onboarding-exit" type="button" @click="$emit('preview')">查看已有故事</button>
    </footer>
  </main>
</template>
