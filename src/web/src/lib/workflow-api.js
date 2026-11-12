import { ApiError, getAuthToken } from './api.js';

const REQUEST_TIMEOUT_MS = 65000;
const FINISH_TIMEOUT_MS = 300000;
const RESOURCE_ID_FIELDS = new Set([
  'user_id', 'session_id', 'story_id', 'target_story_id', 'chapter_id', 'topic_id', 'source_session_id', 'media_id',
]);
let authVersion = 0;
let identityCache = null;
let identityFlight = null;

window.addEventListener('manji:auth-changed', () => {
  authVersion += 1;
  identityCache = null;
});

export function normalizeId(value) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number <= 0) {
    throw new ApiError('记录编号无效，请重新打开页面。', { code: 'INVALID_ID' });
  }
  return String(number);
}

function authContext() {
  return { token: getAuthToken(), version: authVersion };
}

function sameContext(left, right) {
  return left.token === right.token && left.version === right.version;
}

function assertContext(context) {
  if (!sameContext(context, authContext())) {
    throw new ApiError('登录状态已变化，请重新打开当前页面。', { code: 'AUTH_CONTEXT_CHANGED' });
  }
}

function assertIdentity(identity) {
  if (!identityCache || identityCache.identity !== identity) {
    throw new ApiError('登录状态已变化，请重新打开当前页面。', { code: 'AUTH_CONTEXT_CHANGED' });
  }
  assertContext(identityCache.owner);
}

function normalizeResult(value, catalog = false) {
  if (Array.isArray(value)) return value.map(item => normalizeResult(item, catalog));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    item !== null && (RESOURCE_ID_FIELDS.has(key) || (catalog && key === 'id'))
      ? normalizeId(item) : normalizeResult(item, catalog),
  ]));
}

function responseError(status, body) {
  const detail = body?.detail;
  let message = typeof detail === 'string' ? detail : detail?.message;
  let code = body?.code || detail?.code || `HTTP_${status}`;
  if (Array.isArray(detail)) {
    message = '提交内容无效，请检查后重试。';
    code = 'VALIDATION_ERROR';
  }
  if (status === 401) {
    message = '登录状态已失效，请重新登录后继续。';
    code = 'AUTH_REQUIRED';
  }
  const error = new ApiError(message || '请求没有成功，请稍后重试。', {
    status, code, details: body,
  });
  error.body = body;
  error.sessionId = null;
  if (body?.session_id !== undefined && body.session_id !== null) {
    try { error.sessionId = normalizeId(body.session_id); }
    catch (_) { /* Keep malformed identifiers only in the original error body. */ }
  }
  return error;
}

