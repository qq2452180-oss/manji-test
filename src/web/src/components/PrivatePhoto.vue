<script setup>
import { ref, watch, onMounted } from 'vue';
import { getAuthToken, getPhotoBlob } from '../lib/api.js';
import { usePageLifecycle } from '../composables/page.js';

const props = defineProps({ mediaId: { type: String, required: true }, index: { type: Number, default: 0 }, alt: { type: String, default: '' }, plain: Boolean });
const url = ref(''), failed = ref(false), dialog = ref(null);
let version = 0, alive = true, visible = true, pending = null;
function clear() {
  ++version; pending = null;
  dialog.value?.close();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = ''; failed.value = false;
}
async function load() {
  if (!alive || !visible || !props.mediaId || !getAuthToken()) return '';
  if (url.value) return url.value;
  if (pending) return pending;
  const generation = ++version, token = getAuthToken(), id = props.mediaId;
  const current = () => alive && visible && generation === version && token === getAuthToken() && props.mediaId === id;
  failed.value = false;
  pending = getPhotoBlob(id).then(blob => {
    if (!current()) return '';
    url.value = URL.createObjectURL(blob); return url.value;
  }).catch(() => { if (current()) failed.value = true; return ''; })
    .finally(() => { if (generation === version) pending = null; });
  return pending;
}
async function preview() { if (await load()) dialog.value?.showModal(); }
function imageFailed(event) {
  if (event?.target?.getAttribute('src') !== url.value) return;
  clear(); failed.value = true;
}
watch(() => props.mediaId, () => { clear(); void load(); });
onMounted(load);
usePageLifecycle({ hide() { visible = false; clear(); }, show() { visible = true; void load(); }, auth: clear, destroy() { alive = false; clear(); } });
</script>

<template>
  <img v-if="plain && url" :src="url" :alt="alt || `讲述里的照片 ${index + 1}`" loading="lazy" @error="imageFailed">
  <button v-else type="button" class="material-photo" :aria-label="`查看第 ${index + 1} 张照片`" @click="plain ? load() : preview()">
    <img v-if="url" :src="url" :alt="alt || `讲述里的照片 ${index + 1}`" loading="lazy" @error="imageFailed">
    <span v-else>{{ failed ? '照片未加载，点击重试' : '正在读图…' }}</span>
  </button>
  <Teleport v-if="!plain" to="body">
    <dialog ref="dialog" class="dialog" aria-label="查看照片" @click="event => event.target === dialog && dialog.close()">
      <div class="dialog-header"><span>讲述里的照片</span><button type="button" aria-label="关闭照片" @click="dialog.close()">×</button></div>
      <img v-if="url" :src="url" :alt="alt || `讲述里的照片 ${index + 1}`">
    </dialog>
  </Teleport>
</template>
