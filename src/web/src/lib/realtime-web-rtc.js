// TRTC Web v5 API: https://web.sdk.qcloud.com/trtc/webrtc/v5/doc/zh-cn/TRTC.html
// Keep this version fixed; the WeChat SDK cannot run in a browser.
export const TRTC_VERSION = "5.19.2";
export const TRTC_SCRIPT_URL = `https://cdn.jsdelivr.net/npm/trtc-sdk-v5@${TRTC_VERSION}/trtc.js`;

let sdkLoading;
const mediaConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function sdkFailure(error, code, message) {
  // v5 wraps server failures in code=2 (SERVER_ERROR), with the server code
  // in extraCode. Older wrappers can leave it in the diagnostic message.
  // Never expose that raw message: it may contain connection credentials.
  const diagnostic = typeof error?.message === "string" ? error.message : "";
  const suspended = [error?.code, error?.extraCode].some(value => String(value) === "-100013")
    || /\b(?:extraCode|code|result)\s*[:=]\s*-100013\b|\[\s*-100013\s*\]/i.test(diagnostic)
    || String(error?.code) === "2" && /\bTRTC service is suspended\b/i.test(diagnostic);
  return suspended
    ? failure("RTC_SERVICE_SUSPENDED", "腾讯云实时语音服务已停用，请检查 TRTC 套餐余额及腾讯云账户是否欠费，恢复服务后重试。")
    : failure(code, message);
}

export function microphoneFailure(error) {
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name)) {
    return failure("MIC_PERMISSION_DENIED", "无法使用麦克风，请在浏览器地址栏允许麦克风权限后重试。");
  }
  if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name)) {
    return failure("MIC_NOT_FOUND", "没有找到麦克风，请连接麦克风后重试。");
  }
  return failure("MIC_UNAVAILABLE", "无法打开麦克风，请检查设备是否被其他应用占用后重试。");
}

function stopTrack(track) {
  if (!track) return;
  try { track.enabled = false; } catch (_) { /* Already detached. */ }
  try { track.stop(); } catch (_) { /* Continue releasing other tracks. */ }
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) stopTrack(track);
}

export function stopMicrophoneStream(stream) {
  stopStream(stream);
}

function browserEnvironment() {
  if (!globalThis.isSecureContext) {
    throw failure("RTC_INSECURE_CONTEXT", "请在本机使用 localhost、127.0.0.1，或通过 HTTPS 打开通话页面。");
  }
  if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.RTCPeerConnection) {
    throw failure("RTC_UNSUPPORTED", "当前浏览器不支持实时语音，请使用新版 Chrome 浏览器。");
  }
}

// Capture only: no SDK, connection, recording or upload is started here.
export async function openMicrophone() {
  browserEnvironment();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    if (!stream?.getAudioTracks?.().length) {
      stopStream(stream);
      throw failure("MIC_NOT_FOUND", "没有找到可用麦克风。");
    }
    return stream;
  } catch (error) {
    throw error?.code === "MIC_NOT_FOUND" ? error : microphoneFailure(error);
  }
}

// Analyse only the stream already owned by the caller. The graph has no
// destination connection, so it cannot play the microphone back through speakers.
// A missing/suspended Web Audio context must never prevent a voice conversation.
export function startMicrophoneMeter(stream, onLevel) {
  if (typeof onLevel !== "function") return () => {};
  let context, source, analyser, timer;
  let stopped = false;
  const emit = value => {
    try { onLevel(value); } catch (_) { /* Visual feedback cannot interrupt audio. */ }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { source?.disconnect(); } catch (_) { /* Already disconnected. */ }
    try { analyser?.disconnect(); } catch (_) { /* Already disconnected. */ }
    try { Promise.resolve(context?.close()).catch(() => {}); } catch (_) { /* Already closed. */ }
    emit(0);
  };
  try {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) return stop;
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const useFloat = typeof analyser.getFloatTimeDomainData === "function";
    const samples = useFloat ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
    const sample = () => {
      if (stopped) return;
      try {
        if (!stream.getAudioTracks().some(track => track.enabled !== false && track.readyState !== "ended")) {
          emit(0);
          return;
        }
        if (useFloat) analyser.getFloatTimeDomainData(samples);
        else analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const value of samples) {
          const amplitude = useFloat ? value : (value - 128) / 128;
          energy += amplitude * amplitude;
        }
        const level = Math.sqrt(energy / samples.length);
        emit(Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0);
      } catch (_) { stop(); }
    };
    timer = setInterval(sample, 80);
    try { Promise.resolve(context.resume?.()).catch(() => {}); } catch (_) { /* Permission gesture can resume later. */ }
  } catch (_) { stop(); }
  return stop;
}

