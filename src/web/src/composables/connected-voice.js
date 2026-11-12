import { ref } from 'vue';
import * as api from '../lib/workflow-api.js';
import { getAuthToken } from '../lib/api.js';
import { checkEnvironment, createRtc } from '../lib/realtime-web-rtc.js';
import { createMicrophoneLease } from '../lib/microphone-lease.js';
import { createCallSubtitles } from '../lib/call-subtitles.js';

// The page owns the interview; this adapter only connects its existing session to RTC.
export function useConnectedVoice({ onSessionChange = async () => {}, onError = () => {} } = {}) {
  const phase = ref('idle'), agentState = ref(0), caption = ref(''), level = ref(0), settling = ref(false);
  let disposed = false, generation = 0, rtc = null, attempt = null, starting = null, stopping = null, pollTimer;
  const subtitles = createCallSubtitles({ onChange: text => { caption.value = text; } });
  const microphone = createMicrophoneLease({ onLevel: value => { if (!disposed) level.value = value; } });
  const owned = call => call && call.owner === getAuthToken();
  const current = (version, call) => !disposed && generation === version && attempt === call && owned(call);
  const terminal = call => ['STOPPED', 'FAILED'].includes(call?.status) && !call.turn_pending;
  const rejectedPreparation = error => [400, 401, 403, 404, 409, 422].includes(error?.status)
    || ['RTC_UNAVAILABLE', 'RTC_INVALID_CONFIG', 'RTC_SESSION_NOT_READY'].includes(error?.code);
  const uncertainStart = error => ['RTC_PROVIDER_UNCERTAIN', 'NETWORK_ERROR', 'REQUEST_TIMEOUT'].includes(error?.code);
  const missingStart = call => call?.status === 'FAILED' && call.turn_pending === false
    && call.last_error?.code === 'RTC_START_NOT_FOUND';
  const clearPoll = () => { clearTimeout(pollTimer); pollTimer = undefined; };

  function closeMedia() {
    clearPoll(); microphone.close();
    const previous = rtc; rtc = null;
    let closing;
    try { closing = Promise.resolve(previous?.close()).catch(() => {}); } catch (_) { /* Audio cleanup is best effort. */ }
    level.value = 0; agentState.value = 0; subtitles.reset();
    return closing;
  }
  function report(error) {
    if (disposed) return;
    phase.value = 'error';
    onError(error instanceof Error ? error : new Error('语音连接中断，请重新连接。'));
  }
  async function sync(call) {
    if (!disposed && owned(call)) await onSessionChange();
  }
  async function stopRemote(call) {
    if (!call?.callId) return false;
    if (disposed || !owned(call) || call.unload) {
      api.stopVoiceCallOnUnload(call.callId, call.owner);
      return false;
    }
    let result = await api.stopVoiceCall(call.callId);
    // Stop can finish the transport while the last model turn is still saving.
    for (let tries = 0; !terminal(result) && tries < 35 && !disposed && owned(call); tries++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (disposed || !owned(call)) return false;
      result = await api.getVoiceCall(call.callId);
      if (result.status === 'STOPPING' && !result.turn_pending) result = await api.stopVoiceCall(call.callId);
    }
    if (!terminal(result)) throw new Error('最后一轮讲述仍在保存，请稍后重试暂停。');
    if (attempt === call) { attempt = null; settling.value = false; }
    await sync(call);
    return true;
  }
  async function fail(error, call, result) {
    closeMedia(); generation++;
    phase.value = 'error'; settling.value = Boolean(call?.callId);
    report(error);
    try {
      if (terminal(result)) {
        if (attempt === call) attempt = null;
        await sync(call);
      } else await stopRemote(call);
    } catch (cause) { if (owned(call)) report(cause); }
    finally { settling.value = false; }
  }
  function poll(version, call) {
    clearPoll();
    pollTimer = setTimeout(async () => {
      if (!current(version, call)) return;
      try {
        const result = await api.getVoiceCall(call.callId);
        if (!current(version, call)) return;
        await sync(call);
        if (!current(version, call)) return;
        if (terminal(result)) {
          attempt = null; closeMedia(); phase.value = 'paused'; settling.value = false;
        } else if (result.turn_error || !['STARTING', 'ACTIVE'].includes(result.status)) {
          await fail(new Error(result.turn_error?.detail || '语音通话已停止，可以继续讲述。'), call);
        } else poll(version, call);
      } catch (error) { if (current(version, call)) await fail(error, call); }
    }, 1500);
  }
  function prepareMicrophone() {
    if (disposed) return Promise.reject(new Error('通话页面已关闭。'));
    return microphone.prepare();
  }
  async function confirmStart(version, call) {
    const deadline = Date.now() + 45000;
    while (current(version, call)) {
      let result;
      try { result = await api.getVoiceCall(call.callId); }
      catch (error) { if (!uncertainStart(error)) throw error; }
      if (!current(version, call)) return null;
      if (result?.turn_error) throw new Error(result.turn_error.detail || '语音通话暂时无法继续，请重试。');
      if (result?.status === 'ACTIVE' || terminal(result)) return result;
      if (Date.now() >= deadline) throw new Error('语音启动状态仍未确认，请稍后重新连接。');
      await new Promise(resolve => setTimeout(resolve, Math.min(1500, deadline - Date.now())));
    }
    return null;
  }
  function start(sessionId, options = {}) {
    if (disposed) return Promise.resolve(false);
    if (starting) return starting;
    if (phase.value === 'connected') return Promise.resolve(true);
    if (stopping) return Promise.resolve(false);
    const owner = getAuthToken();
    if (!owner) { report(new Error('请重新登录后继续讲述。')); return Promise.resolve(false); }
    if (attempt && (attempt.sessionId !== sessionId || attempt.owner !== owner)) {
      report(new Error('请先停止上一通语音，再继续讲述。')); return Promise.resolve(false);
    }
    const call = attempt ||= { sessionId, owner, requestId: crypto.randomUUID(), callId: '', options };
    call.unload = false;
    const version = ++generation;
    phase.value = 'connecting'; settling.value = false; subtitles.reset();
    const run = async (call, redialsLeft = 1, reacquire = false) => {
      try {
        if (reacquire) {
          await closeMedia();
          if (!current(version, call)) {
            if (attempt === call) { attempt = null; settling.value = false; }
            return false;
          }
          await prepareMicrophone();
          if (!current(version, call)) {
            if (attempt === call) { attempt = null; settling.value = false; }
            return false;
          }
        }
        await checkEnvironment();
        if (!current(version, call)) {
          if (!call.callId && attempt === call) { attempt = null; settling.value = false; }
          return false;
        }
        call.prepareSent = true;
        const prepared = await api.prepareVoiceCall(sessionId, call.requestId, call.options);
        call.callId = prepared.call_id;
        if (!current(version, call)) { await stopRemote(call); return false; }
        if (terminal(prepared)) {
          attempt = null; settling.value = false; phase.value = 'paused'; microphone.close();
          return false;
        }
        const transport = createRtc({
          acquireMicrophone: () => microphone.take(),
          onLevel: value => { if (current(version, call)) level.value = value; },
          onCaption: value => {
            if (current(version, call)) subtitles.accept(value);
          },
          onCaptionClear: event => {
            if (current(version, call)) subtitles.clear(event);
          },
          onAgentState: value => {
            if (!current(version, call)) return;
            agentState.value = value.state;
            subtitles.state(value);
            if (value.state === 5) void sync(call).catch(error => {
              if (current(version, call)) return fail(error, call);
            });
          },
          onError: error => { if (current(version, call)) void fail(error, call); },
          onDisconnected: () => { if (current(version, call)) void fail(new Error('语音连接已断开，请继续讲述重连。'), call); },
          onAutoplayBlocked: error => { if (current(version, call)) void fail(error, call); },
        });
        rtc = transport;
        let joinTimer;
        try {
          const joined = Promise.resolve(transport.join(prepared.credentials)).finally(() => {
            if (!current(version, call)) void transport.close();
          });
          await Promise.race([joined, new Promise((_, reject) => {
            joinTimer = setTimeout(() => reject(new Error('连接超时，请检查网络后重新连接。')), 20000);
          })]);
        } finally { clearTimeout(joinTimer); }
        if (!current(version, call)) { void transport.close(); return false; }
        let started;
        try { started = await api.startVoiceCall(call.callId); }
        catch (error) {
          if (!uncertainStart(error) || !current(version, call)) throw error;
          // A lost start response is not a failed task. Keep this room open and
          // query its original call; never issue another start while uncertain.
          started = await confirmStart(version, call);
        }
        if (!current(version, call)) { await stopRemote(call); return false; }
        if (missingStart(started) && redialsLeft > 0) {
          // Only the server's repeated missing-task confirmations permit a new
          // reservation. Reuse the saved opening request, not the old call ID.
          const replacement = { sessionId, owner, requestId: crypto.randomUUID(), callId: '', options: call.options };
          attempt = replacement;
          return await run(replacement, redialsLeft - 1, true);
        }
        if (!['STARTING', 'ACTIVE'].includes(started.status)) {
          await fail(new Error('语音通话未能启动，请重新连接。'), call, started);
          return false;
        }
        phase.value = 'connected'; poll(version, call);
        return true;
      } catch (error) {
        if (current(version, call)) {
          if (!call.callId && (!call.prepareSent || rejectedPreparation(error))) {
            attempt = null; settling.value = false; closeMedia(); report(error);
          } else await fail(error, call);
        }
        else if (call.callId) { try { await stopRemote(call); } catch (_) { /* Retry when returning to the page. */ } }
        else if (attempt === call) { attempt = null; settling.value = false; }
        return false;
      } finally { microphone.close(); }
    };
    starting = run(call).finally(() => { starting = null; });
    return starting;
  }
  function stop({ unload = false } = {}) {
    generation++; closeMedia();
    if (!disposed) phase.value = 'paused';
    const call = attempt;
    if (!call) { settling.value = false; return Promise.resolve(true); }
    call.unload = unload;
    settling.value = true;
    if (unload) {
      if (call.callId) api.stopVoiceCallOnUnload(call.callId, call.owner);
      return Promise.resolve(false);
    }
    if (stopping) return stopping;
    // If preparation is in flight, its completion will stop the returned reservation.
    if (!call.callId && starting) return starting.then(() => !attempt);
    stopping = (async () => {
      try {
        if (!call.callId) {
          const prepared = await api.prepareVoiceCall(call.sessionId, call.requestId, call.options);
          call.callId = prepared.call_id;
        }
        return await stopRemote(call);
      } catch (error) {
        if (!call.callId && rejectedPreparation(error) && attempt === call) {
          attempt = null; settling.value = false;
        }
        if (owned(call)) report(error);
        return false;
      }
    })().finally(() => { stopping = null; settling.value = false; });
    return stopping;
  }
  function dispose() { void stop({ unload: true }); disposed = true; }
  return { phase, agentState, caption, level, settling, prepareMicrophone, start, stop, dispose };
}
