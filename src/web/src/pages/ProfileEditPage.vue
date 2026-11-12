<script setup>
import { computed, onMounted, ref } from 'vue';
import * as api from '../lib/api.js';
import { navigate } from '../lib/navigation.js';
import { loginUrl, requireMember, usePageLifecycle } from '../composables/page.js';
import PageHeader from '../components/PageHeader.vue';
import '../styles/profile.css';

const user = ref(null), displayName = ref(''), loading = ref(true), loadError = ref(false), saving = ref(false), error = ref('');
const avatarUrl = ref(''), draftUrl = ref(''), avatarFailed = ref(false), fileInput = ref(null);
const imageUrl = computed(() => draftUrl.value || avatarUrl.value);
let version = 0, loadedToken = '', alive = true, draftFile = null, uploadedAvatar = null;
const current = (request, token) => alive && request === version && token === api.getAuthToken();
function releaseImages() {
  for (const url of [avatarUrl.value, draftUrl.value]) if (url) URL.revokeObjectURL(url);
  avatarUrl.value = ''; draftUrl.value = ''; draftFile = null; uploadedAvatar = null; avatarFailed.value = false;
}
function clear() { ++version; user.value = null; displayName.value = ''; releaseImages(); saving.value = false; error.value = ''; }
async function loadProfile() {
  if (!alive) return;
  const request = ++version, token = loadedToken = api.getAuthToken();
  user.value = null; releaseImages(); error.value = ''; loading.value = true; loadError.value = false;
  try {
    const result = await requireMember({ isCurrent: () => current(request, token) });
    if (!result || !current(request, token)) return;
    user.value = result; displayName.value = result.display_name || '';
    if (result.avatar_media_id) {
      try { const blob = await api.getPhotoBlob(result.avatar_media_id); if (current(request, token)) avatarUrl.value = URL.createObjectURL(blob); }
      catch (_) { /* The name can still be edited when the old image is unavailable. */ }
    }
  } catch (_) { if (current(request, token)) loadError.value = true; }
  finally { if (current(request, token)) loading.value = false; }
}
function chooseFile(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file || !user.value || saving.value) return;
  if (file.size > 10 * 1024 * 1024) { error.value = '图片有点大，请选择小于 10 MB 的头像。'; return; }
  if (file.type && !/^image\/(jpeg|png|webp)$/i.test(file.type)) { error.value = '请选择 JPG、PNG 或 WebP 照片作为头像。'; return; }
  if (draftUrl.value) URL.revokeObjectURL(draftUrl.value);
  draftFile = file; draftUrl.value = URL.createObjectURL(file); uploadedAvatar = null; error.value = ''; avatarFailed.value = false;
}
async function save() {
  if (!user.value || saving.value || !alive) return;
  const request = version, token = loadedToken;
  if (!current(request, token)) { error.value = '登录状态已改变，请重新登录后再修改。'; return; }
  const name = displayName.value.trim();
  if (Array.from(name).length > 32) { error.value = '名字最多填写 32 个字。'; return; }
  if (!name && (user.value.display_name || !draftFile)) { error.value = '请填写你的名字。'; return; }
  displayName.value = name; saving.value = true; error.value = '';
  try {
    const profile = name ? { display_name: name } : {};
    if (draftFile) {
      if (!uploadedAvatar || uploadedAvatar.file !== draftFile) {
        const file = draftFile, photo = await api.uploadPhoto(file);
        if (!current(request, token)) return;
        uploadedAvatar = { file, id: photo.id };
      }
      profile.avatar_media_id = uploadedAvatar.id;
    }
    if (!current(request, token)) return;
    await api.updateProfile(profile);
    if (current(request, token)) navigate('./profile.html?saved=1', { replace: true });
  } catch (failure) {
    if (current(request, token)) {
      if (failure.code === 'PROFILE_AVATAR_NOT_FOUND') uploadedAvatar = null;
      error.value = failure.code === 'MEDIA_TOO_LARGE' ? '图片有点大，请选择较小的头像。' : ['MEDIA_UNSUPPORTED', 'MEDIA_INVALID_IMAGE'].includes(failure.code) ? '这张图片暂时无法使用，请换一张。' : '暂时没有保存成功，请再试一次。';
    }
  } finally { if (current(request, token)) saving.value = false; }
}
usePageLifecycle({
  // A native photo picker or another tab must not discard an unsaved draft.
  auth() { clear(); navigate(loginUrl(), { replace: true }); }, destroy() { alive = false; clear(); },
});
onMounted(loadProfile);
</script>

<template>
  <PageHeader v-if="user" title="编辑资料" back="profile.html" />
  <main class="page-body profile-edit-page">
    <p v-if="loading" class="loading-copy" role="status">正在读取个人资料…</p>
    <form v-if="user" @submit.prevent="save">
      <div class="avatar-section"><button class="avatar-chooser" type="button" aria-label="选择头像" :disabled="saving" @click="fileInput?.click()"><img v-if="imageUrl && !avatarFailed" class="edit-avatar" :src="imageUrl" alt="头像预览" @error="avatarFailed = true"><span v-else class="edit-avatar avatar-placeholder" aria-hidden="true"><span class="avatar-head" /><span class="avatar-body" /></span></button><p class="avatar-caption">点击更换头像</p><input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" tabindex="-1" :disabled="saving" data-testid="avatar-file" @change="chooseFile"></div>
      <div class="name-field"><label class="field-label" for="display-name">名字</label><input id="display-name" v-model="displayName" name="displayName" type="text" autocomplete="nickname" maxlength="64" placeholder="希望小暖怎么称呼你" :disabled="saving" @input="error = ''"></div>
      <p class="field-note">可以填写你喜欢的名字，最多 32 个字。</p><p v-if="error" class="notice" role="alert">{{ error }}</p><button class="btn btn-primary save-button" type="submit" :disabled="saving">{{ saving ? '正在保存…' : '保存' }}</button>
    </form>
    <section v-if="loadError" class="notice" role="alert"><p>个人资料暂时没有加载出来，请重试。</p><button class="btn btn-secondary retry-button" type="button" @click="loadProfile">重新加载</button></section>
  </main>
</template>
