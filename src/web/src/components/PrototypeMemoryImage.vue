<script setup>
import { ref, watch } from 'vue';
import '../styles/prototype-memory-image.css';

const props = defineProps({ image: { type: Object, default: null } });
const failed = ref(false);
watch(() => props.image?.src, () => { failed.value = false; });
</script>

<template>
  <figure v-if="image && !failed" class="prototype-memory-image">
    <img :src="image.src" :alt="image.alt" :width="image.width" :height="image.height" loading="lazy" decoding="async" @error="failed = true" />
    <figcaption>{{ image.caption }}</figcaption>
  </figure>
</template>
