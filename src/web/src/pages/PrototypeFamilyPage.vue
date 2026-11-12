<script setup>
import { onMounted } from 'vue';
import PrototypeNav from '../components/PrototypeNav.vue';
import '../styles/prototype-library.css';

onMounted(() => { document.title = '慢记 · 家人'; });
</script>

<template>
  <main class="prototype-library prototype-family prototype-library-with-nav" data-testid="prototype-family-page">
    <header class="prototype-library-header"><h1>家人</h1></header>
    <p class="prototype-family-empty">家人功能后续开放</p>
  </main>
  <PrototypeNav active="family" />
</template>
