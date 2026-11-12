<script setup>
import { onMounted, ref } from 'vue';
import PrototypeNav from '../components/PrototypeNav.vue';
import { resetPrototypeState } from '../lib/prototype-state.js';
import { prototypeHistoryUrl } from '../lib/prototype-topic.js';
import '../styles/prototype-library.css';

const resetDialog = ref(null), resetTrigger = ref(null), status = ref(''), resetError = ref('');
function openReset() {
  status.value = '';
  resetError.value = '';
  if (!resetDialog.value?.open) resetDialog.value?.showModal();
}
function closeReset() { resetDialog.value?.close(); }
function restoreResetFocus() { resetTrigger.value?.focus(); }
function confirmReset() {
  try {
    resetPrototypeState();
    status.value = '内容已重置。';
    closeReset();
  } catch (error) {
    resetError.value = error.message || '暂时无法重置内容，请重试。';
  }
}

onMounted(() => { document.title = '慢记 · 我的'; });
</script>

<template>
  <main class="prototype-library prototype-profile prototype-library-with-nav" data-testid="prototype-profile-page">
    <header class="prototype-library-header"><h1>我的</h1></header>
    <section class="prototype-demo-identity" aria-label="我的空间">
      <span class="prototype-demo-avatar" aria-hidden="true">慢</span>
      <div><h2>我的空间</h2></div>
    </section>

    <nav class="prototype-profile-menu" aria-label="我的菜单">
      <a :href="prototypeHistoryUrl()"><span>讲述记录</span><span class="prototype-row-arrow" aria-hidden="true">›</span></a>
      <button ref="resetTrigger" type="button" @click="openReset"><span>重置内容</span><span class="prototype-row-arrow" aria-hidden="true">›</span></button>
    </nav>
    <p class="prototype-profile-status" role="status">{{ status }}</p>
    <footer class="prototype-profile-footer"><a class="prototype-library-text-link" href="./login.html">返回登录</a></footer>
  </main>
  <PrototypeNav active="profile" />

  <dialog ref="resetDialog" class="prototype-reset-dialog" aria-labelledby="prototype-reset-title" aria-describedby="prototype-reset-description" @cancel.prevent="closeReset" @close="restoreResetFocus" @click.self="closeReset">
    <div class="prototype-reset-content">
      <h2 id="prototype-reset-title">重置内容？</h2>
      <p id="prototype-reset-description">当前标签页的讲述记录和新增内容将清空，恢复初始故事。</p>
      <p v-if="resetError" class="prototype-reset-error" role="alert">{{ resetError }}</p>
      <div class="prototype-reset-actions">
        <button type="button" class="prototype-library-button prototype-reset-cancel" autofocus @click="closeReset">取消</button>
        <button type="button" class="prototype-library-button" @click="confirmReset">确认重置</button>
      </div>
    </div>
  </dialog>
</template>
