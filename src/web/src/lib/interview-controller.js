/* Interview interview lifecycle. DOM, browser microphone and RTC are injected. */
const captionWords = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const captionSeconds = value => value ? value.split(':').reduce((total, part) => total * 60 + Number(part), 0) : null;
const textLength = value => Array.from(value).length;

function captionParts(text) {
  const words = captionWords ? Array.from(captionWords.segment(text), item => item.segment) : Array.from(text);
  const parts = [];
  let part = '';
  for (const word of words) {
    // Keep words and punctuation intact; a provider sentence may be an entire reply.
    if (part && textLength(part + word) > 16 && !/^[\s，。！？；：、,.!?;:）)”’」』]+$/u.test(word)) {
      parts.push(part); part = '';
    }
    if (!part && parts.length && /^[，。！？；：、,.!?;:）)”’」』]+$/u.test(word)) parts[parts.length - 1] += word;
    else part += word;
    if (part && (/[\n]/u.test(word) || textLength(part) >= 6 && /[，。！？；：、,.!?;:]$/u.test(word))) {
      parts.push(part); part = '';
    }
  }
  if (part) parts.push(part);
  return parts;
}

export function createInterviewController({
  api, storage, createRtc, checkEnvironment = async () => {}, preflightMicrophone = async () => {},
  onChange = () => {}, onSession = () => {}, newRequestId = () => crypto.randomUUID(),
  schedule = setTimeout, cancel = clearTimeout, now = () => globalThis.performance?.now?.() ?? Date.now(),
}) {
  const view = {
    phase: 'loading', entry: 'GENERAL', sessionId: '', account: '', isGuest: false, notice: '', errorStage: '',
    turns: [], resumeOpenings: [], photos: [], attachments: [], opening: '', question: '', transcript: '', caption: '', captionSpeaker: '',
    captionRoundId: '', captionSegments: [], agentState: 0, connectionState: 'idle', connectionError: null,
    restoredSession: false, restoredDraft: false,
    muted: false, saving: false, transportClosed: true, materialState: '', maxImages: 250, realtimeAvailable: false, organization: null, readOnly: false,
  };
  let alive = true, visible = true, initialized = false, token = '', owner = '', biographyId = '';
  let activity = 'PAUSED', interaction = 'voice', state = {}, rtc = null, stopWanted = false;
  let initializing, creating, starting = false, inputBusy = false, retryingInput = false, finishing = false, pausePromise, resuming;
  let loadedOwner = '', initializeOptions = {};
  let uploading = 0, uploadSequence = 0, joinAbort, pollVersion = 0;
  let intentVersion = 0, organizationVersion = 0, pauseOperation = null;
  let organizationMaterialRevision = -1;
  let pendingAutoResume = false;
  let pollTimer, heartbeatTimer, joinTimer, organizationTimer, inputTimer;
  let captionTimer, captionVersion = 0, captionNextAt = 0, receivedCaptionRound = '';
  let captionSentences = [];
  const files = new Map(), waiters = [];
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const terminal = () => state.finishRequested || ['FINISHING', 'FINISHED'].includes(activity);
  const sameOwner = () => Boolean(token && token === api.getAuthToken());
  const usable = () => alive && visible && sameOwner() && !stopWanted && !terminal();
  const storageKey = (sessionId = view.sessionId, entry = view.entry) => `manji.web2.interview.${encodeURIComponent(owner)}.${sessionId ? encodeURIComponent(sessionId) : 'new.' + entry}`;
  const definitive = error => [403, 422].includes(error?.status) ||
    error?.status === 503 && error.code === 'RESUME_OPENING_FAILED' ||
    error?.status === 409 && ['REALTIME_START_REJECTED', 'REALTIME_SESSION_UNAVAILABLE', 'SESSION_COMPLETED'].includes(error.code);
  const capacityError = error => error?.status === 413 && ['PHOTO_GROUP_TOO_LARGE', 'PHOTO_CONTEXT_TOO_LARGE', 'CONTEXT_TOO_LARGE'].includes(error.code);
  const materialIssue = job => ['MATERIAL_WAITING', 'MATERIAL_CONFLICT', 'MATERIAL_DELAYED'].includes(job?.phase)
    || ['MATERIAL_WAITING', 'MATERIAL_CONFLICT', 'MATERIAL_DELAYED'].includes(job?.error_code);
  const materialDelayed = job => job?.phase === 'MATERIAL_DELAYED' || job?.error_code === 'MATERIAL_DELAYED';
  const transient = error => !error?.status || [408, 429].includes(error.status) || error.status >= 500;
  const waitingForTransport = () => !view.transportClosed;
  const sessionTransportClosed = session => typeof session.transport_closed === 'boolean' ? session.transport_closed
    : !session.saving && !session.active_call_id && !session.call_id;
  const callTransportClosed = call => typeof call.transport_closed === 'boolean' ? call.transport_closed
    : ['STOPPED', 'FAILED'].includes(call.status) && call.saving === false && !call.error;
  function photoReady() {
    if (view.entry !== 'PHOTO') return true;
    const last = view.turns.at(-1);
    const hasReply = view.turns.some(turn => turn.response_state === 'GENERATED'
      && typeof turn.assistant_text === 'string' && turn.assistant_text.trim() && turn.media_ids?.length);
    const waitingPhoto = last?.media_ids?.length && (['GENERATING', 'FAILED'].includes(last.response_state) || !last.assistant_text?.trim());
    return Boolean(view.sessionId && hasReply && !waitingPhoto);
  }
  function snapshot() {
    const pending = state.input ? clone(state.input) : null;
    const busy = Boolean(initializing || creating || starting || resuming || inputBusy || retryingInput || finishing || uploading);
    const available = initialized && !view.readOnly && sameOwner() && !terminal();
    const unsettled = Boolean(state.call || state.pausePending || starting || pausePromise || waitingForTransport());
    return { ...clone(view), pendingInput: pending, pending: unsettled, busy, initialized,
      finishPending: Boolean(state.finishRequested), activityState: activity,
      canSubmit: available && !inputBusy && !retryingInput && !starting && !uploading && !pending,
      canStart: available && !busy && !pending && !unsettled && view.phase !== 'connected' && photoReady(),
      canPause: available && Boolean(rtc || starting || state.call || activity === 'ACTIVE'),
      canFinish: initialized && !view.readOnly && sameOwner() && Boolean(view.sessionId) && !finishing && !['FINISHING', 'FINISHED'].includes(activity),
      canRetryInput: available && Boolean(pending) && !inputBusy && !retryingInput && !uploading && pending.state !== 'CAPACITY',
      canRetryCall: available && !pending && !busy && (view.connectionState === 'failed' || view.errorStage === 'call' || view.errorStage === 'pause' || unsettled),
      canRetryOrganization: view.organization?.status === 'FAILED' && !materialIssue(view.organization) && view.organization.retry_allowed !== false,
    };
  }
  function emit(patch = {}) { Object.assign(view, patch); if (alive) onChange(snapshot()); }
  function stopCaptionQueue() {
    ++captionVersion;
    if (captionTimer !== undefined) cancel(captionTimer);
    captionTimer = undefined;
    captionSentences = []; receivedCaptionRound = ''; captionNextAt = 0;
  }
  function clearCaption() {
    stopCaptionQueue();
    Object.assign(view, { caption: '', captionSpeaker: '', captionRoundId: '', captionSegments: [] });
  }
  function publishCaption() {
    const segments = captionSentences.flatMap(sentence => sentence.parts.slice(0, sentence.shown).map((text, index) => ({
      text, key: `${sentence.startTime}:${index}`, startTime: sentence.startTime,
      endTime: sentence.endTime, complete: sentence.complete,
    })));
    emit({ captionSegments: segments, caption: segments.map(item => item.text).join('\n\n'),
      captionSpeaker: 'assistant', captionRoundId: receivedCaptionRound });
  }
  function nextCaptionSentence() { return captionSentences.find(sentence => sentence.shown < sentence.parts.length); }
  function scheduleCaption() {
    if (captionTimer !== undefined || !nextCaptionSentence()) return;
    const version = captionVersion;
    const timer = schedule(() => {
      if (version !== captionVersion || captionTimer !== timer) return;
      captionTimer = undefined;
      if (!usable() || !rtc) { clearCaption(); emit(); return; }
      revealCaptionPart();
    }, Math.max(0, captionNextAt - now()));
    captionTimer = timer;
  }
  function revealCaptionPart() {
    const sentence = nextCaptionSentence();
    if (!sentence) return;
    const part = sentence.parts[sentence.shown++];
    const duration = (captionSeconds(sentence.endTime) - captionSeconds(sentence.startTime)) * 1000;
    // The provider has no word timings. Pace phrases using its sentence duration
    // when available, otherwise use a reading pace; this is not word-level sync.
    const perCharacter = duration > 0 && duration <= 120000 ? duration / textLength(sentence.text) : 180;
    captionNextAt = now() + Math.max(400, Math.min(3000, textLength(part) * perCharacter));
    publishCaption();
    scheduleCaption();
  }
  function acceptCaption(caption) {
    if (typeof caption.text !== 'string' || !caption.text.trim()) return;
    if (caption.roundId !== receivedCaptionRound) {
      stopCaptionQueue(); receivedCaptionRound = caption.roundId;
    }
    // Compare received sentences, including ones still queued for display.
    const previous = captionSentences.at(-1);
    const start = captionSeconds(caption.startTime);
    if (previous && start < captionSeconds(previous.startTime)) return;
    const revising = previous && start === captionSeconds(previous.startTime);
    if (revising && (captionSeconds(caption.endTime) < captionSeconds(previous.endTime)
        || previous.complete && !caption.complete)) return;
    if (revising && previous.text === caption.text && captionSeconds(previous.endTime) === captionSeconds(caption.endTime)
        && previous.complete === (caption.complete === true)) return;
    const parts = captionParts(caption.text);
    let shown = revising ? Math.min(previous.shown, parts.length) : 0;
    if (revising && caption.text.startsWith(previous.text)) {
      // Appending text can change word boundaries ("the n" -> "the neighborhood").
      // Never hide a prefix that was already visible just because it re-segments.
      const visibleLength = previous.parts.slice(0, previous.shown).join('').length;
      while (shown < parts.length && parts.slice(0, shown).join('').length < visibleLength) shown++;
    }
    const sentence = { text: caption.text, parts, shown,
      startTime: revising ? previous.startTime : caption.startTime || '',
      endTime: caption.endTime || '', complete: caption.complete === true };
    if (revising) {
      captionSentences[captionSentences.length - 1] = sentence;
      if (sentence.shown) publishCaption();
    } else captionSentences.push(sentence);
    if (captionTimer === undefined && now() >= captionNextAt) revealCaptionPart();
    else scheduleCaption();
  }
  function failConnection(error, fallback = '语音连接未成功，请重试。') {
    view.connectionState = 'failed';
    view.connectionError = { code: typeof error?.code === 'string' ? error.code : 'RTC_CONNECTION_FAILED', message: error?.message || fallback };
  }
  function persist() {
    if (!sameOwner() || !owner) return;
    state.entry = view.entry; state.sessionId = view.sessionId;
    state.attachments = clone(view.attachments);
    storage.setItem(storageKey(), JSON.stringify(state));
  }
  function bestEffortPersist() { try { persist(); } catch (_) { /* The next explicit action retries durable storage. */ } }
  function migrateInterviewStorage() {
    const oldPrefix = `manji.web2.service3.${encodeURIComponent(owner)}.`;
    const moves = [];
    function include(source, destination) {
      const raw = storage.getItem(source);
      if (raw) moves.push({ source, destination, raw });
    }
    for (const entry of ['GENERAL', 'PHOTO']) include(oldPrefix + 'new.' + entry, storageKey('', entry));
    if (view.sessionId) include(oldPrefix + encodeURIComponent(view.sessionId), storageKey(view.sessionId));
    const legacyRaw = storage.getItem(oldPrefix + 'new');
    if (legacyRaw) {
      let saved;
      try { saved = JSON.parse(legacyRaw); } catch (_) { /* Keep an unreadable legacy record untouched. */ }
      if (['GENERAL', 'PHOTO'].includes(saved?.entry)) moves.push({ source: oldPrefix + 'new', destination: storageKey('', saved.entry), raw: legacyRaw });
    }
    const destinations = new Map();
    for (const { destination, raw } of moves) {
      const existing = destinations.get(destination) || storage.getItem(destination);
      if (existing && existing !== raw) throw new Error('发现两份不同的访谈恢复记录，请保留当前页面并联系支持。');
      destinations.set(destination, raw);
    }
    // Copy every record before deleting any source. A failed write or an
    // interrupted upgrade can retry without replacing a pending request.
    for (const [destination, raw] of destinations) {
      if (storage.getItem(destination) !== raw) storage.setItem(destination, raw);
      if (storage.getItem(destination) !== raw) throw new Error('访谈恢复记录暂时无法保存，请重试。');
    }
    for (const { source } of moves) storage.removeItem(source);
  }
  function migrateLegacyDraft() {
    const legacyKey = `manji.web2.interview.${encodeURIComponent(owner)}.new`;
    const raw = storage.getItem(legacyKey);
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch (_) { return; }
    // An unrecognized legacy entry remains untouched; never guess which of
    // the two new entry points owns an outstanding creation request.
    if (!['GENERAL', 'PHOTO'].includes(saved?.entry)) return;
    const destination = storageKey('', saved.entry), existing = storage.getItem(destination);
    if (existing && existing !== raw) return;
    if (!existing) storage.setItem(destination, raw);
    // Remove the legacy copy only after the exact record is durably readable.
    if (storage.getItem(destination) === raw) storage.removeItem(legacyKey);
  }
  function readSaved(id) {
    const raw = storage.getItem(storageKey(id));
    if (!raw) return {};
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || (id && saved.sessionId !== id)) throw new Error('恢复记录不完整，请重新打开这次访谈。');
    if (saved.call && (typeof saved.call.requestId !== 'string' || typeof saved.call.callId !== 'string')) throw new Error('通话恢复记录不完整，请重新打开这次访谈。');
    if (saved.input && (!saved.input.requestId || !Array.isArray(saved.input.mediaIds))) throw new Error('输入恢复记录不完整，请重新打开这次访谈。');
    return saved;
  }
  function cancelTimers() {
    ++pollVersion;
    [pollTimer, heartbeatTimer, joinTimer, organizationTimer, inputTimer].forEach(value => { if (value !== undefined) cancel(value); });
    pollTimer = heartbeatTimer = joinTimer = organizationTimer = inputTimer = undefined;
  }
  function closeMedia() {
    const previous = rtc; rtc = null;
    clearCaption(); view.agentState = 0;
    if (['connected', 'connecting'].includes(view.connectionState)) view.connectionState = view.connectionError ? 'failed' : 'paused';
    if (joinAbort) { const reject = joinAbort; joinAbort = null; reject(new Error('连接已取消，麦克风已关闭。')); }
    if (previous) { try { Promise.resolve(previous.close()).catch(() => {}); } catch (_) {} }
    view.muted = false;
  }
  function closeOldRtc(target) {
    if (target) { try { Promise.resolve(target.close()).catch(() => {}); } catch (_) {} }
  }
  function settleWaiters(error) {
    if (!error && (state.call || state.pausePending || starting || pausePromise || waitingForTransport())) return;
    for (const waiter of waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve();
  }
  function authChanged() {
    if (sameOwner()) return;
    ++intentVersion; ++organizationVersion;
    stopWanted = true; closeMedia(); cancelTimers();
    settleWaiters(new Error('登录状态已改变，请重新登录。'));
    preserveFinishOnUnload();
    if (state.call?.callId && !terminal()) api.stopRealtimeCallOnUnload?.(state.call.callId, token);
    state = {}; loadedOwner = ''; initialized = false; files.clear();
    emit({ phase: 'auth', notice: '登录状态已改变，麦克风已关闭，请重新登录。', account: '', turns: [], resumeOpenings: [], photos: [], attachments: [],
      opening: '', question: '', transcript: '', caption: '', captionSpeaker: '', organization: null,
      connectionState: 'idle', connectionError: null, restoredSession: false, restoredDraft: false,
      saving: false, transportClosed: true, materialState: '' });
  }
  function requireOwner() { if (sameOwner()) return true; authChanged(); return false; }
  function acceptResumeOpenings(openings, replace = false) {
    const saved = new Map((replace ? [] : view.resumeOpenings).map(item => [item.call_id, item]));
    for (const item of Array.isArray(openings) ? openings : []) {
      if (!item || item.session_id && item.session_id !== view.sessionId) continue;
      if (typeof item.call_id !== 'string' || !item.call_id.trim() || typeof item.text !== 'string' || !item.text.trim()) continue;
      saved.set(item.call_id, { call_id: item.call_id, text: item.text, created_at: item.created_at });
    }
    view.resumeOpenings = [...saved.values()];
  }
  function acceptSession(session) {
    if (!session?.session_id || view.sessionId && session.session_id !== view.sessionId) throw new Error('访谈记录不完整，请重试。');
    view.sessionId = session.session_id;
    acceptResumeOpenings(session.resume_openings, true);
    view.entry = session.mode === 'PHOTO' ? 'PHOTO' : 'GENERAL';
    activity = session.activity_state || 'PAUSED';
    const turns = [...(session.turns || [])].sort((a, b) => a.sequence_no - b.sequence_no);
    const last = turns.at(-1);
    Object.assign(view, { turns, photos: session.photos || [], opening: session.opening_assistant_text || '',
      question: last?.assistant_text || session.opening_assistant_text || '', transcript: last?.user_text || '',
      saving: session.saving === true, transportClosed: sessionTransportClosed(session), materialState: session.material_state || '',
      readOnly: session.flow_version !== 'interview' || session.status === 'CANCELLED' });
    if (session.status === 'COMPLETED' || ['FINISHING', 'FINISHED'].includes(activity)) {
      state.finishRequested = true; activity = session.activity_state || 'FINISHED';
      stopWanted = true; closeMedia(); cancelTimers(); bestEffortPersist();
      emit({ phase: 'finishing', notice: '正在整理已保存的讲述。', errorStage: '' });
      return;
    }
    const pending = state.input;
    const saved = pending && turns.find(turn => turn.client_request_id === pending.requestId);
    if (saved?.response_state === 'GENERATED' && saved.response_id && saved.assistant_text) acceptReply(saved);
    else if (saved) {
      pending.state = pending.state === 'CAPACITY' ? 'CAPACITY' : saved.response_state;
      pending.mediaIds = [...(saved.media_ids || pending.mediaIds)];
    } else if (pending && !inputBusy && pending.state === 'GENERATING') {
      // A request may have timed out before reaching the server. Only a
      // canonical GENERATING turn warrants polling instead of same-key retry.
      pending.state = 'UNKNOWN';
    } else if (!pending && last && !last.realtime_call_id && last.client_request_id && ['GENERATING', 'FAILED', 'INTERRUPTED'].includes(last.response_state)) {
      state.input = { requestId: last.client_request_id, text: last.user_text || '', mediaIds: [...(last.media_ids || [])], state: last.response_state, autoResume: false };
    }
    const callId = session.active_call_id || session.call_id;
    if (callId && !state.call) state.call = { requestId: '', callId, openingResponseId: '' };
    if (state.input?.state === 'GENERATING') scheduleInputPoll();
    bestEffortPersist();
  }
  function acceptReply(reply) {
    const pending = state.input;
    if (!reply?.response_id || reply.response_state !== 'GENERATED' || !reply.assistant_text || reply.session_id !== view.sessionId
      || pending && reply.client_request_id !== pending.requestId) throw new Error('回复尚未确认，请重试本次提交。');
    state.openingResponseId = reply.response_id;
    view.turns = [...view.turns.filter(turn => turn.sequence_no !== reply.sequence_no && turn.client_request_id !== reply.client_request_id), reply]
      .sort((a, b) => a.sequence_no - b.sequence_no);
    const seen = new Set(view.photos.map(photo => photo.media_id));
    for (const photo of reply.photos || (reply.media_ids || []).map(media_id => ({ media_id }))) {
      if (!seen.has(photo.media_id)) { seen.add(photo.media_id); view.photos.push(photo); }
    }
    view.question = reply.assistant_text; view.transcript = reply.user_text || '';
    const mediaIds = pending?.mediaIds || reply.media_ids || [];
    view.attachments = view.attachments.filter(item => !mediaIds.includes(item.mediaId));
    state.input = null;
    persist();
    emit({ phase: 'paused', notice: '回复已保存，可以继续聊。', errorStage: '' });
  }
  async function initialize(options = {}) {
    if (typeof options === 'string') options = { sessionId: options };
    if (initializing) return initializing;
    if (initialized) return snapshot();
    initializeOptions = { ...initializeOptions, ...options };
    if (view.errorStage === 'initialize') emit({ phase: 'loading', connectionState: 'idle', connectionError: null, errorStage: '' });
    const version = intentVersion;
    initializing = (async () => {
      try {
        token = api.getAuthToken();
        if (!token) { emit({ phase: 'auth', notice: '请先登录，再开始讲述。' }); return; }
        const user = await api.getCurrentUser();
        if (!alive || !requireOwner()) return;
        owner = String(user.id || '');
        if (!owner) throw new Error('登录信息不完整，请重新登录。');
        if (user.is_guest && !initializeOptions.sessionId) {
          const trial = await api.getGuestTrial();
          if (!alive || !requireOwner()) return;
          initializeOptions.entry = 'GENERAL';
          if (trial.session_id) {
            initializeOptions.sessionId = trial.session_id;
            initializeOptions.fresh = false;
          }
        }
        interaction = initializeOptions.interaction === 'text' ? 'text' : 'voice';
        if (loadedOwner !== owner) {
          view.resumeOpenings = [];
          view.entry = String(initializeOptions.entry).toUpperCase() === 'PHOTO' ? 'PHOTO' : 'GENERAL';
          view.sessionId = initializeOptions.fresh ? '' : String(initializeOptions.sessionId || '');
          migrateInterviewStorage();
          migrateLegacyDraft();
          state = readSaved(view.sessionId);
          if (!view.sessionId && state.entry && state.entry !== view.entry) throw new Error('讲述入口与恢复记录不一致，请重新打开原入口。');
          view.restoredSession = Boolean(view.sessionId || state.sessionId);
          view.restoredDraft = !view.sessionId && Object.keys(state).length > 0;
          if (view.restoredSession) view.connectionState = 'paused';
          if (!view.sessionId && state.sessionId) view.sessionId = state.sessionId;
          if (state.input) state.input.autoResume = false;
          if (view.sessionId && state.entry) view.entry = state.entry;
          view.attachments = (state.attachments || []).map(item => ({ ...item, state: item.mediaId ? 'uploaded' : 'failed', error: item.mediaId ? '' : '请重新选择这张照片。' }));
          loadedOwner = owner;
        }
        // Initialization may fail after creating a PHOTO session. A retry in
        // this page keeps that session and its request IDs, even if the initial
        // URL options still said new=1.
        emit({ account: user.display_name || user.dev_label || (user.is_guest ? '初次体验' : '已登录'), isGuest: user.is_guest === true, entry: view.entry });
        const [config, realtimeConfig, biography] = await Promise.all([
          api.getInterviewConfig(), api.getRealtimeConfig().catch(() => ({ enabled: false })), api.bootstrapBiography(),
        ]);
        if (!alive || !requireOwner()) return;
        biographyId = biography.biography_id;
        view.maxImages = Number(config.max_images) || 250; view.realtimeAvailable = realtimeConfig.enabled === true;
        initialized = true;
        if (!view.sessionId && view.entry === 'PHOTO') await ensureSession();
        if (view.sessionId) {
          const session = await api.getInterviewSession(view.sessionId);
          if (!alive || !requireOwner()) return;
          acceptSession(session); onSession(view.sessionId);
          if (terminal()) { if (['FINISHING', 'FINISHED'].includes(activity)) await loadOrganization(); else await finish(); return; }
          if (view.readOnly) { emit({ phase: 'error', notice: '这次访谈仅可查看，请返回首页重新开始。' }); return; }
          if (state.call || waitingForTransport() || state.pausePending || activity === 'ACTIVE') await pause('', { internal: true });
        }
        if (!alive || !requireOwner() || terminal()) return;
        emit({ phase: state.call || state.pausePending || waitingForTransport() ? 'pausing' : 'paused',
          notice: state.input ? '上次输入已保留，请继续确认回复。' : '准备好后开始讲述，也可以先补充文字和照片。' });
      } catch (error) {
        if (token && !sameOwner()) return authChanged();
        initialized = false;
        if (!alive || version !== intentVersion) return;
        if (error.status !== 401) failConnection(error, '暂时无法打开访谈，请重试。');
        emit({ phase: error.status === 401 ? 'auth' : 'error', notice: error.message || '暂时无法打开访谈，请重试。', errorStage: 'initialize' });
      }
    })();
    try { await initializing; } finally { initializing = null; emit(); }
    return snapshot();
  }
  function setEntry(entry) {
    if (view.sessionId || state.createRequestId || state.input || starting || inputBusy || terminal()) return false;
    view.entry = entry === 'PHOTO' ? 'PHOTO' : 'GENERAL'; persist(); emit(); return true;
  }
  async function ensureSession() {
    if (view.sessionId) return;
    if (creating) return creating;
    creating = (async () => {
      const newKey = storageKey('');
      state.createRequestId ||= newRequestId(); persist();
      const session = await api.createInterviewSession(view.entry, state.createRequestId);
      if (!requireOwner()) throw new Error('登录状态已改变。');
      acceptSession(session); persist(); onSession(view.sessionId);
      storage.removeItem(newKey);
    })();
    try { await creating; } finally { creating = null; emit(); }
  }
  async function uploadOne(item) {
    const file = files.get(item.id);
    if (!file || item.mediaId || !requireOwner()) return;
    uploading++; item.state = 'uploading'; item.error = ''; emit();
    try {
      const result = await api.uploadPhoto(file);
      if (!alive || !requireOwner() || !view.attachments.includes(item)) return;
      if (!result?.id) throw new Error('照片保存结果尚未确认，请重试。');
      item.mediaId = result.id; item.state = 'uploaded'; files.delete(item.id); persist();
    } catch (error) {
      if (alive && requireOwner() && view.attachments.includes(item)) {
        item.state = 'failed'; item.error = error.message || '照片上传失败，请重试。'; bestEffortPersist();
      }
    } finally { uploading--; emit(); }
  }
  async function uploadPhotos(selected) {
    if (!initialized || !alive || !visible || !requireOwner() || terminal() || state.input || view.readOnly) return [];
    if (starting || state.call || activity === 'ACTIVE') void pause();
    const incoming = Array.from(selected || []);
    if (incoming.length + view.attachments.length > view.maxImages) { emit({ notice: `本次最多选择 ${view.maxImages} 张照片。`, errorStage: 'upload' }); return []; }
    const added = incoming.map(file => {
      const item = { id: `photo-${++uploadSequence}-${newRequestId()}`, mediaId: '', name: String(file.name || '照片'), state: 'uploading', error: '' };
      files.set(item.id, file); view.attachments.push(item); return item;
    });
    bestEffortPersist(); emit();
    let next = 0;
    await Promise.all([0, 1].map(async () => { while (next < added.length) await uploadOne(added[next++]); }));
    return clone(added);
  }
  async function retryUpload(id) {
    const item = view.attachments.find(value => value.id === id);
    if (!item || state.input || terminal() || item.state !== 'failed') return;
    if (!files.has(id)) { emit({ notice: '请移除后重新选择这张照片。', errorStage: 'upload' }); return; }
    await uploadOne(item);
  }
  function removePhoto(id) {
    if (state.input || terminal()) return false;
    const item = view.attachments.find(value => value.id === id);
    if (!item) return false;
    view.attachments = view.attachments.filter(value => value.id !== id); files.delete(id); persist(); emit(); return true;
  }
  function acceptCall(call) {
    if (!call?.call_id || call.session_id !== view.sessionId || state.call?.callId && call.call_id !== state.call.callId) throw new Error('通话状态不一致，请重试确认暂停。');
    if (state.call && !state.call.callId) { state.call.callId = call.call_id; persist(); }
    if (terminal()) return false;
    acceptResumeOpenings(call.resume_openings);
    for (const turn of call.turns || []) {
      const index = view.turns.findIndex(saved => saved.sequence_no === turn.sequence_no);
      if (index < 0) view.turns.push(turn);
      else view.turns[index] = { ...view.turns[index], ...turn };
    }
    view.turns.sort((a, b) => a.sequence_no - b.sequence_no);
    view.question = call.question || view.question; view.transcript = call.transcript || view.transcript;
    view.saving = call.saving === true; view.transportClosed = callTransportClosed(call);
    view.materialState = call.material_state || '';
    const materialPending = view.transportClosed && call.error?.code === 'REALTIME_SAVING';
    const error = materialPending ? null : call.error;
    if (error && !stopWanted) failConnection(error);
    if (view.transportClosed) {
      if (!stopWanted && !materialPending && ['connected', 'connecting'].includes(view.connectionState)) failConnection({ code: 'RTC_DISCONNECTED', message: '语音连接已断开，可以重新连接。' });
      return true;
    }
    if (call.status !== 'ACTIVE') {
      stopWanted = true; closeMedia(); view.saving = call.saving === true;
      emit({ phase: 'pausing', notice: error?.message || '正在暂停通话…' });
    } else emit();
    return false;
  }
  function callSettled() {
    closeMedia(); cancelTimers();
    state.call = null; state.pausePending = false; view.transportClosed = true; activity = 'PAUSED'; stopWanted = true;
    persist(); emit({ phase: 'paused', notice: view.connectionError?.message || '已暂停，可以继续聊或补充照片。',
      ...(view.connectionError ? { errorStage: 'call' } : {}) });
    settleWaiters();
  }
  function scheduleCallPoll(delay = 1500) {
    if (pollTimer !== undefined) cancel(pollTimer);
    if (!alive || !visible || !sameOwner() || !state.call?.callId || terminal()) return;
    const version = pollVersion, callId = state.call.callId;
    pollTimer = schedule(async () => {
      pollTimer = undefined;
      try {
        const call = await api.getRealtimeCall(callId);
        if (!requireOwner() || version !== pollVersion || state.call?.callId !== callId || terminal()) return;
        if (acceptCall(call)) { callSettled(); return; }
        scheduleCallPoll();
      } catch (error) {
        if (!requireOwner() || version !== pollVersion || terminal()) return;
        failConnection(error, '通话状态尚未确认，请重试。');
        await pause(view.connectionError.message);
      }
    }, delay);
  }
  function heartbeat() {
    if (heartbeatTimer !== undefined) cancel(heartbeatTimer);
    const version = pollVersion;
    heartbeatTimer = schedule(async () => {
      heartbeatTimer = undefined;
      if (!usable() || !state.call?.callId || version !== pollVersion) return;
      try {
        const call = await api.heartbeatRealtimeCall(state.call.callId);
        if (!requireOwner() || version !== pollVersion || terminal()) return;
        if (acceptCall(call)) return callSettled();
        if (call.status !== 'ACTIVE') return pause();
        heartbeat();
      } catch (error) {
        if (requireOwner() && version === pollVersion && !terminal()) {
          failConnection(error); await pause(view.connectionError.message);
        }
      }
    }, 10000);
  }
  async function start() {
    if (!initialized || starting || inputBusy || retryingInput || uploading || !alive || !visible || !requireOwner() || view.readOnly) return false;
    if (rtc && view.connectionState === 'connected' && !stopWanted) return true;
    if (terminal()) { if (activity === 'FINISHING' || activity === 'FINISHED') await loadOrganization(); else await finish(); return false; }
    if (state.input) { emit({ notice: '请先确认上一条回复，再继续通话。', errorStage: 'input' }); return false; }
    if (state.call || state.pausePending || waitingForTransport() || pausePromise) { await pause('', { internal: true }); return false; }
    if (!photoReady()) { emit({ notice: '请先确认照片回复，再开始图片语音访谈。' }); return false; }
    const version = ++intentVersion;
    const current = () => version === intentVersion && usable();
    let attempt, joining;
    cancelTimers(); starting = true; stopWanted = false; view.transportClosed = false;
    emit({ phase: 'connecting', connectionState: 'connecting', connectionError: null,
      notice: '正在连接小暖，请允许浏览器使用麦克风。', errorStage: '' });
    try {
      const config = await api.getRealtimeConfig();
      if (!current()) return false;
      view.realtimeAvailable = config.enabled === true;
      if (!view.realtimeAvailable) throw new Error('语音通话暂不可用，请稍后重试。');
      await checkEnvironment(); if (!current()) return false;
      await preflightMicrophone(); if (!current()) return false;
      await ensureSession(); if (!current()) return false;
      attempt = { requestId: newRequestId(), callId: '', openingResponseId: state.openingResponseId || '' };
      state.call = attempt;
      try { persist(); } catch (error) { state.call = null; throw error; }
      if (!attempt.openingResponseId && view.turns.length) emit({ notice: '小暖正在回顾刚才的讲述，马上接着聊。' });
      const call = await api.resumeInterviewSession(view.sessionId, attempt.requestId, attempt.openingResponseId || undefined);
      if (!requireOwner()) return false;
      if (!current()) {
        // Retain the late reservation only so pause/finish can stop that call.
        // Its history and ACTIVE state must not undo the user's newer action.
        if (state.call === attempt && call?.session_id === view.sessionId && call.call_id) {
          attempt.callId = call.call_id; bestEffortPersist();
        }
        return false;
      }
      if (acceptCall(call)) { callSettled(); return false; }
      if (terminal()) return false;
      activity = 'ACTIVE';
      if (!current()) return false;
      if (!['ACTIVE', 'STARTING'].includes(call.status) || !call.credentials) throw new Error(call.error?.message || '连接尚未建立，请重试。');
      emit({ notice: '正在连接小暖…' });
      joining = createRtc({
        onError: error => {
          if (current() && rtc === joining) { failConnection(error, '语音连接中断，请重试。'); void pause(view.connectionError.message); }
        },
        onDisconnected: () => {
          if (current() && rtc === joining) { failConnection({ code: 'RTC_DISCONNECTED', message: '语音连接已断开，可以重新连接。' }); void pause(view.connectionError.message); }
        },
        onAutoplayBlocked: () => {
          if (current() && rtc === joining) { failConnection({ code: 'RTC_AUTOPLAY_BLOCKED', message: '浏览器阻止了声音播放，请允许声音后重新连接。' }); void pause(view.connectionError.message); }
        },
        onCaption: caption => {
          if (!current() || rtc !== joining) return;
          // Only live RTC captions feed the phrase queue, never saved history.
          acceptCaption(caption);
        },
        onCaptionClear: event => {
          if (!current() || rtc !== joining || event.roundId !== view.captionRoundId) return;
          // The adapter still closes expired rounds to late packets. Keep the
          // words already received until the next reply's first caption arrives.
          if (event.reason === 'done_timeout') return;
          if (event.reason === 'new_round') { stopCaptionQueue(); return; }
          clearCaption(); emit();
        },
        onAgentState: event => {
          if (!current() || rtc !== joining) return;
          // After expiry the adapter has already cleared its display identity,
          // so interruption can arrive without another onCaptionClear callback.
          if (event.state === 4 && event.roundId === view.captionRoundId) clearCaption();
          if ([2, 3].includes(event.state) && receivedCaptionRound && event.roundId !== receivedCaptionRound) stopCaptionQueue();
          emit({ agentState: event.state });
        },
      });
      rtc = joining;
      const deadline = new Promise((_, reject) => { joinAbort = reject; joinTimer = schedule(() => reject(new Error('连接超时，请检查网络后重试。')), 20000); });
      const joined = Promise.resolve(joining.join(call.credentials)).finally(() => {
        // Some SDKs finish joining after close(). Close that obsolete instance
        // again, without touching a replacement connection.
        if (!current() || rtc !== joining) closeOldRtc(joining);
      });
      await Promise.race([joined, deadline]);
      joinAbort = null; if (joinTimer !== undefined) cancel(joinTimer);
      if (!current() || rtc !== joining) return false;
      state.openingResponseId = ''; persist();
      emit({ phase: 'connected', connectionState: 'connected', connectionError: null,
        notice: '直接开口就好，小暖会听您说完。', errorStage: '' });
      scheduleCallPoll(0); heartbeat(); return true;
    } catch (error) {
      if (rtc === joining) closeMedia(); else closeOldRtc(joining);
      if (!requireOwner()) return false;
      // A rejected preparation has no cloud call to recover, even if the user
      // paused or left while it was running. Clear only this exact attempt.
      if (state.call === attempt && attempt && !attempt.callId && definitive(error)) { state.call = null; bestEffortPersist(); }
      if (terminal() || version !== intentVersion) return false;
      stopWanted = true;
      failConnection(error);
      emit({ phase: 'error', notice: error.message || '语音连接尚未确认，请重试连接。', errorStage: 'call' });
      return false;
    } finally {
      starting = false;
      if (sameOwner() && !terminal() && stopWanted && state.call?.callId) await pause(view.notice, { internal: true });
      else if (sameOwner() && !terminal() && stopWanted && !state.call) { state.pausePending = false; view.transportClosed = true; bestEffortPersist(); settleWaiters(); emit({ phase: 'paused' }); }
      emit();
    }
  }
  async function pause(notice = '', { internal = false } = {}) {
    if (!internal) {
      ++intentVersion; pendingAutoResume = false;
      if (!view.connectionError) view.connectionState = 'paused';
    }
    stopWanted = true; closeMedia(); cancelTimers();
    if (!requireOwner() || terminal()) return;
    if (!view.sessionId) { emit({ phase: 'paused', notice: '麦克风已关闭。' }); return; }
    if (!state.call && !starting && !state.pausePending && !waitingForTransport() && activity === 'PAUSED') {
      emit({ phase: 'paused', notice: notice || '已暂停，可以继续聊或补充照片。' }); settleWaiters(); return;
    }
    state.pausePending = true;
    emit({ phase: 'pausing', notice: notice || view.connectionError?.message || '正在暂停通话…', errorStage: view.connectionError ? 'call' : '' });
    if (pausePromise) {
      // Repeated pauses may share this stop, but cannot revive another stop's
      // callbacks or cancel a newer connection when that stop finally settles.
      pauseOperation.version = intentVersion;
      return pausePromise;
    }
    const operation = { version: intentVersion };
    pauseOperation = operation;
    const currentPause = () => pauseOperation === operation && operation.version === intentVersion && !terminal();
    const promise = (async () => {
      try {
        persist();
        if (state.call && !state.call.callId && !starting) {
          try {
            const call = await api.resumeInterviewSession(view.sessionId, state.call.requestId, state.call.openingResponseId || undefined);
            if (!requireOwner() || !currentPause()) return;
            if (acceptCall(call)) { callSettled(); return; }
          } catch (error) {
            if (!requireOwner() || !currentPause()) return;
            if (!definitive(error)) throw error;
            state.call = null; persist();
          }
        }
        let session;
        while (true) {
          if (!requireOwner() || !currentPause()) return;
          const stoppingCallId = state.call?.callId || '';
          session = await api.pauseInterviewSession(view.sessionId);
          if (!requireOwner() || !currentPause()) return;
          // A start may reveal its reservation after this pause snapshot was
          // taken. Stop that newly learned call before accepting the snapshot.
          if (!state.call?.callId || state.call.callId === stoppingCallId) break;
        }
        acceptSession(session);
        if (terminal()) { if (alive && visible) await loadOrganization(); return; }
        if (session.session_id !== view.sessionId || session.activity_state !== 'PAUSED') throw new Error('暂停状态尚未确认，请重试。');
        activity = 'PAUSED'; view.saving = session.saving === true;
        const callId = session.active_call_id || session.call_id;
        if (!starting && view.transportClosed) callSettled();
        else if (callId) {
          state.call ||= { requestId: '', callId, openingResponseId: '' };
          state.call.callId = callId; persist(); scheduleCallPoll(0);
        } else if (!starting) schedulePauseCheck();
      } catch (error) {
        if (!requireOwner() || !currentPause()) return;
        emit({ phase: 'error', notice: error.message || '暂停状态尚未确认，请重试确认。', errorStage: 'pause' });
        settleWaiters(error);
      }
    })();
    pausePromise = promise;
    try { await promise; } finally {
      if (pausePromise === promise && pauseOperation === operation) {
        pausePromise = null; pauseOperation = null; settleWaiters(); emit();
      }
    }
  }
  function schedulePauseCheck() {
    if (!alive || !visible || terminal()) return;
    const version = pollVersion;
    pollTimer = schedule(async () => {
      pollTimer = undefined;
      try {
        const session = await api.getInterviewSession(view.sessionId);
        if (!requireOwner() || terminal() || version !== pollVersion) return;
        acceptSession(session);
        if (view.transportClosed && !starting) callSettled();
        else if (state.call?.callId) scheduleCallPoll();
        else schedulePauseCheck();
      } catch (error) {
        if (!requireOwner() || terminal() || version !== pollVersion) return;
        emit({ phase: 'error', notice: error.message || '暂停状态尚未确认。', errorStage: 'pause' }); settleWaiters(error);
      }
    }, 1500);
  }
  async function waitForPause() {
    await pause('', { internal: true });
    if (!alive || !visible || !requireOwner() || terminal()) throw new Error('输入已保留，返回后可以继续。');
    if (view.errorStage === 'pause') throw new Error('请先重试确认通话已暂停，再提交这条输入。');
    if (!state.call && !state.pausePending && !starting && !pausePromise && !waitingForTransport()) return;
    await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }
  function resume() {
    if (resuming?.version === intentVersion) return resuming.promise;
    if (!alive || !visible || starting && !stopWanted) return Promise.resolve(false);
    const operation = { version: intentVersion, promise: null };
    resuming = operation;
    const current = () => operation.version === intentVersion && alive && visible && requireOwner() && !terminal();
    operation.promise = (async () => {
      if (!initialized) await initialize(initializeOptions);
      if (!initialized || !current()) return false;
      if (rtc && view.connectionState === 'connected' && !stopWanted) return true;
      if (state.call || state.pausePending || starting || pausePromise || waitingForTransport()) {
        try { await waitForPause(); } catch (_) { return false; }
        if (!current()) return false;
      }
      return start();
    })().finally(() => {
      if (resuming === operation) resuming = null;
      emit();
    });
    emit();
    return operation.promise;
  }
  async function submit({ text = '', mediaIds, autoResume = interaction !== 'text' } = {}) {
    if (!initialized || inputBusy || uploading || !alive || !visible || !requireOwner() || terminal() || view.readOnly || state.input) return null;
    const ids = mediaIds === undefined ? view.attachments.filter(item => item.state === 'uploaded').map(item => item.mediaId) : [...mediaIds];
    text = String(text).trim();
    if (!text && !ids.length) { emit({ notice: '先写一点回忆，或选择照片。' }); return null; }
    if (view.attachments.some(item => item.state === 'failed') && mediaIds === undefined) { emit({ notice: '请重试或移除上传失败的照片。' }); return null; }
    state.input = { requestId: newRequestId(), text, mediaIds: ids, state: 'PENDING', autoResume: Boolean(autoResume) };
    try { persist(); } catch (error) { state.input = null; emit({ phase: 'error', errorStage: 'input', notice: '浏览器无法保存这次输入，请允许本地存储后重试。' }); return null; }
    return sendPending();
  }
  async function sendPending() {
    if (!state.input || inputBusy || terminal()) return null;
    const pending = state.input;
    pendingAutoResume = pending.autoResume && visible;
    inputBusy = true; emit({ notice: '正在准备这次回复。', errorStage: '' });
    try {
      await ensureSession();
      if (!alive || !visible || !requireOwner() || terminal()) return null;
      await waitForPause();
      if (terminal() || state.input !== pending) return null;
      pending.state = 'GENERATING'; persist(); emit({ phase: 'generating', notice: '材料已保存，小暖正在回复。' });
      const reply = await api.submitInterviewInput(view.sessionId, { clientRequestId: pending.requestId, text: pending.text, mediaIds: pending.mediaIds });
      if (!requireOwner() || terminal()) return null;
      acceptReply(reply);
      const shouldResume = pendingAutoResume;
      pendingAutoResume = false;
      if (alive && visible && shouldResume) { inputBusy = false; await start(); }
      return reply;
    } catch (error) {
      if (!requireOwner() || terminal()) return null;
      if (state.input === pending) {
        pending.state = capacityError(error) ? 'CAPACITY' : error.code === 'TURN_IN_PROGRESS' ? 'GENERATING' : 'UNKNOWN';
        bestEffortPersist();
      }
      emit({ phase: 'paused', errorStage: 'input', notice: capacityError(error)
        ? '这次访谈容量已满，材料已保留。可以结束整理，再开始新的访谈。'
        : error.message || '回复尚未确认，重试会继续同一条输入。' });
      if (pending.state === 'GENERATING') scheduleInputPoll();
      return null;
    } finally { inputBusy = false; scheduleInputPoll(); emit(); }
  }
  async function retryInput({ autoResume } = {}) {
    if (!initialized || !state.input || inputBusy || retryingInput || uploading || terminal() || view.readOnly
        || !alive || !visible || !requireOwner() || state.input.state === 'CAPACITY') return null;
    const pending = state.input;
    const version = intentVersion;
    if (typeof autoResume === 'boolean') pending.autoResume = autoResume;
    pendingAutoResume = Boolean(pending.autoResume && visible);
    retryingInput = true; bestEffortPersist(); emit();
    const current = () => alive && visible && version === intentVersion && requireOwner() && !terminal();
    try {
      if (view.sessionId) {
        const session = await api.getInterviewSession(view.sessionId);
        if (!current()) return null;
        acceptSession(session);
        if (!state.input) {
          const reply = view.turns.find(turn => turn.client_request_id === pending.requestId);
          const shouldResume = pendingAutoResume;
          pendingAutoResume = false; retryingInput = false;
          if (shouldResume && current()) await start();
          return reply || null;
        }
        if (state.input.state === 'GENERATING') { emit({ phase: 'generating', notice: '小暖还在回复，请稍候。' }); scheduleInputPoll(); return null; }
      }
      if (!current() || state.input !== pending) return null;
      retryingInput = false;
      return await sendPending();
    } catch (error) {
      if (current()) emit({ notice: error.message || '暂时无法核对回复，请重试。', errorStage: 'input' });
      return null;
    } finally {
      retryingInput = false; scheduleInputPoll(); emit();
    }
  }
  function scheduleInputPoll() {
    if (inputTimer !== undefined) cancel(inputTimer);
    if (!alive || !visible || terminal() || state.input?.state !== 'GENERATING' || inputBusy) return;
    inputTimer = schedule(async () => { inputTimer = undefined; await refresh(); }, 1500);
  }
  async function refresh() {
    if (!initialized || !view.sessionId || !alive || !requireOwner()) return;
    const version = intentVersion;
    try {
      const session = await api.getInterviewSession(view.sessionId);
      if (!alive || !requireOwner() || version !== intentVersion) return;
      const pending = state.input;
      acceptSession(session);
      if (terminal()) { await loadOrganization(); return; }
      // Explicit continue may be reconciling this same turn concurrently.
      // That operation owns the resume intent until it has finished checking;
      // consuming it here would call start() while retryingInput still blocks it.
      if (pending && !state.input && pendingAutoResume && visible && !retryingInput) {
        pendingAutoResume = false;
        await start();
        return;
      }
      if (state.input?.state === 'GENERATING') emit({ phase: 'generating', notice: '小暖正在回复，请稍候。' });
      else if (!rtc && !state.call && !state.pausePending && !starting) emit({ phase: 'paused', notice: state.input ? '这条回复还未完成，可以重试或结束整理。' : '讲述已保存，可以继续。' });
      if (!rtc && (state.call || state.pausePending || waitingForTransport() || activity === 'ACTIVE')) await pause('', { internal: true });
    } catch (error) { if (requireOwner() && version === intentVersion) emit({ notice: error.message || '读取进度失败，请重试。', errorStage: terminal() ? 'organization' : 'input' }); }
  }
  async function finish() {
    if (!view.sessionId || finishing || !initialized || !requireOwner() || view.readOnly) return;
    ++intentVersion; const organizationEpoch = ++organizationVersion; pendingAutoResume = false;
    stopWanted = true; closeMedia(); cancelTimers();
    state.finishRequested = true; bestEffortPersist();
    settleWaiters(new Error('访谈正在结束，材料会保留。'));
    finishing = true; emit({ phase: 'finishing', notice: '正在结束访谈并整理故事。', errorStage: '' });
    try {
      const result = await api.completeInterviewSession(view.sessionId, biographyId);
      if (!requireOwner()) return;
      if (activity !== 'FINISHED') activity = 'FINISHING'; bestEffortPersist();
      if (alive && visible) {
        if (result.organization && organizationEpoch === organizationVersion) {
          const job = { ...result.organization };
          for (const key of ['phase', 'error_code', 'error_message', 'material_revision']) if (result[key] != null) job[key] = result[key];
          applyOrganization(job);
        }
        else if (result.status === 'NO_MATERIAL' && organizationEpoch === organizationVersion) applyOrganization({ status: 'FAILED', error_code: 'NO_MATERIAL', retry_allowed: false, material_revision: result.material_revision, error_message: '这次还没有可整理的讲述。' });
        else await loadOrganization();
      }
    } catch (error) {
      if (!requireOwner()) return;
      try {
        const session = await api.getInterviewSession(view.sessionId);
        if (!requireOwner()) return;
        acceptSession(session);
        if (['FINISHING', 'FINISHED'].includes(activity) || session.status === 'COMPLETED') { if (alive && visible) await loadOrganization(); return; }
      } catch (_) {}
      emit({ phase: 'error', notice: error.message || '结束结果尚未确认，请重试结束。', errorStage: 'finish' });
    } finally { finishing = false; emit(); }
  }
  function applyOrganization(job) {
    const revision = Number(job?.material_revision);
    if (Number.isSafeInteger(revision) && revision < organizationMaterialRevision) { scheduleOrganizationPoll(); return; }
    if (Number.isSafeInteger(revision)) organizationMaterialRevision = revision;
    view.organization = job;
    if (materialIssue(job) || job.phase === 'REVISING') {
      activity = 'FINISHING'; bestEffortPersist();
      emit({ phase: 'finishing', notice: job.error_message || (job.phase === 'REVISING' ? '新的讲述已保存，正在更新这篇故事。'
        : materialDelayed(job) ? '通话已结束，整理暂未完成，已有记录已保留，系统会自动继续处理。'
          : '最后一段讲述还在核对，已有记录已保留，核对完成后会自动整理。'), errorStage: '' });
      scheduleOrganizationPoll();
    } else if (['SUCCEEDED', 'FAILED'].includes(job.status)) {
      activity = 'FINISHED'; bestEffortPersist();
      emit({ phase: 'finished', notice: job.error_message || (job.status === 'SUCCEEDED'
        ? job.error_code === 'STORY_REVISION_AVAILABLE' ? '补充后的故事版本已整理，您修改过的内容已保留。' : '这段讲述已经整理成故事。'
        : '讲述已保留，可以重试整理。'), errorStage: job.status === 'FAILED' ? 'organization' : '' });
    } else {
      emit({ phase: 'finishing', notice: job.phase === 'FINISHING' ? '正在确认最后的文字，随后会整理故事。' : '小暖正在把讲述整理成故事。' });
      scheduleOrganizationPoll();
    }
  }
  function scheduleOrganizationPoll(delay = materialDelayed(view.organization) ? 30000 : 1500) {
    if (organizationTimer !== undefined) cancel(organizationTimer);
    if (alive && visible && sameOwner()) organizationTimer = schedule(() => { organizationTimer = undefined; return loadOrganization(); }, delay);
  }
  async function loadOrganization() {
    if (!view.sessionId || !alive || !visible || !requireOwner()) return;
    const version = ++organizationVersion;
    try { const job = await api.getInterviewOrganization(view.sessionId); if (alive && visible && requireOwner() && version === organizationVersion) applyOrganization(job); }
    catch (error) {
      if (!alive || !visible || !requireOwner() || version !== organizationVersion) return;
      if (transient(error)) {
        emit({ phase: 'finishing', notice: '暂时无法读取整理进度，系统会自动继续查询，已有记录已保留。', errorStage: '' });
        scheduleOrganizationPoll(30000);
      } else {
        if (organizationTimer !== undefined) cancel(organizationTimer);
        organizationTimer = undefined;
        emit({ phase: 'finishing', notice: error.message || '暂时无法读取整理进度，请重试查询。', errorStage: 'organization' });
      }
    }
  }
  async function retryOrganization() {
    if (!view.sessionId || !alive || !visible || !requireOwner() || materialIssue(view.organization) || view.organization?.retry_allowed === false) return;
    if (view.organization?.status !== 'FAILED') return loadOrganization();
    const version = ++organizationVersion;
    try { const job = await api.retryInterviewOrganization(view.sessionId); if (alive && visible && requireOwner() && version === organizationVersion) applyOrganization(job); }
    catch (error) { if (alive && visible && requireOwner() && version === organizationVersion) emit({ notice: error.message || '整理尚未确认，请重试。', errorStage: 'organization' }); }
  }
  async function toggleMute() {
    if (!rtc || view.phase !== 'connected' || !requireOwner()) return;
    const target = rtc, muted = !view.muted, version = intentVersion;
    try { await target.mute(muted); if (usable() && rtc === target) emit({ muted }); }
    catch (error) { if (version === intentVersion && usable() && rtc === target) await pause(error.message || '麦克风控制失败，请重新连接。'); }
  }
  function setVisible(value) {
    visible = Boolean(value);
    if (!visible) {
      ++intentVersion; ++organizationVersion;
      pendingAutoResume = false;
      settleWaiters(new Error('材料已保留，返回后请继续提交。'));
      if (terminal()) { closeMedia(); cancelTimers(); preserveFinishOnUnload(); }
      else if (rtc || starting || state.call || state.pausePending || activity === 'ACTIVE') void pause();
      else { closeMedia(); cancelTimers(); }
    } else if (initialized && requireOwner()) {
      if (terminal()) { if (['FINISHING', 'FINISHED'].includes(activity)) void loadOrganization(); else void finish(); }
      else if (state.call || state.pausePending || waitingForTransport() || activity === 'ACTIVE') void pause();
      else { scheduleInputPoll(); emit(); }
    }
  }
  function preserveFinishOnUnload() {
    if (state.finishRequested && view.sessionId && biographyId && token && !['FINISHING', 'FINISHED'].includes(activity)) {
      try { api.completeInterviewSessionOnUnload?.(view.sessionId, biographyId, token); } catch (_) { /* Keep the durable local finish intent. */ }
    }
  }
  function destroy() {
    ++intentVersion; ++organizationVersion;
    visible = false; closeMedia(); cancelTimers(); settleWaiters(new Error('页面已关闭，材料已保留。'));
    pendingAutoResume = false;
    preserveFinishOnUnload();
    if (sameOwner() && !terminal() && (state.call || starting || state.pausePending || activity === 'ACTIVE')) {
      void pause();
      if (api.pauseInterviewSessionOnUnload) api.pauseInterviewSessionOnUnload(view.sessionId, token);
      else if (state.call?.callId) api.stopRealtimeCallOnUnload?.(state.call.callId, token);
    }
    alive = false;
    view.resumeOpenings = [];
  }
  return { initialize, setEntry, uploadPhotos, retryUpload, removePhoto, submit, retryInput, start, resume,
    pause, retryPause: pause, finish, retryOrganization, refresh, toggleMute, setVisible, destroy, authChanged, snapshot };
}
