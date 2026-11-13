<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as workflow from '../lib/workflow-api.js';
import { ApiError, getAuthToken } from '../lib/api.js';
import { homeUrl, interviewUrl, loginUrl, organizingUrl, storyUrl } from '../lib/workflow-navigation.js';
import { navigate } from '../lib/navigation.js';
import { useConnectedVoice } from '../composables/connected-voice.js';
import VoiceRing from '../components/VoiceRing.vue';
import '../styles/prototype-interview.css';
import '../styles/connected-call.css';

const params = new URLSearchParams(location.search);
let interaction = ['text', 'voice'].includes(params.get('interaction')) ? params.get('interaction') : null;
const textMode = ref(interaction === 'text'), voiceStarted = ref(false);
const entryChosen = ref(false);
const entryModes = [{ mode: 'voice', label: '语音讲述' }, { mode: 'text', label: '文字讲述' }];
const identifier = name => params.getAll(name).length === 1 && /^[1-9]\d*$/.test(params.get(name) || '')
  && Number.isSafeInteger(Number(params.get(name))) ? params.get(name) : '';
const sessionId = ref(identifier('session_id'));
const topicId = ref(identifier('topic_id'));
const chapterId = identifier('chapter_id');
const targetStoryId = ref(identifier('story_id')), targetStoryTitle = ref('');
const topic = ref(null), chapterTitle = ref(''), messages = ref([]), status = ref('');
const sessionLoaded = ref(false), nextNode = ref(null);
const draft = ref(''), error = ref(''), loading = ref(true), busy = ref(false), paused = ref(true);
const callSummary = ref(null), endCallButton = ref(null), endingCall = ref(false);
const needsRefresh = ref(false), savePending = ref(false), authChanged = ref(false), authRequired = ref(false), pageVisible = ref(!document.hidden);
const invalid = ref(['session_id', 'topic_id', 'chapter_id', 'story_id'].some(name => params.has(name) && !identifier(name)));
const interviewScope = ref(!sessionId.value && !topicId.value && !chapterId && !targetStoryId.value ? 'global' : null);
const isGlobal = computed(() => interviewScope.value === 'global');
const entryPreview = computed(() => !sessionId.value && !topicId.value && !targetStoryId.value && Boolean(chapterId));
const title = computed(() => topic.value?.title || (isGlobal.value ? '和小暖聊聊'
  : entryPreview.value ? chapterTitle.value || '章节访谈' : '讲述'));
const entryDescription = computed(() => topic.value?.description?.trim()
  || (entryPreview.value ? '和小暖聊聊这一章，慢慢回忆这段生活。' : '和小暖聊聊这段回忆，也可以用文字慢慢写下。'));
const home = computed(() => homeUrl(topic.value?.chapter_id || chapterId || undefined));
const back = computed(() => targetStoryId.value ? storyUrl(targetStoryId.value) : home.value);
const backLabel = computed(() => targetStoryId.value ? '返回故事' : '返回人生轨迹');
const finished = computed(() => ['completed', 'writing_pending', 'revision_conflict'].includes(status.value));
const pendingReply = computed(() => status.value === 'reply_pending');
const legacyReadOnly = computed(() => sessionLoaded.value && sessionId.value && !topic.value && !isGlobal.value
  && status.value !== 'completed'
  && !(status.value === 'writing_pending' && ['memory_update', 'summary'].includes(nextNode.value)));
const canSend = computed(() => sessionId.value && !busy.value && !loading.value && !paused.value && !pendingReply.value
  && !finished.value && !legacyReadOnly.value && !needsRefresh.value && !savePending.value && !authChanged.value && draft.value.trim());
const hasNarration = computed(() => messages.value.some(message => message.role === 'user'));
const canFinish = computed(() => sessionId.value && !busy.value && !loading.value && !pendingReply.value
  && !finished.value && !legacyReadOnly.value && !needsRefresh.value && !savePending.value && !authChanged.value && !draft.value.trim()
  && !voiceSettling.value
  && hasNarration.value);
