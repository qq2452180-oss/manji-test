<script setup>
import { ref } from 'vue';

defineProps({ busy: Boolean, error: String });
const emit = defineEmits(['confirm']);
const draft = ref(null), occupation = ref('');
const occupations = ['教师', '医护人员', '工人', '农民', '军人', '机关或事业单位工作人员', '企业职员', '个体经营者', '司机或运输从业者', '餐饮或服务从业者', '技术人员', '文艺工作者', '家庭照护者'];
</script>

<template>
  <form class="decade-form" @submit.prevent="draft && !busy && emit('confirm', { birthDecade: draft, occupation: occupation || null })">
    <fieldset :disabled="busy">
      <legend>出生年代</legend>
      <div class="decade-options">
        <label v-for="decade in [50, 60, 70]" :key="decade" class="decade-option" :class="{ chosen: draft === decade }">
          <input v-model="draft" type="radio" name="birth-decade" :value="decade" required />
          <span class="decade-option-copy"><strong>{{ decade }} 后</strong><span>19{{ decade }}—19{{ decade + 9 }}</span></span>
        </label>
      </div>
      <div class="occupation-field">
        <label for="occupation">主要职业</label>
        <div class="occupation-select">
          <select id="occupation" v-model="occupation" name="occupation">
            <option value="">不选择职业</option>
            <option v-for="item in occupations" :key="item" :value="item">{{ item }}</option>
          </select>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
        </div>
      </div>
    </fieldset>
    <p v-if="error" role="alert" class="connected-error">{{ error }}</p>
    <div class="decade-actions">
      <button class="decade-confirm" type="submit" :disabled="!draft || busy">{{ busy ? '正在保存…' : '确认并查看话题' }}</button>
    </div>
  </form>
</template>
