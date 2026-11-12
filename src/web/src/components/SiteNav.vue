<script setup>
defineProps({ active: { type: String, default: 'tell' } });
const items = [
  { key: 'tell', path: 'index.html', label: '讲述' },
  { key: 'biography', path: 'biography.html', label: '传记' },
  { key: 'xiaonuan', path: 'interview.html?new=1&entry=GENERAL', label: '小暖' },
  { key: 'family', path: 'preview.html?kind=family', label: '家人' },
  { key: 'profile', path: 'profile.html', label: '我的' },
];
</script>

<template>
  <nav class="nav" aria-label="主导航">
    <a v-for="item in items" :key="item.key" class="nav-item" :class="{ active: active === item.key, 'xiaonuan-item': item.key === 'xiaonuan' }"
      :href="'./' + item.path" :aria-label="item.label" :aria-current="active === item.key ? 'page' : undefined">
      <div v-if="item.key === 'tell'" class="waves" aria-hidden="true"><i class="wave-bar"/><i class="wave-bar wave-mid"/><i class="wave-bar wave-tall"/><i class="wave-bar wave-mid"/><i class="wave-bar"/></div>
      <div v-else-if="item.key === 'biography'" class="book" aria-hidden="true"><div class="book-line"/><div class="book-line"/></div>
      <div v-else-if="item.key === 'xiaonuan'" class="xiaonuan-icon" aria-hidden="true"><div class="xiaonuan-face"><div class="xiaonuan-eyes"><div class="xiaonuan-eye"/><div class="xiaonuan-eye"/></div><div class="xiaonuan-smile"/></div></div>
      <div v-else-if="item.key === 'family'" class="family" aria-hidden="true"><div class="person"/><div class="person small"/></div>
      <div v-else class="person" aria-hidden="true"/>
      <span :class="{ 'xiaonuan-label': item.key === 'xiaonuan' }">{{ item.label }}</span>
    </a>
  </nav>
</template>