let alive = true, generation = 0, owner = getAuthToken(), pendingInput = null;
let completedStoryId = '', resumeKind = sessionId.value ? 'home_return' : null, resumeRequestId = null;
const current = version => alive && pageVisible.value && generation === version && !authChanged.value;
const draftKey = () => sessionId.value ? `manji.connected.draft.${sessionId.value}` : '';
const voice = useConnectedVoice({
  onSessionChange: async () => {
    if (alive && pageVisible.value && !authChanged.value && sessionId.value) await sync(generation);
  },
  onError: cause => {
    if (alive && pageVisible.value && !authChanged.value) {
      paused.value = true;
      error.value = cause.message || '语音暂时没有接通，请重试。';
      authRequired.value = cause.status === 401;
    }
  },
});
const { phase: voicePhase, agentState, caption: voiceCaption, level: voiceLevel, settling: voiceSettling } = voice;
const showVoice = computed(() => !textMode.value && voiceStarted.value && !legacyReadOnly.value && !finished.value);
const showEntryChoice = computed(() => !entryChosen.value && paused.value && !showVoice.value
  && !isGlobal.value && !targetStoryId.value && Boolean(topicId.value || chapterId || sessionId.value)
  && !legacyReadOnly.value && !finished.value && !pendingReply.value && !savePending.value && !needsRefresh.value);
const ringState = computed(() => voicePhase.value === 'connected'
  ? agentState.value === 3 ? 'speaking' : agentState.value === 2 ? 'thinking' : 'listening'
  : busy.value || voicePhase.value === 'connecting' ? 'connecting' : 'paused');
const callStatus = computed(() => voiceSettling.value ? '保存中'
  : voicePhase.value === 'connected' ? '通话中'
  : busy.value || voicePhase.value === 'connecting' ? '连接中' : '已暂停');
let readVersion = 0;

function saveDraft() {
  if (!alive || authChanged.value || !owner || owner !== getAuthToken() || !draftKey()) return;
  // Connection errors are transient; only an uncertain input needs its warning after reload.
  try { sessionStorage.setItem(draftKey(), JSON.stringify({ owner, text: draft.value, error: pendingInput ? error.value : '', pendingInput })); }
  catch (_) { /* A blocked browser store must not discard the text on screen. */ }
}
function restoreDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey()) || 'null');
    if (saved?.owner === owner) {
      draft.value = typeof saved.text === 'string' ? saved.text : '';
      pendingInput = saved.pendingInput?.text && Array.isArray(saved.pendingInput.ids) ? saved.pendingInput : null;
      error.value = pendingInput && typeof saved.error === 'string' ? saved.error : '';
    }
  } catch (_) { /* Server messages remain the source of truth. */ }
}
watch([draft, error], saveDraft);
watch(voicePhase, value => { if (['paused', 'error'].includes(value)) paused.value = true; });