async function loadSdk() {
  if (globalThis.TRTC?.create) return globalThis.TRTC;
  if (!sdkLoading) {
    sdkLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TRTC_SCRIPT_URL;
      script.integrity = "sha384-AKsoqgbf1OnM/4gXNYEI5HycEZ2AbcHPhrIK+LbjxFVexm3qKhFCDwhZNLRMj9U7";
      script.async = true;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (error) { script.remove(); reject(error); }
        else resolve(globalThis.TRTC);
      };
      const timer = setTimeout(() => done(failure("RTC_SDK_UNAVAILABLE", "通话组件加载超时，请检查网络后重试。")), 15000);
      script.onload = () => done(globalThis.TRTC?.create ? null : failure("RTC_SDK_UNAVAILABLE", "通话组件未能加载，请刷新页面重试。"));
      script.onerror = () => done(failure("RTC_SDK_UNAVAILABLE", "通话组件加载失败，请检查网络后重试。"));
      document.head.appendChild(script);
    }).catch((error) => { sdkLoading = null; throw error; });
  }
  return sdkLoading;
}

// These checks load code and inspect browser capabilities; they never open a mic.
export async function checkEnvironment() {
  browserEnvironment();
  const SDK = await loadSdk();
  const support = await SDK.isSupported();
  const detail = support?.detail;
  const audioSupported = detail
    ? detail.isBrowserSupported && detail.isWebRTCSupported && detail.isMediaDevicesSupported
    : support?.result;
  if (!audioSupported) throw failure("RTC_UNSUPPORTED", "当前浏览器不支持实时语音，请使用新版 Chrome 浏览器。");
  SDK.setLogLevel?.(4, false);
  return true;
}

// Only call from the explicit Start action. The probe never publishes audio,
// including when permission is granted after the page has been hidden/closed.
export async function preflightMicrophone() {
  let stream;
  try {
    stream = await openMicrophone();
  } finally {
    stopStream(stream);
  }
}

function roomOptions(credentials) {
  const roomId = Number(credentials?.room_id);
  const sdkAppId = Number(credentials?.sdk_app_id);
  const privateMapKey = credentials?.private_map_key;
  if (!Number.isInteger(roomId) || roomId < 1 || roomId > 4294967294 ||
      !Number.isInteger(sdkAppId) || sdkAppId < 1 ||
      ![credentials?.user_id, credentials?.user_sig]
        .every((value) => typeof value === "string" && value.trim()) ||
      privateMapKey !== undefined && (typeof privateMapKey !== "string" || !privateMapKey.trim())) {
    throw failure("RTC_CREDENTIALS_INVALID", "通话连接信息不完整，请重试。");
  }
  return {
    sdkAppId, roomId, userId: credentials.user_id, userSig: credentials.user_sig,
    ...(privateMapKey === undefined ? {} : { privateMapKey }), scene: "rtc",
    autoReceiveAudio: true, autoReceiveVideo: false, enableAutoPlayDialog: false,
  };
}

function settleWithin(promise, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    Promise.resolve(promise).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
}

