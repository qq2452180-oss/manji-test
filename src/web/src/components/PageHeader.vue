<script setup>
defineProps({ title: { type: String, default: '' }, back: { type: String, default: 'index.html' }, home: { type: String, default: 'index.html' } });
</script>

<template>
  <header class="site-header">
    <a :class="back ? 'header-back' : 'site-brand'" :href="'./' + (back || home)">{{ back ? '‹ 返回' : '慢记' }}</a>
    <span class="site-title">{{ title }}</span>
    <a v-if="back" class="site-brand" :href="'./' + home">慢记</a>
  </header>
</template>
