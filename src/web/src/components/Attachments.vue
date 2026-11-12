<script setup>
import PrivatePhoto from './PrivatePhoto.vue';
defineProps({ items: { type: Array, default: () => [] }, locked: Boolean, compact: Boolean });
defineEmits(['retry', 'remove']);
</script>
<template>
  <div v-if="items.length" class="attachments" :class="{ compact }" aria-label="等待交给小暖的照片">
    <div v-for="item in items" :key="item.id" class="attachment">
      <PrivatePhoto v-if="item.mediaId" :media-id="item.mediaId" :alt="item.name || '已选择的照片'"/>
      <div class="attachment-copy"><p v-if="!compact || !item.mediaId" class="attachment-name">{{ item.name || '照片' }}</p><p class="attachment-status">{{ item.error || ({ uploading: '正在上传…', uploaded: compact ? '' : '已上传，等待送给小暖', failed: '上传失败' }[item.state]) }}</p></div>
      <div class="attachment-actions"><button v-if="item.state === 'failed'" type="button" :disabled="locked" @click="$emit('retry', item.id)">重试</button><button type="button" :disabled="locked || item.state === 'uploading'" :aria-label="'移除' + (item.name || '照片')" @click="$emit('remove', item.id)">移除</button></div>
    </div>
  </div>
</template>