// The agent sends UTF-8 JSON through cmdId 1, not SEI/video data. SubtitleMode
// 1 provides sentence-level audio timing, but a single caption can still be long.
// The controller handles phrase display; this adapter validates received packets.
// https://cloud.tencent.com/document/product/647/115503
// https://cloud.tencent.com/document/product/647/115502
function captionDiagnostics(enabled) {
  let received = 0, accepted = 0, dropped = 0;
  const reasons = {};
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array'
    : value instanceof ArrayBuffer ? 'arraybuffer' : ArrayBuffer.isView(value) ? 'typedarray' : typeof value;
  return (reason, event, message) => {
    if (!enabled) return;
    received += 1;
    if (reason === 'accepted_caption' || reason === 'accepted_state') accepted += 1;
    else dropped += 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
    // Opt-in local diagnostics are bounded and contain no message text, IDs,
    // timestamps, sequence values, credentials or raw SDK/message objects.
    if (received > 200) return;
    const payload = message?.payload;
    try {
      console.info('[manji-caption]', {
        received, accepted, dropped, reason, reasons: { ...reasons },
        messageType: message?.type === 10000 ? 'caption' : message?.type === 10001 ? 'agent_state' : 'unknown',
        fieldTypes: {
          transportSender: type(event?.userId), cmdId: type(event?.cmdId), seq: type(event?.seq), data: type(event?.data),
          message: type(message), type: type(message?.type), sender: type(message?.sender), receiver: type(message?.receiver),
          payload: type(payload), roundid: type(payload?.roundid), text: type(payload?.text),
          start_time: type(payload?.start_time), end_time: type(payload?.end_time), end: type(payload?.end),
          state: type(payload?.state), timestamp: type(payload?.timestamp),
        },
      });
    } catch (_) { /* Diagnostics must not change playback or caption behavior. */ }
  };
}