async function identify() {
  if (!getAuthToken()) throw new ApiError('请先登录原来的账号，再重新打开这段讲述。', { status: 401, code: 'AUTH_REQUIRED' });
  await workflow.ensureIdentity(); owner = getAuthToken();
}
function rememberSession(id) {
  if (!/^[1-9]\d*$/.test(String(id || ''))) throw new Error('会话编号暂时无法读取，请返回首页重新打开。');
  sessionId.value = String(id);
  const url = new URL(interviewUrl({ sessionId: sessionId.value,
    topicId: topicId.value || undefined, chapterId: topic.value?.chapter_id || chapterId || undefined,
    storyId: targetStoryId.value || undefined }), location.href);
  if (interaction) url.searchParams.set('interaction', interaction);
  history.replaceState(history.state, '', url);
}
function acceptSession(value) {
  if (String(value?.session_id) !== sessionId.value || !Array.isArray(value.messages)) throw new Error('讲述记录暂时无法读取，请重试。');
  const target = value.target_story_id ? String(value.target_story_id) : '';
  if (targetStoryId.value && targetStoryId.value !== target) {
    invalid.value = true;
    throw new Error('这段讲述与要补充的故事不一致，请返回故事重新打开。');
  }
  targetStoryId.value = target;
  messages.value = value.messages;
  status.value = value.status;
  nextNode.value = value.next_node || null;
  sessionLoaded.value = true;
  completedStoryId = value.story_id ? String(value.story_id) : '';
  interviewScope.value = value.interview_scope || null;
  topic.value = value.selected_topic || null;
  topicId.value = value.selected_topic?.id ? String(value.selected_topic.id) : '';
  needsRefresh.value = false;
  savePending.value = value.save_pending === true;
  if (pendingInput) {
    const saved = value.messages.some(message => message.role === 'user'
      && !pendingInput.ids.includes(String(message.id)) && message.content === pendingInput.text);
    if (saved) {
      if (draft.value.trim() === pendingInput.text) draft.value = '';
      pendingInput = null;
    }
  }
  document.title = `慢记 · ${title.value}`;
  saveDraft();
}
async function sync(version) {
  const reading = ++readVersion;
  const value = await workflow.getInterview(sessionId.value);
  if (current(version) && reading === readVersion) acceptSession(value);
  return value;
}
async function loadTargetStory(version) {
  const story = await workflow.getStory(targetStoryId.value);
  if (!current(version)) return null;
  targetStoryTitle.value = story.title || '';
  if (!sessionId.value) {
    if (!story.selected_topic?.id || (topicId.value && String(story.selected_topic.id) !== topicId.value)) {
      invalid.value = true;
      throw new Error('这篇故事的所属话题暂时无法确认，原故事仍然保留。');
    }
    topic.value = story.selected_topic;
    topicId.value = String(story.selected_topic.id);
    document.title = `慢记 · 补充${targetStoryTitle.value || title.value}`;
  }
  return story;
}
async function exclusive(action) {
  if (!alive || busy.value || !pageVisible.value || authChanged.value || invalid.value) return;
  busy.value = true; authRequired.value = false;
  const version = generation;
  try { await action(version); }
  catch (cause) { if (current(version)) { error.value = cause.message || '暂时无法完成，请重试。'; authRequired.value = cause.status === 401; } }
  finally {
    if (alive) {
      busy.value = false; loading.value = false;
      if (!current(version) && pageVisible.value && !authChanged.value) {
        if (sessionId.value) needsRefresh.value = true;
        else void load();
      }
      saveDraft();
    }
  }
}
async function load() {
  return exclusive(async version => {
    loading.value = true;
    if (sessionId.value) {
      await identify();
      if (!current(version)) return;
      restoreDraft();
      await sync(version);
      if (current(version) && targetStoryId.value) await loadTargetStory(version);
      return;
    }
    if (targetStoryId.value) {
      await identify();
      if (!current(version)) return;
      const story = await loadTargetStory(version);
      if (!current(version)) return;
      if (story?.pending_processing?.session_id) {
        navigate(organizingUrl(story.pending_processing.session_id, { storyId: targetStoryId.value }));
        return;
      }
      if (story?.active_supplement?.session_id) {
        rememberSession(story.active_supplement.session_id);
        resumeKind = 'home_return';
        restoreDraft();
        await sync(version);
      }
      return;
    }
    if (!topicId.value && !chapterId) {
      document.title = `慢记 · ${title.value}`;
      return;
    }
    const catalog = await workflow.getCatalog();
    if (!current(version)) return;
    if (topicId.value) {
      const chapter = catalog.chapters?.find(item => item.topics?.some(candidate => String(candidate.id) === topicId.value));
      topic.value = chapter?.topics.find(candidate => String(candidate.id) === topicId.value) || null;
      chapterTitle.value = chapter?.title || '';
      if (!topic.value) invalid.value = true;
    } else {
      const chapter = catalog.chapters.find(item => String(item.id) === chapterId);
      chapterTitle.value = chapter?.title || '';
      if (!chapter) invalid.value = true;
    }
    document.title = `慢记 · ${title.value}`;
  });
}
function selectInteraction(mode) {
  textMode.value = mode === 'text';
  interaction = mode;
  const url = new URL(location.href);
  url.searchParams.set('interaction', interaction);
  history.replaceState(history.state, '', url);
}
function begin(mode) {
  if (legacyReadOnly.value || entryPreview.value || voiceSettling.value) return;
  return exclusive(async version => {
    error.value = '';
    if (mode === 'voice' || mode === 'text') { entryChosen.value = true; selectInteraction(mode); }
    const speaking = !textMode.value;
    if (!sessionId.value && !isGlobal.value && (!topicId.value || !topic.value)) {
      error.value = '请先从人生轨迹选择一个话题。';
      return;
    }
    try {
      if (speaking) {
        voiceStarted.value = true;
        // Request permission in the click handler, before identity/model requests.
        await voice.prepareMicrophone();
        if (!current(version)) return;
      }
      await identify();
      if (!current(version)) return;
      if (sessionId.value) {
        const value = await sync(version);
        if (!current(version) || needsRefresh.value || legacyReadOnly.value || pendingReply.value || savePending.value || finished.value) return;
        if (speaking || value.resume_mode !== 'text') {
          await workflow.updateInterviewMode(sessionId.value, speaking ? 'voice' : 'text');
          if (!current(version)) return;
        }
        if (!speaking) { resumeKind = null; resumeRequestId = null; }
        paused.value = speaking ? !(await connectVoice()) : false;
        return;
      }
      const result = await workflow.startInterview(topicId.value || undefined, {
        resumeMode: speaking ? 'voice' : 'text',
        ...(targetStoryId.value ? { targetStoryId: targetStoryId.value } : {}),
      });
      // Keep the newly allocated ID on this page even if it was hidden while
      // the opening was generated. Never allocate another session on resume.
      if (!alive || authChanged.value || owner !== getAuthToken()) return;
      rememberSession(result.session_id);
      needsRefresh.value = true;
      if (!current(version)) return;
      await sync(version);
      if (current(version)) paused.value = speaking ? !(await connectVoice()) : false;
    } catch (cause) {
      if (alive && !authChanged.value && owner === getAuthToken() && cause.sessionId) {
        rememberSession(cause.sessionId);
        status.value = 'reply_pending';
        needsRefresh.value = false;
      }
      throw cause;
    } finally {
      if (speaking && voicePhase.value !== 'connected') await voice.stop();
    }
  });
}
async function connectVoice() {
  const latest = messages.value.at(-1);
  let options = {};
  if (resumeKind === 'home_return') {
    // Reuse this ID after a failed connection so the saved recap is not generated twice.
    resumeRequestId ||= crypto.randomUUID();
    options = { resume_kind: 'home_return', resume_request_id: resumeRequestId };
  } else if (resumeKind && latest?.role === 'assistant' && latest.id != null) {
    options = { resume_kind: resumeKind, resume_message_id: String(latest.id) };
  }
  const connected = await voice.start(sessionId.value, options);
  if (connected) { resumeKind = null; resumeRequestId = null; }
  return connected;
}
function pause({ unload = false } = {}) {
  if (!textMode.value && voicePhase.value === 'connected') {
    resumeKind = [2, 3].includes(agentState.value) ? 'pause_replay' : 'pause_continue';
  }
  paused.value = true; saveDraft();
  return voice.stop({ unload });
}
function switchMode() {
  if (busy.value || voiceSettling.value) return;
  return exclusive(async version => {
    if (!(await pause()) || !current(version)) return;
    const nextText = !textMode.value;
    if (sessionId.value && !pendingReply.value && !savePending.value && !needsRefresh.value) {
      await workflow.updateInterviewMode(sessionId.value, nextText ? 'text' : 'voice');
      if (!current(version)) return;
    }
    selectInteraction(nextText ? 'text' : 'voice');
    if (nextText) { resumeKind = null; resumeRequestId = null; }
    error.value = '';
  });
}
function refresh() {
  return exclusive(async version => {
    error.value = '';
    await identify();
    if (current(version)) await sync(version);
  });
}
function retry() {
  if (legacyReadOnly.value) return;
  return exclusive(async version => {
    error.value = '';
    await identify();
    if (!current(version)) return;
    let retryError;
    try { await workflow.retryInterview(sessionId.value); }
    catch (cause) { retryError = cause; authRequired.value = cause.status === 401; }
    if (!current(version)) return;
    needsRefresh.value = true;
    await sync(version);
    if (current(version)) {
      if (retryError && (pendingReply.value || savePending.value)) throw retryError;
      if (!needsRefresh.value && !savePending.value && !legacyReadOnly.value) paused.value = !textMode.value;
    }
  });
}
function send() {
  if (!canSend.value) return;
  return exclusive(async version => {
    error.value = '';
    const text = draft.value.trim();
    pendingInput = { text, ids: messages.value.map(message => String(message.id)) };
    saveDraft();
    let submissionError;
    try { await workflow.submitText(sessionId.value, text); }
    catch (cause) { submissionError = cause; authRequired.value = cause.status === 401; }
    if (!current(version)) { if (alive) needsRefresh.value = true; return; }
    // A failed response can still have saved the input. Read before offering
    // another send, and use /retry when the saved turn needs an AI reply.
    needsRefresh.value = true;
    try { await sync(version); }
    catch (cause) {
      if (current(version)) {
        authRequired.value = authRequired.value || cause.status === 401;
        error.value = authRequired.value ? '登录状态已失效，文字已保留。' : '暂时无法确认保存结果，文字已保留，请先重新读取记录。';
      }
      return;
    }
    if (!current(version)) return;
    if (submissionError || pendingInput) {
      error.value = pendingReply.value ? '文字已收到，回复尚未完成，请重试回复。'
        : pendingInput ? '尚未确认这段文字已保存，请核对记录后再发送。' : '';
      if (pendingReply.value && !pendingInput && submissionError?.code === 'MODEL_ACCOUNT_UNAVAILABLE') {
        error.value = `文字已收到并保存。${submissionError.message}`;
      }
    }
    saveDraft();
  });
}
async function finish() {
  if (!canFinish.value) return;
  if (textMode.value) {
    paused.value = true; saveDraft();
    navigate(organizingUrl(sessionId.value, { storyId: targetStoryId.value || undefined }));
    return;
  }
  return exclusive(async version => {
    if (!(await pause()) || !current(version)) return;
    await sync(version);
    if (current(version) && !pendingReply.value && !savePending.value && !needsRefresh.value) {
      navigate(organizingUrl(sessionId.value, { storyId: targetStoryId.value || undefined }));
    }
  });
}
function endCall() {
  if (voiceSettling.value || endingCall.value || callSummary.value?.open) return;
  if (busy.value) {
    // Cancelling connection also invalidates late permission/session responses.
    generation++;
    void pause({ unload: true });
    navigate(back.value);
    return;
  }
  endingCall.value = true;
  return exclusive(async version => {
    error.value = '';
    if (!(await pause()) || !current(version)) return;
    if (sessionId.value) {
      needsRefresh.value = true;
      await sync(version);
    }
    if (!current(version) || pendingReply.value || savePending.value || needsRefresh.value) return;
    // The organizing page starts generation on mount, so ask before navigating there.
    callSummary.value?.showModal();
  }).finally(() => { endingCall.value = false; });
}
function closeCallSummary() {
  callSummary.value?.close();
  if (alive && pageVisible.value && !authChanged.value) endCallButton.value?.focus();
}
function generateBiography() {
  if (!callSummary.value?.open || !canFinish.value || !current(generation)) return;
  closeCallSummary();
  return finish();
}
function chatLater() {
  if (!callSummary.value?.open || busy.value || voiceSettling.value || !current(generation)) return;
  saveDraft();
  closeCallSummary();
  navigate(back.value);
}
function resultUrl() {
  return status.value === 'completed' && completedStoryId
    ? storyUrl(completedStoryId, { sessionId: sessionId.value })
    : organizingUrl(sessionId.value, { storyId: targetStoryId.value || undefined });
}
function changedIdentity() {
  callSummary.value?.close();
  void voice.stop({ unload: true });
  generation++; authChanged.value = true; authRequired.value = false; paused.value = true;
  messages.value = []; topic.value = null; chapterTitle.value = ''; sessionId.value = '';
  targetStoryId.value = ''; targetStoryTitle.value = '';
  draft.value = ''; pendingInput = null; status.value = ''; completedStoryId = '';
  sessionLoaded.value = false; nextNode.value = null; interviewScope.value = null;
  document.title = '慢记 · 讲述';
  error.value = '登录状态已变化，请返回首页重新打开讲述。';
}
function hide() { callSummary.value?.close(); pageVisible.value = false; generation++; void pause({ unload: true }); if (sessionId.value) needsRefresh.value = true; }
function show() {
  pageVisible.value = true;
  // Reconcile the stopped call when returning; reopening the microphone needs a click.
  void voice.stop().then(() => {
    if (!alive || !pageVisible.value || busy.value || authChanged.value) return;
    if (sessionId.value) void refresh();
    else void load();
  });
}
function visibility() { document.hidden ? hide() : show(); }
onMounted(() => {
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  window.addEventListener('manji:auth-changed', changedIdentity);
  if (invalid.value) loading.value = false;
  else void load();
});
onBeforeUnmount(() => {
  saveDraft(); alive = false; generation++;
  voice.dispose();
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('pagehide', hide);
  window.removeEventListener('pageshow', show);
  window.removeEventListener('manji:auth-changed', changedIdentity);
});
</script>

