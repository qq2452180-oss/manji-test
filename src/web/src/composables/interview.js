import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import * as api from '../lib/api.js';
import * as appState from '../lib/app-state.js';
import { createInterviewController } from '../lib/interview-controller.js';
import { createRtc, checkEnvironment } from '../lib/realtime-web-rtc.js';
import { createMicrophoneLease } from '../lib/microphone-lease.js';
import { createOnboardingNarration, NARRATION_TEXT } from '../lib/onboarding-narration.js';
import { completeVoiceGuide, hasCompletedVoiceGuide } from '../lib/voice-guide-state.js';
import { finishFirstVisit } from '../lib/first-visit.js';
import { navigate } from '../lib/navigation.js';
import { loginUrl, usePageLifecycle } from './page.js';

export function useInterview() {
  const params = new URLSearchParams(location.search);
  const resumeSessionId = params.get('resume') === '1' && params.get('new') !== '1'
    ? params.get('session_id')?.trim() : '';
  // A home-page click is a one-use intent. Consume it before any async work so
  // refresh, history navigation, and login redirects cannot replay it.
  if (params.has('resume')) {
    params.delete('resume');
    const url = new URL(location.href); url.searchParams.delete('resume');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const textMode = ref(params.get('interaction') === 'text');
  const view = shallowRef({ phase: 'loading', connectionState: 'idle', connectionError: null, turns: [], attachments: [] });
  const draft = ref(''), localError = ref(''), actionBusy = ref(false);
  const onboardingStage = ref(''), onboardingError = ref(''), narration = shallowRef({}), microphoneLevel = ref(0);
  const freshGeneral = params.get('new') === '1' && !params.get('session_id')?.trim()
    && String(params.get('entry') || 'GENERAL').toUpperCase() !== 'PHOTO';
  let destroyed = false, pendingId = '', actionEpoch = 0, initializationAttempted = false;
  let permissionEpoch = 0, onboardingOwner = '', guideCompleted = hasCompletedVoiceGuide();
  const updateLevel = level => { if (!destroyed) microphoneLevel.value = level; };
  const microphone = createMicrophoneLease({ onLevel: updateLevel });
  const speaker = createOnboardingNarration({
    onChange(next) { if (!destroyed) narration.value = next; } });
  function stopPreparation() { ++permissionEpoch; speaker.stop(); microphone.close(); microphoneLevel.value = 0; }
  function presentPermission() {
    onboardingOwner = api.getAuthToken();
    onboardingStage.value = 'permission'; onboardingError.value = '';
    narration.value = {};
    speaker.prepare('guide');
  }
  function needsGuide(ready = controller.snapshot()) {
    return freshGeneral && !guideCompleted && !ready.restoredSession && !ready.restoredDraft
      && ready.initialized && !ready.readOnly && !['auth', 'finishing', 'finished'].includes(ready.phase);
  }
  const controller = createInterviewController({
    api, storage: window.sessionStorage,
    createRtc: options => createRtc({ ...options, captionDebug: params.get('caption_debug') === '1',
      acquireMicrophone: () => microphone.take(), onLevel: updateLevel }),
    checkEnvironment, preflightMicrophone: () => microphone.prepare(),
    onChange(next) {
      if (destroyed) return;
      view.value = next;
      if (!onboardingStage.value && !next.busy && ['paused', 'error', 'finishing', 'finished'].includes(next.phase)) microphone.close();
      if (next.phase === 'auth') { stopPreparation(); onboardingStage.value = ''; navigate(loginUrl(), { replace: true }); }
      if (next.connectionState === 'connected') finishFirstVisit();
      if (next.pendingInput) { pendingId = next.pendingInput.requestId; draft.value = next.pendingInput.text || ''; }
      else if (pendingId) { pendingId = ''; draft.value = ''; }
      if (['finishing', 'finished'].includes(next.phase) && next.sessionId) {
        appState.setOrganizationSessionId(next.sessionId);
        appState.removeActiveSessionId(next.sessionId);
      }
    },
    onSession(session) {
      if (destroyed) return;
      const id = typeof session === 'string' ? session : session?.session_id;
      if (!id) return;
      appState.setActiveSessionId(id);
      const url = new URL(location.href); url.searchParams.set('session_id', id); url.searchParams.delete('new');
      history.replaceState(null, '', url.pathname + url.search);
    },
  });
  async function run(action, exclusive = true) {
    if (destroyed || (exclusive && actionBusy.value)) return;
    if (exclusive) actionBusy.value = true;
    localError.value = '';
    try { return await action(); }
    catch (error) { if (!destroyed) localError.value = error.message || '暂时无法完成，请重试。'; }
    finally { if (exclusive) actionBusy.value = false; }
  }
  async function initialize() {
    // Creation can succeed before a later initialization request fails. Keep
    // that session instead of replaying the original new-session URL.
    const current = initializationAttempted ? controller.snapshot() : {};
    const sessionId = current.sessionId || params.get('session_id') || '';
    initializationAttempted = true;
    return controller.initialize({ sessionId, entry: current.sessionId ? current.entry : params.get('entry') || 'GENERAL', fresh: !sessionId && params.get('new') === '1', interaction: textMode.value ? 'text' : 'voice' });
  }
  onMounted(() => run(async () => {
    const epoch = actionEpoch, owner = api.getAuthToken();
    await initialize();
    const freshVoice = params.get('new') === '1' && !params.get('session_id')?.trim()
      && !textMode.value && String(params.get('entry') || 'GENERAL').toUpperCase() !== 'PHOTO';
    const ready = controller.snapshot();
    const type = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type;
    if (epoch === actionEpoch && !textMode.value && needsGuide(ready) && !destroyed && !document.hidden) {
      presentPermission();
      return;
    }
    if (resumeSessionId && ready.sessionId === resumeSessionId && ready.initialized && !ready.readOnly
      && !ready.finishPending && !['auth', 'finishing', 'finished'].includes(ready.phase)
      && !textMode.value && type === 'navigate' && epoch === actionEpoch && owner === api.getAuthToken()
      && !destroyed && !document.hidden) {
      try { await connectVoice(); } finally { microphone.close(); }
      return;
    }
    if (epoch === actionEpoch && freshVoice && !ready.sessionId && !ready.restoredSession && !ready.restoredDraft && !['reload', 'back_forward'].includes(type)
      && !destroyed && !document.hidden && ready.canStart) {
      try { await controller.start(); } finally { microphone.close(); }
    }
  }));
  usePageLifecycle({
    hide() {
      ++actionEpoch; stopPreparation();
      // Keep the current introduction visible; a cancelled permission request
      // returns to its original button instead of leaving it waiting forever.
      if (onboardingStage.value === 'requesting') onboardingStage.value = 'permission';
      controller.setVisible(false);
    },
    show() {
      controller.setVisible(true);
      if (!textMode.value && !onboardingStage.value && needsGuide()) presentPermission();
    },
    auth() { ++actionEpoch; stopPreparation(); onboardingStage.value = ''; controller.authChanged(); },
    destroy() {
      ++actionEpoch; stopPreparation(); destroyed = true; speaker.destroy(); controller.destroy();
      view.value = { phase: 'loading', connectionState: 'idle', turns: [], attachments: [] }; draft.value = '';
    },
  });
  watch(textMode, value => {
    stopPreparation();
    if (value) { onboardingStage.value = ''; finishFirstVisit(); }
    else if (needsGuide() && !document.hidden) presentPermission();
    const url = new URL(location.href);
    if (value) url.searchParams.set('interaction', 'text'); else url.searchParams.delete('interaction');
    history.replaceState(null, '', url.pathname + url.search);
    document.title = '慢记 · ' + (value ? '文字讲述' : '和小暖聊聊');
  });
  const hasPhotos = computed(() => Boolean(view.value.attachments?.length));
  const canContinue = computed(() => {
    if (actionBusy.value || view.value.busy) return false;
    if (view.value.pendingInput) return view.value.canRetryInput;
    if (hasPhotos.value) return view.value.canSubmit && view.value.attachments.every(item => item.state === 'uploaded');
    return view.value.canStart || view.value.canRetryCall;
  });
  const canChatLater = computed(() => {
    const ready = view.value;
    return !actionBusy.value && !ready.busy && ready.initialized && !!ready.sessionId && !ready.readOnly
      && !ready.finishPending && ready.connectionState === 'paused' && ready.phase !== 'pausing'
      && (ready.errorStage === 'pause' || (!ready.pending && ready.transportClosed === true))
      && ready.attachments?.every(item => item.state === 'uploaded');
  });
  function chatLater() {
    if (!canChatLater.value) return;
    return run(async () => {
      const epoch = actionEpoch, owner = api.getAuthToken(), sessionId = view.value.sessionId;
      await controller.pause();
      if (destroyed || document.hidden || epoch !== actionEpoch || owner !== api.getAuthToken()) return;
      const ready = controller.snapshot();
      if (ready.sessionId !== sessionId || ready.readOnly || ready.finishPending) return;
      if (ready.activityState !== 'PAUSED' || ready.transportClosed !== true || ready.pending || ready.busy || ready.errorStage === 'pause') {
        throw new Error(ready.errorStage === 'pause' ? '通话还没有暂停成功，请再点一次“下次聊”。' : '通话还在暂停中，请稍后再点“下次聊”。');
      }
      appState.setActiveSessionId(sessionId);
      navigate('./index.html');
    });
  }
  async function connectVoice() {
    const epoch = actionEpoch;
    const current = () => !destroyed && !document.hidden && epoch === actionEpoch;
    if (!controller.snapshot().initialized) await initialize();
    if (!current() || !controller.snapshot().initialized) return;
    if (needsGuide()) { presentPermission(); return; }
    if (view.value.errorStage === 'pause') {
      await controller.retryPause();
      if (!current() || controller.snapshot().errorStage === 'pause') return;
    }
    if (view.value.pendingInput) return controller.retryInput({ autoResume: true });
    if (hasPhotos.value) {
      if (!view.value.canSubmit || !view.value.attachments.every(item => item.state === 'uploaded')) return;
      return controller.submit({ text: '', autoResume: true });
    }
    return controller.resume();
  }
  function continueVoice() {
    return run(async () => {
      try { return await connectVoice(); } finally { microphone.close(); }
    });
  }
  function reconnect() { return continueVoice(); }
  async function authorizeVoice() {
    if (destroyed || document.hidden || textMode.value || onboardingStage.value === 'requesting' || actionBusy.value) return;
    if (!onboardingOwner || onboardingOwner !== api.getAuthToken()) { stopPreparation(); controller.authChanged(); return; }
    const epoch = ++permissionEpoch, owner = onboardingOwner;
    const current = () => !destroyed && !document.hidden && !textMode.value && epoch === permissionEpoch && owner === api.getAuthToken();
    // Safari needs playback unlocked in this click, before the permission await.
    speaker.activate('guide'); onboardingError.value = ''; onboardingStage.value = 'requesting';
    try {
      // This call stays directly in the click handler, before network/SDK work.
      await microphone.prepare();
      if (!current()) return;
      onboardingStage.value = 'guide';
      narration.value = { kind: 'guide', text: NARRATION_TEXT.guide[0] };
      void speaker.play('guide');
    } catch (error) {
      if (!current()) return;
      speaker.stop();
      microphone.close(); onboardingStage.value = 'denied';
      onboardingError.value = error.code === 'MIC_PERMISSION_DENIED'
        ? '麦克风没有打开，我现在还听不见您。您可以在浏览器的网站权限中开启，再回来重试。'
        : error.message || '麦克风暂时没有打开，请检查设备后再试。';
    }
  }
  function beginGuidedVoice() {
    if (destroyed || document.hidden || textMode.value || onboardingStage.value !== 'guide' || actionBusy.value) return;
    if (onboardingOwner !== api.getAuthToken()) { stopPreparation(); controller.authChanged(); return; }
    ++permissionEpoch; speaker.stop();
    guideCompleted = true; completeVoiceGuide(); finishFirstVisit();
    onboardingStage.value = ''; onboardingError.value = '';
    return continueVoice();
  }
  function replayGuide() {
    if (destroyed || document.hidden) return;
    if (onboardingStage.value === 'guide') {
      speaker.activate('guide');
      void speaker.play('guide');
    }
  }
  function pauseGuide() { speaker.pause(); }
  function pauseVoice() { microphone.close(); return run(() => controller.pause(), false); }
  function previewFromGuide() { stopPreparation(); navigate('./biography.html'); }
  function submitPhotos() {
    return run(() => {
      const current = controller.snapshot();
      if (current.pendingInput) {
        if (current.canRetryInput && current.pendingInput.mediaIds?.length) return controller.retryInput({ autoResume: true });
        return;
      }
      if (!current.canSubmit || !current.attachments?.length || !current.attachments.every(item => item.state === 'uploaded')) return;
      return controller.submit({ text: '', autoResume: true });
    });
  }
  function submitText() {
    return run(async () => {
      const result = view.value.pendingInput ? await controller.retryInput({ autoResume: false })
        : await controller.submit({ text: draft.value, autoResume: false });
      if (result) draft.value = '';
      return result;
    });
  }
  function finish() {
    return run(() => view.value.sessionId ? controller.finish() : navigate('./index.html'));
  }
  const showTextGuide = computed(() => freshGeneral && textMode.value && view.value.initialized && !view.value.restoredSession);
  return { view, textMode, draft, localError, actionBusy, hasPhotos, canContinue, canChatLater, chatLater, controller, run, initialize, continueVoice, reconnect, submitPhotos, submitText, finish,
    onboardingStage, onboardingError, narration, microphoneLevel, showTextGuide,
    authorizeVoice, beginGuidedVoice, replayGuide, pauseGuide, previewFromGuide, pauseVoice };
}