async function request(path, {
  method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS,
  authenticated = true, accountBound = authenticated,
} = {}) {
  const owner = authContext();
  if (authenticated && !owner.token) {
    throw new ApiError('请先登录，再打开这条记录。', { status: 401, code: 'AUTH_REQUIRED' });
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (authenticated) headers.Authorization = `Bearer ${owner.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(path, {
      method, headers, cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (accountBound) assertContext(owner);
    const isJson = response.headers.get('content-type')?.includes('application/json');
    let payload = null;
    if (isJson) {
      try { payload = await response.json(); }
      catch (_) {
        if (response.ok) {
          throw new ApiError('服务返回的数据无法读取，请稍后重试。', { code: 'INVALID_RESPONSE' });
        }
      }
    }
    if (accountBound) assertContext(owner);
    if (!response.ok) {
      if (response.status === 401 && authenticated) identityCache = null;
      throw responseError(response.status, payload);
    }
    if (!isJson) {
      throw new ApiError('服务返回的数据无法读取，请稍后重试。', { code: 'INVALID_RESPONSE' });
    }
    return payload;
  } catch (error) {
    if (accountBound) assertContext(owner);
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('请求超时，请查看当前进度后重试。', { code: 'REQUEST_TIMEOUT' });
    }
    throw new ApiError('暂时无法连接慢记服务，请检查网络后重试。', { code: 'NETWORK_ERROR' });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function establishIdentity(owner) {
  if (!owner.token) {
    throw new ApiError('请先登录，再继续使用慢记。', { status: 401, code: 'AUTH_REQUIRED' });
  }
  const user = await request('/api/auth/me');
  assertContext(owner);
  if (typeof user?.is_guest !== 'boolean') {
    throw new ApiError('登录信息无法确认，请重新登录。', { code: 'AUTH_RESPONSE_INVALID' });
  }
  if (user.is_guest) {
    // Keep the guest credential so registration can bind its existing records.
    throw new ApiError('请先注册或登录账号，再继续使用慢记。', { status: 401, code: 'AUTH_REQUIRED' });
  }
  const identity = { user_id: normalizeId(user.user_id), is_guest: false };
  identityCache = { owner: authContext(), identity };
  return identity;
}

export function ensureIdentity() {
  const owner = authContext();
  if (identityCache && sameContext(identityCache.owner, owner)) {
    return Promise.resolve(identityCache.identity);
  }
  if (identityFlight && sameContext(identityFlight.owner, owner)) return identityFlight.promise;
  const flight = { owner, promise: null };
  flight.promise = establishIdentity(owner).finally(() => {
    if (identityFlight === flight) identityFlight = null;
  });
  identityFlight = flight;
  return flight.promise;
}

function resourcePath(resource, id, suffix = '') {
  return `/api/${resource}/${normalizeId(id)}${suffix}`;
}

export async function getCatalog() {
  return normalizeResult(await request('/api/catalog', { authenticated: false }), true);
}

export async function startInterview(topicId, { targetStoryId, resumeMode = 'text' } = {}) {
  const topic = topicId == null ? null : Number(normalizeId(topicId));
  const target = targetStoryId == null ? null : Number(normalizeId(targetStoryId));
  if (target && !getAuthToken()) {
    throw new ApiError('请先登录原来的账号，再补充这篇故事。', { status: 401, code: 'AUTH_REQUIRED' });
  }
  const identity = await ensureIdentity();
  assertIdentity(identity);
  return normalizeResult(await request('/api/interviews', {
    method: 'POST', body: { resume_mode: resumeMode, ...(topic ? { topic_id: topic } : {}), ...(target ? { target_story_id: target } : {}) },
  }));
}

export async function getInterview(id) {
  return normalizeResult(await request(resourcePath('interviews', id)));
}

export async function updateInterviewMode(id, resumeMode) {
  return normalizeResult(await request(resourcePath('interviews', id, '/mode'), {
    method: 'PATCH', body: { resume_mode: resumeMode },
  }));
}

function voiceCallPath(callId, suffix = '') {
  if (typeof callId !== 'string' || !/^[a-f0-9]{32}$/.test(callId)) {
    throw new ApiError('通话编号无效，请重新连接。', { code: 'INVALID_CALL_ID' });
  }
  return `/api/rtc/calls/${callId}${suffix}`;
}

function normalizeCall(value) {
  // RTC credentials contain a provider user_id, not a numeric account ID.
  const { credentials, ...call } = value;
  return { ...normalizeResult(call), ...(credentials === undefined ? {} : { credentials }) };
}

export async function prepareVoiceCall(sessionId, clientRequestId, options = {}) {
  const body = { client_request_id: clientRequestId };
  for (const key of ['resume_kind', 'resume_request_id', 'resume_message_id']) {
    if (options[key] !== undefined) body[key] = options[key];
  }
  return normalizeCall(await request(resourcePath('interviews', sessionId, '/calls'), {
    method: 'POST', body,
  }));
}

export async function startVoiceCall(callId) {
  return normalizeCall(await request(voiceCallPath(callId, '/start'), { method: 'POST' }));
}

export async function getVoiceCall(callId) {
  return normalizeCall(await request(voiceCallPath(callId)));
}

export async function stopVoiceCall(callId) {
  return normalizeCall(await request(voiceCallPath(callId, '/stop'), { method: 'POST' }));
}

export function stopVoiceCallOnUnload(callId, originalToken) {
  if (!originalToken) return;
  try {
    void fetch(voiceCallPath(callId, '/stop'), {
      method: 'POST', keepalive: true, cache: 'no-store',
      headers: { Authorization: `Bearer ${originalToken}` },
    }).catch(() => {});
  } catch (_) { /* A departing page still closes its local microphone immediately. */ }
}

export async function submitText(id, text) {
  return normalizeResult(await request(resourcePath('interviews', id, '/input'), {
    method: 'POST', body: { text },
  }));
}

export async function retryInterview(id) {
  return normalizeResult(await request(resourcePath('interviews', id, '/retry'), { method: 'POST' }));
}

export async function finishInterview(id, { rebase = false } = {}) {
  return normalizeResult(await request(resourcePath('interviews', id, '/finish'), {
    method: 'POST', timeoutMs: FINISH_TIMEOUT_MS, ...(rebase ? { body: { rebase: true } } : {}),
  }));
}

export async function getStory(id) {
  return normalizeResult(await request(resourcePath('stories', id)));
}

export async function getHome() {
  return normalizeResult(await request('/api/home'));
}

export async function getBiography() {
  return normalizeResult(await request('/api/biography'));
}

export async function getChapter(id) {
  return normalizeResult(await request(resourcePath('chapters', id)));
}
