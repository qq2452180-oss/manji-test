<script setup>
import { prototypeHomeUrl, prototypeBiographyUrl, prototypeInterviewUrl, prototypeProfileUrl } from '../lib/prototype-topic.js';
import '../styles/prototype-nav.css';

defineProps({ active: { type: String, default: 'map' } });
const items = [
  { key: 'map', label: '人生轨迹', href: prototypeHomeUrl() },
  { key: 'book', label: '传记', href: prototypeBiographyUrl() },
  { key: 'xiaonuan', label: '小暖', href: prototypeInterviewUrl() },
  { key: 'family', label: '家人', href: './preview.html?prototype=1&kind=family' },
  { key: 'profile', label: '我的', href: prototypeProfileUrl() },
];
</script>

<template>
  <nav class="prototype-nav" aria-label="主导航" data-testid="prototype-nav">
    <a
      v-for="item in items"
      :key="item.key"
      :href="item.href"
      class="prototype-nav-item"
      :class="{ 'is-current': active === item.key, 'prototype-nav-xiaonuan': item.key === 'xiaonuan' }"
      :aria-current="active === item.key ? 'page' : undefined"
      :aria-label="item.key === 'xiaonuan' ? '和小暖聊聊' : undefined"
      :data-testid="item.key === 'xiaonuan' ? 'xiaonuan-entry' : undefined"
    >
      <span class="prototype-nav-symbol"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <template v-if="item.key === 'map'">
          <path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16" />
        </template>
        <template v-else-if="item.key === 'book'">
          <path d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 14h14M7 3v14m3-9h5m-5 4h5" />
        </template>
        <template v-else-if="item.key === 'xiaonuan'">
          <path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4" />
        </template>
        <template v-else-if="item.key === 'family'">
          <circle cx="9" cy="8" r="3.2" /><path d="M2.5 20v-1.5a6.5 6.5 0 0 1 13 0V20M16 5a3 3 0 0 1 0 6m2 2a5.5 5.5 0 0 1 3.5 5.2V20" />
        </template>
        <template v-else>
          <circle cx="12" cy="8" r="3.5" /><path d="M5 20v-1.5a5.5 5.5 0 0 1 5.5-5.5h3a5.5 5.5 0 0 1 5.5 5.5V20" />
        </template>
      </svg></span>
      <span>{{ item.label }}</span>
    </a>
  </nav>
</template>
