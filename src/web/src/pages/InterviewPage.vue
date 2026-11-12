<script setup>
import { computed, ref } from 'vue';
import { useInterview } from '../composables/interview.js';
import { savedMessages } from '../lib/messages.js';
import PageHeader from '../components/PageHeader.vue';
import PrivatePhoto from '../components/PrivatePhoto.vue';
import VoiceRing from '../components/VoiceRing.vue';
import VoiceOnboarding from '../components/VoiceOnboarding.vue';
import Attachments from '../components/Attachments.vue';
import '../styles/interview.css';

const { view: state, textMode, draft, localError, actionBusy, hasPhotos, canContinue, canChatLater, chatLater, controller, run, initialize, continueVoice, reconnect, submitPhotos, submitText, finish,
  onboardingStage, onboardingError, narration, microphoneLevel, showTextGuide,
  authorizeVoice, beginGuidedVoice, replayGuide, pauseGuide, previewFromGuide, pauseVoice } = useInterview();
const photoInput = ref(null);
const closing = computed(() => ['finishing', 'finished'].includes(state.value.phase));
const connection = computed(() => state.value.connectionState || 'idle');
const live = computed(() => connection.value === 'connected');
const pendingConnection = computed(() => state.value.phase === 'loading' || connection.value === 'connecting');
const hasPhotoReply = computed(() => state.value.turns?.some(turn => turn.response_state === 'GENERATED' && turn.assistant_text && turn.media_ids?.length));
const preparingPhoto = computed(() => !textMode.value && !closing.value && !live.value && connection.value !== 'connecting' && state.value.entry === 'PHOTO' && !hasPhotoReply.value);
const voice = computed(() => !textMode.value && !preparingPhoto.value && !closing.value);
const paused = computed(() => connection.value === 'paused');
const showVoiceActions = computed(() => !live.value && !pendingConnection.value);
const ringState = computed(() => live.value ? state.value.agentState === 3 ? 'speaking' : state.value.agentState === 2 ? 'thinking' : 'listening' : pendingConnection.value ? 'connecting' : connection.value);
const waitingForTransport = computed(() => state.value.transportClosed === false || state.value.transportClosed == null && state.value.saving);
const progress = computed(() => ({ loading: '正在准备…', pausing: '正在暂停通话…', generating: '小暖正在看照片…' }[state.value.phase] || (waitingForTransport.value && paused.value ? '正在暂停通话…' : '')));
const captionSegments = computed(() => {
  if (!(live.value || connection.value === 'connecting') || state.value.captionSpeaker !== 'assistant') return [];
  return (state.value.captionSegments || []).filter(segment => typeof segment.text === 'string' && segment.text.trim());
});
const caption = computed(() => {
  const active = live.value || connection.value === 'connecting';
  if (active && state.value.captionSpeaker === 'assistant' && state.value.caption?.trim()) return state.value.caption;
  if (active && state.value.agentState === 3) return '小暖正在说话…';
  if (progress.value) return progress.value;
  if (live.value) {
    if (state.value.agentState === 2) return '小暖正在想…';
    return state.value.muted ? '' : '小暖正在听您讲话';
  }
  if (connection.value === 'connecting' && state.value.notice) return state.value.notice;
  return { connecting: '正在连接小暖…', paused: '已暂停，可以继续聊或补充照片。', failed: '暂时没有接通小暖' }[connection.value]
    || '准备好后，开始和小暖聊聊';
});
const error = computed(() => localError.value || state.value.connectionError?.message || (state.value.errorStage ? state.value.notice : ''));
const recovery = computed(() => state.value.phase === 'error' && ['initialize', 'session', 'create', 'config'].includes(state.value.errorStage));
const messages = computed(() => savedMessages({ session_id: state.value.sessionId, opening_assistant_text: state.value.opening,
  turns: state.value.turns || [], resume_openings: state.value.resumeOpenings || [] }));
const uploadLocked = computed(() => Boolean(state.value.pendingInput || closing.value || ['generating', 'loading'].includes(state.value.phase)));
const canSubmit = computed(() => !actionBusy.value && (state.value.pendingInput ? state.value.canRetryInput : state.value.canSubmit && (draft.value.trim() || hasPhotos.value)));
const canStartPhotos = computed(() => {
  if (actionBusy.value || state.value.busy) return false;
  if (state.value.pendingInput) return state.value.canRetryInput && Boolean(state.value.pendingInput.mediaIds?.length);
  return state.value.canSubmit && hasPhotos.value && state.value.attachments.every(item => item.state === 'uploaded' && item.mediaId);
});
const organizationUrl = computed(() => './organizing.html?session_id=' + encodeURIComponent(state.value.sessionId || ''));
function choosePhotos() { if (!uploadLocked.value) photoInput.value?.click(); }
function upload(event) { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void run(() => controller.uploadPhotos(files)); }
</script>