function agentMessages(credentials, { onCaption, onCaptionClear, onAgentState, captionDebug = false, captionClock } = {}) {
  const bot = credentials.bot_user_id;
  const report = captionDiagnostics(captionDebug === true);
  const clock = captionClock || {
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => clearTimeout(timer),
  };
  const rounds = new Map();
  let closed = false, activeRoundId = '', displayedRoundId = '', lastTimestamp = -1, messageOrder = 0;
  const seconds = value => {
    if (typeof value !== 'string' || !/^\d{2,}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return NaN;
    const [hours, minutes, seconds] = value.split(':').map(Number);
    return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : NaN;
  };
  const getRound = id => {
    if (!rounds.has(id)) rounds.set(id, {
      phase: 'open', started: false, startedOrder: null, deadline: null, timer: null,
      sentenceStart: -1, sentenceEnd: -1, sentenceComplete: false,
      lastStateTimestamp: null, firstStateOrder: null, captions: new Set(), states: new Set(),
    });
    return rounds.get(id);
  };
  const cancelTimer = round => {
    if (round.timer !== null) clock.clearTimeout(round.timer);
    round.timer = null;
  };
  const clearCaption = (roundId, reason) => {
    if (displayedRoundId !== roundId) return;
    displayedRoundId = '';
    onCaptionClear({ roundId, reason });
  };
  const selectRound = (next, stateTimestamp = null) => {
    const current = getRound(next);
    current.started = true;
    if (current.startedOrder === null) current.startedOrder = messageOrder;
    const switching = activeRoundId !== next;
    if (!switching && stateTimestamp === null) return;
    // A done event can precede a round's first caption. Retire that pending
    // tail window too. A state arriving after its own caption also closes old
    // listening rounds, but preserves listening observed after this round began.
    for (const [id, previous] of rounds) {
      const knownEarlierState = stateTimestamp !== null && previous.lastStateTimestamp !== null
        && previous.lastStateTimestamp <= stateTimestamp && previous.firstStateOrder < current.startedOrder;
      if (id === next || !(switching && previous.started || knownEarlierState) || previous.phase === 'retired') continue;
      previous.phase = 'retired';
      cancelTimer(previous);
      previous.captions.clear(); previous.states.clear();
      clearCaption(id, 'new_round');
    }
    activeRoundId = next;
  };
  const expireRound = (roundId, round) => {
    if (closed || round.phase !== 'finishing' || clock.now() < round.deadline) return;
    round.phase = 'expired';
    cancelTimer(round);
    round.captions.clear();
    clearCaption(roundId, 'done_timeout');
  };
  const finishRound = (roundId, round) => {
    // One deadline per round, including when "done" precedes its first caption.
    // A duplicate done event or a valid tail caption never extends the window.
    if (round.phase !== 'open') return;
    round.phase = 'finishing';
    round.deadline = clock.now() + 2000;
    const deadline = round.deadline;
    const expire = () => {
      if (closed || round.phase !== 'finishing' || round.deadline !== deadline) return;
      if (clock.now() < deadline) {
        round.timer = clock.setTimeout(expire, deadline - clock.now());
        return;
      }
      expireRound(roundId, round);
    };
    round.timer = clock.setTimeout(expire, deadline - clock.now());
  };
  const receive = event => {
    if (closed) return;
    messageOrder += 1;
    let message;
    const drop = reason => report(reason, event, message);
    if (!bot) return drop('missing_bot_identity');
    if (event?.cmdId !== 1) return drop('unexpected_command');
    if (event.userId !== bot) return drop('unexpected_transport_sender');
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data)); }
    catch (_) { return drop('invalid_json'); }
    if (!message) return drop('missing_message');
    if (message.sender !== bot) return drop('unexpected_speaker');
    if (![10000, 10001].includes(message.type)) return drop('unexpected_message_type');
    // Live AI captions can omit receiver for room broadcasts. The transport
    // sender and speaking bot were already checked; explicit recipients still apply.
    if (message.receiver !== undefined) {
      if (!Array.isArray(message.receiver) || !message.receiver.every(user => typeof user === 'string')) return drop('invalid_receivers');
      if (message.receiver.length && !message.receiver.includes(credentials.user_id)) return drop('unexpected_recipient');
    }
    const payload = message.payload;
    if (!payload || typeof payload.roundid !== 'string' || !payload.roundid.trim()) return drop('invalid_round');
    const roundId = payload.roundid, round = getRound(roundId);
    if (round.phase === 'retired') return drop('retired_round');
    // The SDK orders transport packets and permits sequence resets. Do not
    // impose a second call-wide sequence watermark on independent rounds.
    expireRound(roundId, round);
    if (message.type === 10001) {
      if (!Number.isInteger(payload.state) || payload.state < 1 || payload.state > 5) return drop('invalid_state');
      if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp) || payload.timestamp < 0) return drop('invalid_timestamp');
      if (payload.timestamp < lastTimestamp) return drop('stale_timestamp');
      if (round.phase !== 'open' && [2, 3].includes(payload.state)) return drop('ended_round_state');
      const key = JSON.stringify([payload.timestamp, payload.state]);
      if (round.states.has(key)) return drop('duplicate_state');
      round.states.add(key);
      lastTimestamp = payload.timestamp;
      round.lastStateTimestamp = payload.timestamp;
      if (round.firstStateOrder === null) round.firstStateOrder = messageOrder;
      // Listening for the next user turn must not retire audio still playing
      // from the preceding round. Only thought/speech or a new caption does.
      if ([2, 3].includes(payload.state)) selectRound(roundId, payload.timestamp);
      if (payload.state === 4) {
        round.started = true;
        if (round.startedOrder === null) round.startedOrder = messageOrder;
        round.phase = 'interrupted';
        cancelTimer(round);
        round.captions.clear();
        clearCaption(roundId, 'interrupted');
      } else if (payload.state === 5) {
        round.started = true;
        if (round.startedOrder === null) round.startedOrder = messageOrder;
        finishRound(roundId, round);
      }
      report('accepted_state', event, message);
      onAgentState({ state: payload.state, roundId, timestamp: payload.timestamp });
      return;
    }
    if (['interrupted', 'expired'].includes(round.phase)) return drop('ended_round_caption');
    if (typeof payload.text !== 'string' || !payload.text.trim()) return drop('invalid_caption_text');
    if (typeof payload.end !== 'boolean') return drop('invalid_caption_end');
    const start = seconds(payload.start_time), end = seconds(payload.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return drop('invalid_caption_time');
    if (start < round.sentenceStart || start === round.sentenceStart && end < round.sentenceEnd
        || start === round.sentenceStart && round.sentenceComplete && !payload.end) return drop('stale_caption_revision');
    const key = JSON.stringify([payload.start_time, payload.end_time, payload.text, payload.end]);
    if (round.captions.has(key)) return drop('duplicate_caption');
    selectRound(roundId);
    round.sentenceStart = start; round.sentenceEnd = end; round.sentenceComplete = payload.end;
    round.captions.add(key);
    displayedRoundId = roundId;
    report('accepted_caption', event, message);
    onCaption({ text: payload.text, roundId, startTime: payload.start_time, endTime: payload.end_time, complete: payload.end });
  };
  return {
    receive,
    close() {
      closed = true;
      for (const round of rounds.values()) cancelTimer(round);
      rounds.clear();
      activeRoundId = displayedRoundId = '';
    },
  };
}