<template>
  <main class="prototype-interview" :class="{ 'is-call-screen': showVoice, 'is-entry-screen': showEntryChoice }" data-testid="connected-interview-page">
    <header class="prototype-interview-header">
      <a class="prototype-interview-back" :class="{ 'connected-call-back': showVoice }" :href="back" :aria-label="backLabel" @click="pause({ unload: true })">
        <svg v-if="showVoice || showEntryChoice" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>
        <template v-else><span aria-hidden="true">‹</span> {{ backLabel }}</template>
      </a>
      <span v-if="!showVoice && !showEntryChoice" class="prototype-interview-label">{{ targetStoryId ? '补充故事' : isGlobal ? '全局访谈' : entryPreview ? '章节访谈' : textMode ? '文字讲述' : '语音讲述' }}</span>
    </header>
    <section v-if="invalid || authChanged" class="prototype-interview-unavailable">
      <h1>{{ authChanged ? '请重新打开这段讲述' : '这个访谈入口暂时无法打开' }}</h1>
      <p v-if="error" role="alert">{{ error }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></p><a :href="back">{{ backLabel }}</a>
    </section>
    <template v-else-if="pageVisible">
      <section v-if="showEntryChoice" class="connected-interview-choice" :aria-label="entryPreview ? '章节访谈暂未开放' : '选择访谈方式'" :aria-busy="loading || busy" data-testid="interview-entry-choice">
        <div class="connected-interview-choice-copy">
          <h1>{{ title }}</h1>
          <p>{{ entryDescription }}</p>
        </div>
        <div class="connected-interview-choice-buttons">
          <button v-for="entry in entryModes" :key="entry.mode" class="connected-interview-choice-button" :class="{ 'is-text-entry': entry.mode === 'text' }" type="button"
            :disabled="entryPreview || loading || busy || voiceSettling" :data-testid="`start-${entry.mode}-interview`" @click="begin(entry.mode)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <template v-if="entry.mode === 'voice'"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 10v1a6 6 0 0 0 12 0v-1M12 17v4M9 21h6"/></template>
              <template v-else><path d="M5 4h14a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-9l-6 4V5a1 1 0 0 1 1-1Z"/><path d="M8 8h8M8 12h5"/></template>
            </svg>
            <span>{{ entry.mode === 'voice' ? '语音访谈' : '文字访谈' }}</span>
          </button>
        </div>
        <div v-if="error" class="connected-interview-choice-error">
          <p class="prototype-interview-error" role="alert">{{ error }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></p>
          <button v-if="!sessionId" class="prototype-interview-secondary" type="button" :disabled="busy" @click="load">{{ topicId ? '重新读取话题' : '重新读取章节' }}</button>
        </div>
      </section>
      <template v-else>
        <section v-if="!showVoice" class="prototype-interview-topic">
          <p v-if="chapterTitle && topic" class="prototype-interview-chapter">{{ chapterTitle }}</p>
          <h1>{{ title }}</h1>
          <p v-if="targetStoryId" class="prototype-interview-description" data-testid="supplement-target">补充《{{ targetStoryTitle || title }}》，整理后会更新这篇故事。</p>
          <p v-else-if="entryPreview || (isGlobal && !sessionId)" class="prototype-interview-description">{{ entryPreview ? '和小暖聊聊这一章，慢慢回忆这段生活。' : '想到什么就聊什么，小暖会陪您找到想讲的故事。' }}</p>
          <p v-else-if="!sessionId && topic?.description" class="prototype-interview-description">{{ topic.description }}</p>
        </section>
        <section v-if="showVoice" class="prototype-interview-voice connected-voice" aria-label="语音访谈" data-testid="voice-call">
          <div class="connected-call-identity">
            <h1>小暖</h1>
            <p class="connected-call-status" role="status">{{ callStatus }}</p>
          </div>
          <VoiceRing :state="ringState" :level="voiceLevel"/>
          <div class="connected-call-caption" aria-live="polite" aria-atomic="true" data-testid="call-subtitle"><p v-if="voiceCaption">{{ voiceCaption }}</p></div>
        </section>
        <div v-else class="prototype-interview-voice is-topic-library">
          <p v-if="loading" role="status">正在读取讲述…</p>
          <div v-for="message in messages" :key="message.id" class="prototype-interview-caption" data-testid="message">
            <span>{{ message.role === 'user' ? '我' : '小暖' }}</span>
            <p style="white-space: pre-wrap">{{ message.content }}</p>
          </div>
          <div v-if="sessionId && (!finished || legacyReadOnly)" class="prototype-topic-note">
            <label for="connected-answer">这段回忆</label>
            <textarea id="connected-answer" v-model="draft" :readonly="legacyReadOnly" :disabled="!legacyReadOnly && (busy || paused || pendingReply || savePending || needsRefresh)" rows="5" placeholder="想到哪里，就写到哪里…"></textarea>
            <button v-if="!legacyReadOnly" class="prototype-interview-secondary" type="button" :disabled="!canSend" data-testid="send-answer" @click="send">{{ busy ? '正在保存…' : '发送这段文字' }}</button>
            <p v-if="legacyReadOnly" class="prototype-topic-note-hint">原讲述和草稿已保留，可以阅读和复制。</p>
            <p v-else-if="paused" class="prototype-topic-note-hint">已暂停，记录和草稿会保留。</p>
          </div>
        </div>
        <footer v-if="showVoice" class="prototype-interview-actions connected-call-actions">
          <p v-if="error" class="prototype-interview-error" role="alert">{{ error }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></p>
          <div class="connected-call-controls">
            <button class="connected-call-control is-pause" type="button" :disabled="busy || loading || voiceSettling"
              :data-testid="pendingReply || savePending ? 'retry-reply' : needsRefresh ? 'refresh-interview' : paused ? 'start-interview' : 'pause-interview'"
              @click="pendingReply || savePending ? retry() : needsRefresh ? refresh() : paused ? begin() : pause()">
              <span class="connected-call-button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path v-if="pendingReply || savePending || needsRefresh || error" d="M20 7v5h-5M20 12a8 8 0 1 0-2 5"/>
                <path v-else-if="paused && !busy" d="m9 5 10 7-10 7Z"/>
                <path v-else d="M9 5v14M15 5v14"/>
              </svg></span>
              <span>{{ pendingReply || savePending || needsRefresh || error ? '重试' : paused && !busy ? '继续' : '暂停' }}</span>
            </button>
            <button ref="endCallButton" class="connected-call-control is-end" type="button" :disabled="voiceSettling || endingCall" data-testid="finish-interview" @click="endCall">
              <span class="connected-call-button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13c5-5 13-5 18 0v4h-5v-4a12 12 0 0 0-8 0v4H3Z"/></svg></span>
              <span>{{ endingCall ? '保存中' : busy && voicePhase !== 'connected' ? '取消' : '结束' }}</span>
            </button>
          </div>
          <button v-if="paused && !busy && !voiceSettling" class="connected-call-text" type="button" data-testid="switch-interview-mode" @click="switchMode">改用文字</button>
        </footer>
        <footer v-else class="prototype-interview-actions">
          <p v-if="error" class="prototype-interview-error" role="alert">{{ error }} <a v-if="authRequired" :href="loginUrl()">重新登录后继续</a></p>
          <template v-if="entryPreview">
            <div class="connected-interview-entry-actions">
              <button v-for="entry in entryModes" :key="entry.mode" class="prototype-interview-action" :class="{ 'is-text-entry': entry.mode === 'text' }" type="button" disabled :data-testid="`start-${entry.mode}-interview`" aria-describedby="interview-entry-status">{{ entry.label }}</button>
            </div>
            <p id="interview-entry-status" class="prototype-topic-note-hint">暂未开放</p>
          </template>
          <template v-else-if="legacyReadOnly">
            <p class="prototype-topic-note-hint">这段旧讲述没有所属话题，原内容仍然保留。</p>
            <a class="prototype-interview-action" :href="home" data-testid="legacy-select-topic">选话题开始新访谈</a>
          </template>
          <a v-else-if="finished" class="prototype-interview-action" :href="resultUrl()" data-testid="interview-result">{{ status === 'completed' ? '查看故事' : '继续整理' }}</a>
          <template v-else>
            <button v-if="pendingReply || savePending" class="prototype-interview-action" type="button" :disabled="busy || loading" data-testid="retry-reply" @click="retry">{{ savePending ? '重试保存' : '重试回复' }}</button>
            <button v-else-if="needsRefresh" class="prototype-interview-action" type="button" :disabled="busy || loading" data-testid="refresh-interview" @click="refresh">重新读取记录</button>
            <div v-else-if="paused" class="connected-interview-entry-actions">
              <button v-for="entry in entryModes" :key="entry.mode" class="prototype-interview-action" :class="{ 'is-text-entry': entry.mode === 'text' }" type="button" :disabled="busy || loading || voiceSettling" :data-testid="`start-${entry.mode}-interview`" @click="begin(entry.mode)">{{ entry.label }}</button>
            </div>
            <button v-else class="prototype-interview-action" type="button" :disabled="busy" data-testid="pause-interview" @click="pause">暂停</button>
            <button v-if="!paused" class="prototype-interview-secondary" type="button" :disabled="busy || loading || voiceSettling" data-testid="switch-interview-mode" @click="switchMode">{{ textMode ? '改用语音' : '改用文字' }}</button>
            <button v-if="sessionId" class="prototype-interview-secondary" type="button" :disabled="!canFinish" data-testid="finish-interview" @click="finish">结束并整理</button>
            <p v-if="draft.trim()" class="prototype-topic-note-hint">发送这段文字后，就可以结束并整理。</p>
            <p v-else-if="sessionId" class="prototype-topic-note-hint">结束并整理后，会生成故事并更新传记。也可以先暂停，之后继续聊。</p>
          </template>
          <button v-if="!sessionId && error && !isGlobal" class="prototype-interview-secondary" type="button" :disabled="busy" @click="load">{{ targetStoryId ? '重新读取故事' : topicId ? '重新读取话题' : '重新读取章节' }}</button>
        </footer>
      </template>
    </template>
  </main>
  <dialog v-if="showVoice" ref="callSummary" class="connected-call-summary" aria-labelledby="call-summary-title" aria-describedby="call-summary-description"
    data-testid="call-summary" @cancel.prevent="closeCallSummary" @click.self="closeCallSummary">
    <button class="connected-call-summary-close" type="button" aria-label="关闭，留在讲述页" data-testid="close-call-summary" @click="closeCallSummary">×</button>
    <p class="connected-call-summary-status">通话已结束</p>
    <h2 id="call-summary-title">要把这次讲述整理成传记吗？</h2>
    <p id="call-summary-description">
      <template v-if="draft.trim()">还有一段文字草稿未发送，发送后就能生成传记。也可以先保留，下次继续。</template>
      <template v-else-if="!hasNarration">这次还没有保存的讲述，暂时无法生成传记。下次想聊时，可以继续这段讲述。</template>
      <template v-else>讲述已保存，小暖可以帮您整理成故事，写进传记里。也可以先放一放，下次继续聊。</template>
    </p>
    <div class="connected-call-summary-actions">
      <button class="prototype-interview-action" type="button" :disabled="!canFinish" data-testid="generate-biography" @click="generateBiography">生成传记</button>
      <button class="prototype-interview-secondary" type="button" :disabled="busy || voiceSettling" data-testid="chat-later" autofocus @click="chatLater">下次再说</button>
    </div>
  </dialog>
</template>