<template>
  <VoiceOnboarding v-if="onboardingStage && !textMode" :stage="onboardingStage" :busy="actionBusy" :error="onboardingError" :level="microphoneLevel" :narration="narration" :has-preview="!!state.sessionId"
    @authorize="authorizeVoice" @start="beginGuidedVoice" @play="replayGuide" @pause="pauseGuide" @preview="previewFromGuide"/>
  <PageHeader v-if="!onboardingStage && !voice" :title="closing ? '整理讲述' : textMode ? '文字讲述' : '图片访谈'"/>
  <main v-if="!onboardingStage && voice" class="voice-page" aria-label="和小暖聊聊">
    <div class="voice-topbar"><button v-if="live || connection === 'connecting' || state.phase === 'generating'" class="voice-pause" type="button" aria-label="暂停访谈" @click="pauseVoice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg></button></div>
    <section class="voice-center">
      <p v-if="state.isGuest" class="trial-interview-note">初次体验 · 讲一段回忆，让小暖帮您整理成故事</p>
      <VoiceRing :state="ringState" :level="microphoneLevel"/>
      <div class="voice-caption" :class="{ 'pause-caption': paused }" aria-live="polite" aria-atomic="false">
        <template v-if="captionSegments.length">
          <p v-for="segment in captionSegments" :key="`${state.captionRoundId}:${segment.key ?? segment.startTime}`">{{ segment.text }}</p>
        </template>
        <p v-else>{{ caption }}</p>
      </div>
      <div v-if="showVoiceActions && hasPhotos" class="voice-materials">
        <Attachments :items="state.attachments" :locked="!!state.pendingInput" compact @retry="id => run(() => controller.retryUpload(id))" @remove="id => run(() => controller.removePhoto(id))"/>
        <p class="paper-muted">点“继续聊”后，小暖才会看到这些照片。</p>
      </div>
    </section>
    <section v-if="showVoiceActions" class="voice-actions" :aria-label="paused ? '暂停后的操作' : '通话操作'">
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <button v-if="recovery" type="button" class="paper-button" :disabled="actionBusy" @click="reconnect">重新连接</button>
      <button v-else-if="connection === 'failed'" type="button" class="paper-button" :disabled="!canContinue" @click="reconnect">重新连接</button>
      <button v-else type="button" class="paper-button" :disabled="!canContinue" @click="continueVoice">{{ paused ? (state.pendingInput && state.errorStage === 'input' ? '重试，继续聊' : '继续聊') : '开始通话' }}</button>
      <div class="voice-secondary-actions"><button v-if="paused" type="button" class="paper-button secondary" :disabled="uploadLocked || actionBusy" @click="choosePhotos">传张照片</button><button type="button" class="paper-button secondary" :disabled="actionBusy || (!!state.sessionId && !state.canFinish)" @click="finish">{{ state.errorStage === 'finish' ? '重试结束' : state.sessionId ? '结束并整理' : '不聊了' }}</button></div>
      <button v-if="paused && state.sessionId" type="button" class="paper-link" :disabled="!canChatLater" @click="chatLater">下次聊</button>
    </section>
  </main>
  <main v-else-if="!onboardingStage" class="interview-page" :class="{ 'text-chat-page': textMode && !closing }">
    <section v-if="closing" class="completed-panel">
      <h1 class="paper-title">{{ state.phase === 'finished' ? '这段讲述，已经记下了。' : '正在整理这段讲述' }}</h1>
      <p class="paper-muted">{{ state.notice || '正在收齐最后的讲述，接着整理成故事。' }}</p>
      <a class="paper-button" :href="organizationUrl">查看整理进度</a><a class="paper-link" href="./index.html">返回首页</a>
    </section>
    <section v-else-if="preparingPhoto" class="photo-preparation" aria-label="准备图片语音访谈">
      <h1 class="paper-title">看着照片，聊聊那时候。</h1>
      <p class="paper-muted">选好照片后，小暖会用语音陪您聊。</p>
      <Attachments :items="state.attachments" :locked="!!state.pendingInput" @retry="id => run(() => controller.retryUpload(id))" @remove="id => run(() => controller.removePhoto(id))"/>
      <button class="photo-picker" type="button" :disabled="uploadLocked || actionBusy" @click="choosePhotos"><span class="picker-symbol" aria-hidden="true">＋</span><span>{{ hasPhotos ? '再选几张照片' : '选择照片' }}</span><span class="paper-muted">可一次选择多张</span></button>
      <p v-if="progress" class="paper-muted photo-progress" role="status">{{ progress }}</p>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <button type="button" class="paper-button" :disabled="!canStartPhotos" @click="submitPhotos">{{ state.pendingInput ? '重试并开始图片语音访谈' : '开始图片语音访谈' }}</button>
      <button type="button" class="paper-link" :disabled="actionBusy" @click="finish">不聊了</button>
      <button v-if="recovery" type="button" class="paper-button secondary" :disabled="actionBusy" @click="run(initialize)">重新打开这次访谈</button>
    </section>
    <template v-else>
      <section id="text-stage">
        <div class="chat-heading"><h1 class="paper-title">和小暖，慢慢聊</h1><span v-if="state.isGuest" class="chat-trial-label">初次体验</span></div>
        <div class="chat-messages" aria-label="访谈对话">
          <article v-if="showTextGuide" class="chat-message" data-testid="text-onboarding">
            <span class="chat-speaker">小暖</span>
            <div class="chat-bubble chat-welcome"><p>您打字跟我说就行。小时候住的地方、最想念的一道菜，都可以聊聊。</p><p class="chat-welcome-note">讲完点“结束并整理”，我会帮您写进书里。</p></div>
          </article>
          <article v-for="message in messages" :key="message.id" class="chat-message" :class="{ 'from-user': message.role === 'user' }">
            <span class="chat-speaker">{{ message.role === 'user' ? '我' : '小暖' }}</span>
            <div v-if="message.photos.length" class="photo-strip"><PrivatePhoto v-for="(id, i) in message.photos" :key="id" :media-id="id" :index="i"/></div>
            <p v-if="message.text" class="chat-bubble">{{ message.text }}</p><span v-if="message.state" class="chat-caption">{{ message.state }}</span>
          </article>
        </div>
      </section>
      <section class="material-composer" aria-label="补充讲述材料">
        <div class="chat-compose-box">
          <label class="sr-only" for="draft">写下想讲的话</label><textarea id="draft" v-model="draft" class="chat-input" maxlength="20000" rows="2" :disabled="!!state.pendingInput || state.busy" placeholder="想起什么，就写在这里…"/>
          <Attachments :items="state.attachments" :locked="!!state.pendingInput" @retry="id => run(() => controller.retryUpload(id))" @remove="id => run(() => controller.removePhoto(id))"/>
          <p v-if="hasPhotos" class="chat-photo-note">{{ state.maxImages ? `本次最多 ${state.maxImages} 张，也可以只发照片` : '也可以只发照片' }}</p>
          <p v-if="state.pendingInput" class="paper-muted">上次提交的材料正在确认，请先重试这一条。</p>
          <p v-if="error" class="error-message" role="alert">{{ error }}</p>
          <div class="chat-compose-toolbar">
            <button class="chat-add-photo" type="button" :disabled="uploadLocked || actionBusy" @click="choosePhotos"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg><span>{{ hasPhotos ? '继续加照片' : '加照片' }}</span></button>
            <button type="button" class="paper-button chat-send" :disabled="!canSubmit" @click="submitText">{{ state.phase === 'generating' ? '小暖正在准备回复…' : state.pendingInput ? '重试这条回复' : '发送' }}</button>
          </div>
        </div>
        <div class="text-tools"><button type="button" class="paper-link" :disabled="state.busy || waitingForTransport || !!state.pendingInput" @click="textMode = false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-3 0h6"/></svg>改用语音</button><button type="button" class="paper-link text-finish" :disabled="!state.canFinish || actionBusy" @click="finish">结束并整理<span aria-hidden="true"> →</span></button></div>
      </section>
      <button v-if="recovery" type="button" class="paper-button secondary" :disabled="actionBusy" @click="run(initialize)">重新打开这次访谈</button>
    </template>
  </main>
  <input ref="photoInput" type="file" hidden aria-label="选择讲述照片" accept="image/jpeg,image/png,image/webp" multiple :disabled="uploadLocked" @change="upload">
</template>
