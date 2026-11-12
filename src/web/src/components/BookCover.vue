<script setup>
import { computed } from 'vue';

const props = defineProps({
  title: { type: String, default: '我的传记' },
  subtitle: { type: String, default: '每一段经历，都值得慢慢记下' },
});
const fullTitle = computed(() => String(props.title || '').trim() || '我的传记');
const longCopy = computed(() => Array.from(fullTitle.value).length > 12);
function short(value, maximum) {
  const letters = Array.from(String(value || '').trim());
  return letters.length > maximum ? letters.slice(0, maximum - 1).join('') + '…' : letters.join('');
}
</script>

<template>
  <div class="book-cover cover-linen" :class="{ 'has-long-copy': longCopy }" :aria-label="`${fullTitle}，${subtitle}`">
    <div class="cover-ratio"></div><div class="cover-spine"></div>
    <div class="cover-content">
      <span class="cover-imprint">慢记 · 个人传记</span>
      <div class="cover-title-block"><span class="cover-title">{{ short(fullTitle, 32) }}</span><span class="cover-subtitle">{{ short(subtitle, 22) }}</span></div>
      <div v-if="!longCopy" class="cover-rings" aria-hidden="true"><div v-for="name in ['one', 'two', 'three']" :key="name" class="cover-ring" :class="`cover-ring-${name}`"></div></div>
      <span class="cover-author">写给自己，也写给在乎的人</span><div class="cover-rule"></div>
    </div>
  </div>
</template>
