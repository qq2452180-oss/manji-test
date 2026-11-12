<script setup>
import { computed } from 'vue';

const props = defineProps({ state: { type: String, default: 'paused' }, level: { type: Number, default: 0 } });
const volume = computed(() => Number.isFinite(props.level) ? Math.max(0, Math.min(1, props.level)) : 0);
// Speech RMS is usually well below 1. Lift quiet speech into a visible range
// while keeping silence still and retaining the original measurement.
const activity = computed(() => Math.min(1, Math.sqrt(volume.value) * 2.5));
</script>
<template>
  <div class="voice-ring" :class="'is-' + state" :style="{ '--voice-level': volume, '--voice-activity': activity }" aria-hidden="true">
    <span class="ring r1"/><span class="ring r2"/><span class="ring r3"/>
    <span class="ring-center"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <template v-if="state === 'listening'"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></template>
      <path v-else-if="state === 'speaking'" d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>
      <path v-else-if="state === 'paused'" d="M9 5v14M15 5v14"/>
      <template v-else><circle cx="6" cy="12" r=".7"/><circle cx="12" cy="12" r=".7"/><circle cx="18" cy="12" r=".7"/></template>
    </svg></span>
  </div>
</template>