export function createRtc({ onError, onDisconnected, onAutoplayBlocked, onCaption, onCaptionClear, onAgentState, captionDebug = false, captionClock, acquireMicrophone, onLevel } = {}) {
  let rtc, SDK, localStream, joinPromise, cleanupPromise, captions, stopMeter;
  let closed = false, joining = false, roomEntered = false, audioStarted = false, muted = false;
  let destroyed = false, cleanupAgain = false;
  const tracks = new Set();
  const listeners = [];
  const notify = (callback, error) => {
    if (!closed && typeof callback === "function") callback(error);
  };
  const requireOpen = () => {
    if (closed) throw failure("RTC_CLOSED", "通话已结束。");
  };
  const sdkCall = (method, ...args) => {
    try { return Promise.resolve(rtc?.[method]?.(...args)).catch(() => {}); }
    catch (_) { return Promise.resolve(); }
  };
  const silenceNow = () => {
    stopMeter?.();
    stopMeter = null;
    stopStream(localStream);
    for (const track of tracks) stopTrack(track);
    if (rtc && !destroyed) {
      try { stopTrack(rtc.getAudioTrack()); } catch (_) { /* No local track yet. */ }
      // setRemoteAudioVolume is synchronous. TRACK also fences late arrivals.
      void sdkCall("setRemoteAudioVolume", "*", 0);
    }
  };
  const cleanup = () => {
    if (!rtc || destroyed) return Promise.resolve();
    if (cleanupPromise) { cleanupAgain = true; return cleanupPromise; }
    cleanupPromise = (async () => {
      silenceNow();
      await Promise.all([
        settleWithin(sdkCall("stopLocalAudio")),
        settleWithin(sdkCall("muteRemoteAudio", "*", true)),
        // Exiting while enterRoom is pending also interrupts the pending join.
        settleWithin(sdkCall("exitRoom")),
      ]);
      silenceNow();
      if (!joining) {
        try { rtc.destroy(); destroyed = true; } catch (_) { /* Keep the track fence alive if exit failed. */ }
        if (destroyed) for (const [event, handler] of listeners) rtc.off(event, handler);
      }
    })().finally(() => {
      cleanupPromise = null;
      if (cleanupAgain) { cleanupAgain = false; void cleanup(); }
    });
    return cleanupPromise;
  };
  const close = () => {
    closed = true;
    captions?.close();
    silenceNow();
    return cleanup();
  };
  const listen = (name, handler) => {
    const event = SDK.EVENT[name];
    if (!event) return;
    rtc.on(event, handler);
    listeners.push([event, handler]);
  };

  return {
    join(credentials) {
      if (closed) return Promise.reject(failure("RTC_CLOSED", "通话已结束。"));
      if (joinPromise) return joinPromise;
      joining = true;
      joinPromise = (async () => {
        const options = roomOptions(credentials);
        await checkEnvironment();
        requireOpen();
        SDK = globalThis.TRTC;
        rtc = SDK.create();
        captions = agentMessages(credentials, {
          onCaption: caption => notify(onCaption, caption),
          onCaptionClear: event => notify(onCaptionClear, event),
          onAgentState: state => notify(onAgentState, state), captionDebug, captionClock,
        });
        listen("CUSTOM_MESSAGE", event => { if (!closed) captions.receive(event); });
        // Keep this listener after close until destroy succeeds: the SDK may
        // deliver a track after an in-flight join/publish operation settles.
        listen("TRACK", ({ track }) => {
          if (!track) return;
          tracks.add(track);
          if (closed || track.kind !== "audio") stopTrack(track);
        });
        listen("ERROR", error => {
          if (roomEntered) notify(onError, sdkFailure(error, "RTC_ERROR", "语音连接出现异常，请挂断后重试。"));
        });
        listen("KICKED_OUT", () => notify(onDisconnected, failure("RTC_DISCONNECTED", "通话连接已断开，请重新开始。")));
        listen("CONNECTION_STATE_CHANGED", ({ state }) => {
          // Failed enterRoom calls emit DISCONNECTED while cleaning up, before
          // their promise rejects. Preserve that promise's actual error instead
          // of letting the controller cancel it as a generic disconnection.
          if (roomEntered && state === "DISCONNECTED") notify(onDisconnected, failure("RTC_DISCONNECTED", "通话连接已断开，请重新开始。"));
        });
        listen("AUTOPLAY_FAILED", () => notify(onAutoplayBlocked, failure("RTC_AUTOPLAY_BLOCKED", "浏览器阻止了声音播放，请再次点击开始通话。")));
        try {
          localStream = await (typeof acquireMicrophone === "function"
            ? acquireMicrophone() : navigator.mediaDevices.getUserMedia(mediaConstraints));
        } catch (error) {
          if (typeof error?.code === "string" && /^(RTC_|MIC_)/.test(error.code)) throw error;
          throw microphoneFailure(error);
        }
        if (closed) stopStream(localStream);
        requireOpen();
        const track = localStream?.getAudioTracks?.()[0];
        if (!track) throw failure("MIC_NOT_FOUND", "没有找到可用麦克风。");
        if (track.readyState === "ended") throw failure("MIC_UNAVAILABLE", "麦克风已关闭，请重新开启后重试。");
        track.enabled = !muted;
        stopMeter = startMicrophoneMeter(localStream, onLevel);
        await rtc.enterRoom(options);
        requireOpen();
        roomEntered = true;
        // Own the track so close() can stop capture synchronously even while
        // the SDK's startLocalAudio/exitRoom operation is still pending.
        const initialMute = muted;
        await rtc.startLocalAudio({ mute: initialMute, option: { audioTrack: track } });
        audioStarted = true;
        requireOpen();
        if (muted !== initialMute) await rtc.updateLocalAudio({ mute: muted });
        requireOpen();
      })().catch((error) => {
        const wasClosed = closed;
        void close();
        if (wasClosed) throw failure("RTC_CLOSED", "通话已结束。");
        if (typeof error?.code === "string" && /^(RTC_|MIC_)/.test(error.code)) throw error;
        throw sdkFailure(error, "RTC_JOIN_FAILED", "实时语音连接失败，请检查网络及通话配置后重试。");
      }).finally(() => {
        joining = false;
        if (closed) { silenceNow(); void cleanup(); }
      });
      return joinPromise;
    },
    async mute(value) {
      requireOpen();
      muted = Boolean(value);
      for (const track of localStream?.getAudioTracks?.() || []) track.enabled = !muted;
      if (audioStarted) {
        try { await rtc.updateLocalAudio({ mute: muted }); }
        catch (_) { if (!closed) throw failure("RTC_MUTE_FAILED", "麦克风状态切换失败，请挂断后重试。"); }
        finally { if (closed) silenceNow(); }
      }
    },
    close,
  };
}
