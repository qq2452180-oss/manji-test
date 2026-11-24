/* 统一封装慢记页面对 FastAPI 的同源请求、超时处理和错误解析。 */
import {
  AUTH_TOKEN_KEY, PREVIOUS_GUEST_KEY, cookieOwner, getAuthToken, isCookieOwner, legacyUser,
  rememberLegacyUser, sessionHeaders, setAuthToken, setCookieSession, usesCookieSession, validSessionId,
} from "./browser-session.js";

export { getAuthToken, sessionHeaders, setAuthToken };

const API_PREFIX = "/api";
const DEFAULT_TIMEOUT_MS = 65000;
const VOICE_TURN_TIMEOUT_MS = 135000;
const SPEECH_SYNTHESIS_TIMEOUT_MS = 90000;
let authVersion = 0;
let memberProbe = null;
let pendingMutation = Promise.resolve();
window.addEventListener?.("manji:auth-changed", () => { authVersion += 1; });

function changedContext() {
  return new ApiError("登录状态已变化，请重新打开当前页面。", { code: "AUTH_CONTEXT_CHANGED" });
}

function withSessionMutation(owner, version, action) {
  const run = () => {
    if (version !== authVersion || owner !== getAuthToken()) throw changedContext();
    return action();
  };
  // Keep Set-Cookie responses ordered across tabs, including the confirming /me.
  if (navigator.locks?.request) return navigator.locks.request("manji.browser.session", run);
  const result = pendingMutation.then(run);
  pendingMutation = result.catch(() => {});
  return result;
}

export function handleSessionFailure(status, code, owner = getAuthToken()) {
  if (owner !== getAuthToken() || !owner || (status !== 401 && !(status === 409 && code === "AUTH_CONTEXT_CHANGED"))) return;
  if (usesCookieSession()) setCookieSession("");
  else { try { setAuthToken(""); } catch { /* Tab storage may be disabled. */ } }
}

function handleAuthenticationFailure(status, code, owner, redirect) {
  handleSessionFailure(status, code, owner);
  if (redirect && status === 401) {
    const prefix = usesCookieSession() ? "/web/" : "/web2/";
    if (window.location.pathname?.endsWith(prefix + "login.html")) return;
    const next = window.location.pathname?.startsWith(prefix)
      ? window.location.pathname + window.location.search : prefix + "index.html";
    window.location.replace(prefix + "login.html?next=" + encodeURIComponent(next));
  }
}

function normalizeUser(user) {
  return user && user.id == null && user.user_id != null ? { ...user, id: user.user_id } : user;
}

export async function getCurrentUser({ redirectOnUnauthorized = true, preserveAuthOnUnauthorized = false } = {}) {
  const path = `${API_PREFIX}/auth/me`;
  const options = { redirectOnUnauthorized, preserveAuthOnUnauthorized };
  if (!usesCookieSession()) return normalizeUser(await request(path, options));
  // Login and protected pages may both probe the same old tab during startup.
  // Only one request may rotate that tab's legacy credential.
  const owner = getAuthToken(), version = authVersion;
  if (memberProbe?.owner === owner && memberProbe.version === version
    && memberProbe.options.redirectOnUnauthorized === redirectOnUnauthorized
    && memberProbe.options.preserveAuthOnUnauthorized === preserveAuthOnUnauthorized) return memberProbe.promise;
  const probe = { owner, version, options };
  probe.promise = discoverBrowserUser(path, options).finally(() => { if (memberProbe === probe) memberProbe = null; });
  memberProbe = probe;
  return probe.promise;
}

async function discoverBrowserUser(path, { redirectOnUnauthorized, preserveAuthOnUnauthorized }) {
  const owner = getAuthToken();
  const version = authVersion;
  let credential = owner;
  let result;
  try {
    try { result = await request(path, { preserveAuthOnUnauthorized: true }); }
    catch (error) {
      if (error.status !== 409 || error.code !== "AUTH_CONTEXT_CHANGED" || owner !== getAuthToken()) throw error;
      // Only this read-only discovery request may retry without the old session id.
      credential = "";
      result = await request(path, { authToken: "", preserveAuthOnUnauthorized: true });
    }
  } catch (error) {
    if (!preserveAuthOnUnauthorized && error.status === 401 && owner === getAuthToken()) {
      handleAuthenticationFailure(error.status, error.code, owner, redirectOnUnauthorized);
    }
    throw error;
  }
  if (version !== authVersion || owner !== getAuthToken()) throw changedContext();
  const user = normalizeUser(result);
  if (!user?.id || typeof user.is_guest !== "boolean") throw invalidSession();
  if (!credential || isCookieOwner(credential)) {
    if (!validSessionId(user.session_id)) throw invalidSession();
    if (cookieOwner(user.session_id) !== owner) {
      const pending = owner && !isCookieOwner(owner) ? legacyUser() : null;
      const sameMember = !user.is_guest && pending?.userId === String(user.id);
      setCookieSession(user.session_id, {
        notify: Boolean(owner) && !sameMember,
        draftOwner: sameMember ? owner : "", upgradeFrom: sameMember ? pending.sessionId : "",
      });
    }
  } else if (!user.is_guest && validSessionId(user.session_id)) {
    rememberLegacyUser(user);
    return withSessionMutation(owner, version, () => upgradeLegacySession(owner, user, version));
  }
  return user;
}

export async function startGuest() {
  const originalToken = getAuthToken();
  const result = await request(`${API_PREFIX}/auth/guest`, { method: "POST", redirectOnUnauthorized: false });
  if (getAuthToken() !== originalToken) throw new ApiError("登录状态已变化，请重新选择聊天方式。", { code: "AUTH_CONTEXT_CHANGED" });
  if (!result?.user?.id || result.user.is_guest !== true || !/^[A-Za-z0-9_-]{43}$/.test(result.token || "")) {
    throw new ApiError("体验暂时没有准备好，请再试一次。", { code: "GUEST_SESSION_INVALID" });
  }
  setAuthToken(result.token);
  return result;
}

export function getGuestTrial() { return request(`${API_PREFIX}/interview/trial`); }

function memberSession(result) {
  const user = normalizeUser(result?.user);
  if (!user?.id || (user.is_guest !== undefined && user.is_guest !== false) ||
      typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token)) {
    throw new ApiError("账号暂时没有准备好，请再试一次。", { code: "AUTH_RESPONSE_INVALID" });
  }
  return { ...result, user: { ...user, is_guest: false } };
}

function invalidSession() { return new ApiError("登录信息无法确认，请重新登录。", { code: "AUTH_RESPONSE_INVALID" }); }

async function confirmMemberCookie(result) {
  const user = normalizeUser(result?.user);
  if (!user?.id || user.is_guest === true || !validSessionId(result.session_id) || result.token !== undefined) throw invalidSession();
  let confirmed;
  try {
    // Probe the actual cookie even if the browser kept an older cookie or rejected the new one.
    confirmed = normalizeUser(await request(`${API_PREFIX}/auth/me`, { authToken: "", preserveAuthOnUnauthorized: true }));
  } catch (error) {
    if (error.status === 401) {
      throw new ApiError("浏览器未保存登录状态，请允许本站使用 Cookie 后重新登录。", { code: "COOKIE_SESSION_UNAVAILABLE" });
    }
    throw error;
  }
  if (confirmed?.session_id !== result.session_id) throw changedContext();
  if (confirmed.is_guest !== false || String(confirmed.id) !== String(user.id)) throw invalidSession();
  return confirmed;
}

async function upgradeLegacySession(owner, user, version) {
  let confirmed;
  try {
    const result = await request(`${API_PREFIX}/auth/session/upgrade`, {
      method: "POST", authToken: owner, expectedSessionId: user.session_id, preserveAuthOnUnauthorized: true,
    });
    confirmed = await confirmMemberCookie(result);
  } catch (error) {
    if (version !== authVersion || owner !== getAuthToken()) throw changedContext();
    if (error.status !== 401 && !(error.status === 409 && error.code === "AUTH_CONTEXT_CHANGED")) throw error;
    // Another tab may already have rotated this legacy credential. Probe its cookie once.
    confirmed = normalizeUser(await request(`${API_PREFIX}/auth/me`, { authToken: "", preserveAuthOnUnauthorized: true }));
  }
  if (version !== authVersion || owner !== getAuthToken()) throw changedContext();
  if (confirmed?.is_guest !== false || String(confirmed.id) !== String(user.id) || !validSessionId(confirmed.session_id)) throw changedContext();
  setCookieSession(confirmed.session_id, { notify: false, draftOwner: owner, upgradeFrom: user.session_id });
  return confirmed;
}

async function browserLogin(path, body, upgradingGuest = false) {
  const owner = getAuthToken();
  const version = authVersion;
  const original = owner && upgradingGuest ? await getCurrentUser({ redirectOnUnauthorized: false }) : null;
  return withSessionMutation(owner, version, async () => {
    const result = await request(path, {
      method: "POST", body, expectedSessionId: owner ? null : "anonymous", preserveAuthOnUnauthorized: true,
    });
    if (version !== authVersion || owner !== getAuthToken()) throw changedContext();
    await confirmMemberCookie(result);
    if (version !== authVersion || owner !== getAuthToken()) throw changedContext();
    const user = normalizeUser(result.user);
    const sameGuest = original?.is_guest === true && String(original.id) === String(user.id);
    setCookieSession(result.session_id, { draftOwner: sameGuest ? owner : "" });
    return { user: { ...user, is_guest: false }, session_id: result.session_id };
  });
}

async function accountAuthentication(action, username, password, { preserveGuest = false } = {}) {
  if (usesCookieSession()) {
    return browserLogin(`${API_PREFIX}/auth/${action}`, { username: String(username || "").trim().toLowerCase(), password }, action === "register");
  }
  const originalToken = getAuthToken();
  let result = await request(`${API_PREFIX}/auth/${action}`, {
    method: "POST", body: { username: String(username || "").trim().toLowerCase(), password },
    preserveAuthOnUnauthorized: true,
  });
  if (getAuthToken() !== originalToken) throw new ApiError("登录状态已变化，请重新登录。", { code: "AUTH_CONTEXT_CHANGED" });
  // The current register endpoint returns only the user. A guest upgrade keeps
  // its existing token; an anonymous registration needs a separate login.
  if (action === "register" && result?.id && !result.user && result.token === undefined && (result.is_guest === undefined || result.is_guest === false)) {
    if (!originalToken) {
      try { return await accountAuthentication("login", username, password); }
      catch (error) {
        if (error.code === "AUTH_CONTEXT_CHANGED" || getAuthToken() !== originalToken) throw error;
        throw new ApiError("账号已创建，但自动登录未完成，请使用刚才的账号和密码登录。", { code: "REGISTRATION_LOGIN_REQUIRED", status: error.status });
      }
    }
    result = { token: originalToken, user: result };
  }
  result = memberSession(result);
  if (action === "register" && originalToken && result.token === originalToken) {
    // Preserve both drafts and their token-based owner after upgrading in place.
    window.sessionStorage.removeItem(PREVIOUS_GUEST_KEY);
    if (typeof window.dispatchEvent === "function") window.dispatchEvent(new Event("manji:auth-changed"));
    return result;
  }
  // Registration with an authenticated guest upgrades that same owner. Keep
  // its recoverable work while token replacement still closes old media.
  const drafts = [];
  if (action === "register" && originalToken) {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith("manji.") && ![AUTH_TOKEN_KEY, PREVIOUS_GUEST_KEY].includes(key)) drafts.push([key, window.sessionStorage.getItem(key)]);
    }
  }
  setAuthToken(result.token);
  for (const [key, value] of drafts) window.sessionStorage.setItem(key, value);
  if (action === "login" && preserveGuest && originalToken) window.sessionStorage.setItem(PREVIOUS_GUEST_KEY, originalToken);
  return result;
}

export function registerAccount(username, password) { return accountAuthentication("register", username, password); }
export function loginAccount(username, password, options) { return accountAuthentication("login", username, password, options); }

function requestSms(action, body) {
  return request(`${API_PREFIX}/auth/sms/${action}`, {
    method: "POST", body, authToken: "", preserveAuthOnUnauthorized: true,
  });
}

function parseSmsCaptcha(captcha) {
  if (typeof captcha?.id !== "string" || !captcha.id.trim() ||
      typeof captcha.image !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(captcha.image)) {
    throw new ApiError("图片验证码加载失败，请重试。", { code: "SMS_CAPTCHA_RESPONSE_INVALID" });
  }
  return { id: captcha.id, image: captcha.image };
}

export async function getSmsCaptcha(phone) {
  return parseSmsCaptcha(await requestSms("captcha", { phone: phone.trim() }));
}

export async function sendSmsCode(phone, captcha) {
  const body = { phone: phone.trim() };
  if (captcha) body.captcha = { id: captcha.id, answer: captcha.answer };
  let result;
  try {
    result = await requestSms("send", body);
  } catch (error) {
    if (error.code === "SMS_CAPTCHA_REQUIRED" || error.code === "SMS_CAPTCHA_INVALID") {
      throw new ApiError(error.message, {
        status: error.status, code: error.code, details: { captcha: parseSmsCaptcha(error.details?.captcha) },
      });
    }
    throw error;
  }
  if (!Number.isSafeInteger(result?.expires_in) || result.expires_in <= 0 ||
      !Number.isSafeInteger(result?.retry_after) || result.retry_after < 0) {
    throw new ApiError("暂时无法确认验证码发送结果，请稍后重试。", { code: "SMS_RESPONSE_INVALID" });
  }
  const timing = { expires_in: result.expires_in, retry_after: result.retry_after };
  if (result.rate_limit_code) timing.rate_limit_code = result.rate_limit_code;
  return timing;
}

export async function loginWithSms(phone, code) {
  if (usesCookieSession()) return browserLogin(`${API_PREFIX}/auth/sms/login`, { phone: phone.trim(), code });
  const owner = getAuthToken();
  const result = await requestSms("login", { phone: phone.trim(), code });
  if (owner !== getAuthToken()) throw new ApiError("登录状态已变化，请重新登录。", { code: "AUTH_CONTEXT_CHANGED" });
  const session = memberSession(result);
  setAuthToken(session.token);
  return session;
}

function previousGuestToken() {
  try { return window.sessionStorage.getItem(PREVIOUS_GUEST_KEY) || ""; }
  catch (_) { return ""; }
}
export function hasPreviousGuest() { return Boolean(previousGuestToken()); }
export async function restoreGuest() {
  const memberToken = getAuthToken(), guestToken = previousGuestToken();
  if (!guestToken) throw new ApiError("没有可返回的体验记录。", { code: "PREVIOUS_GUEST_UNAVAILABLE" });
  const unchanged = () => memberToken === getAuthToken() && guestToken === previousGuestToken();
  try {
    const user = normalizeUser(await request(`${API_PREFIX}/auth/me`, { authToken: guestToken, preserveAuthOnUnauthorized: true }));
    if (!unchanged()) throw new ApiError("登录状态已变化，请重新打开当前页面。", { code: "AUTH_CONTEXT_CHANGED" });
    if (!user?.id || user.is_guest !== true) {
      window.sessionStorage.removeItem(PREVIOUS_GUEST_KEY);
      throw new ApiError("这次体验已不可用，请继续使用当前账号。", { code: "PREVIOUS_GUEST_UNAVAILABLE" });
    }
    setAuthToken(guestToken);
    return user;
  } catch (error) {
    if (error.status === 401 && unchanged()) {
      window.sessionStorage.removeItem(PREVIOUS_GUEST_KEY);
      throw new ApiError("这次体验已失效，请继续使用当前账号。", { code: "PREVIOUS_GUEST_UNAVAILABLE" });
    }
    throw error;
  }
}

export function updateProfile(profile) {
  return request(`${API_PREFIX}/auth/me`, { method: "PATCH", body: profile });
}

export async function logout() {
  if (usesCookieSession()) {
    if (!getAuthToken()) {
      try { await getCurrentUser({ redirectOnUnauthorized: false }); }
      catch (error) { if (error.status === 401) return; throw error; }
    }
    const owner = getAuthToken();
    return withSessionMutation(owner, authVersion, async () => {
      try { await request(`${API_PREFIX}/auth/logout`, { method: "POST", preserveAuthOnUnauthorized: true }); }
      catch (error) {
        if (error.status !== 401) {
          handleSessionFailure(error.status, error.code, owner);
          throw error;
        }
      }
      if (owner !== getAuthToken()) throw changedContext();
      setCookieSession("");
    });
  }
  try { await request(`${API_PREFIX}/auth/logout`, { method: "POST" }); }
  finally { setAuthToken(""); }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED", details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function resourcePath(segment, id, suffix = "") {
  return `${API_PREFIX}/${segment}/${encodeURIComponent(id)}${suffix}`;
}

function errorPayload(payload, fallback) {
  const detail = payload && payload.detail;
  if (typeof detail === "string" && typeof payload.code === "string") {
    return { code: payload.code, message: detail, details: payload };
  }
  if (detail && !Array.isArray(detail) && typeof detail === "object") {
    return {
      code: detail.code || fallback,
      message: detail.message || "请求没有成功，请稍后重试。",
      details: detail,
    };
  }
  if (Array.isArray(detail)) {
    return {
      code: "VALIDATION_ERROR",
      message: detail[0]?.msg || "提交内容不完整，请检查后重试。",
      details: detail,
    };
  }
  return {
    code: fallback,
    message: typeof detail === "string" ? detail : "请求没有成功，请稍后重试。",
    details: detail || null,
  };
}

async function request(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS, responseType = "json", redirectOnUnauthorized = true, preserveAuthOnUnauthorized = false, authToken, expectedSessionId } = {}) {
  const ownerToken = getAuthToken();
  const ownerVersion = authVersion;
  const assertOwner = () => {
    if (ownerVersion !== authVersion || ownerToken !== getAuthToken()) throw changedContext();
  };
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const options = {
    method,
    headers: sessionHeaders({ Accept: responseType === "blob" ? "image/jpeg, image/png, image/webp, application/json" : "application/json" }, authToken === undefined ? ownerToken : authToken),
    credentials: "same-origin",
    cache: "no-store",
    signal: controller.signal,
  };
  if (expectedSessionId) options.headers["X-Manji-Session-Id"] = expectedSessionId;
  if (body !== undefined) {
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      options.body = body;
    } else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }

  try {
    const response = await fetch(path, options);
    assertOwner();
    const contentType = response.headers.get("content-type") || "";
    const payload = response.status !== 204 && contentType.includes("application/json")
      ? await response.json()
      : null;
    // Account form failures and guest restoration must preserve the current
    // identity; their response bodies remain fenced even when rejected.
    assertOwner();
    if (!response.ok) {
      const parsed = errorPayload(payload, `HTTP_${response.status}`);
      if (!preserveAuthOnUnauthorized) handleAuthenticationFailure(response.status, parsed.code, ownerToken, redirectOnUnauthorized);
      throw new ApiError(parsed.message, {
        status: response.status,
        code: parsed.code,
        details: parsed.details,
      });
    }
    if (responseType === "blob") {
      if (!/^image\/(jpeg|png|webp)(?:;|$)/i.test(contentType)) {
        throw new ApiError("照片暂时无法预览，请重试。", { code: "PHOTO_PREVIEW_INVALID" });
      }
      const photo = await response.blob();
      assertOwner();
      if (!photo.size) {
        throw new ApiError("照片内容为空，请重试。", { code: "PHOTO_PREVIEW_EMPTY" });
      }
      return photo;
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError") {
      throw new ApiError("请求超时，请检查网络后重试。", {
        code: "REQUEST_TIMEOUT",
      });
    }
    throw new ApiError("暂时无法连接慢记服务，请稍后重试。", {
      code: "NETWORK_ERROR",
      details: error,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function uploadPhoto(photo) {
  const form = new FormData();
  form.append("photo", photo, photo.name || "photo");
  return request(`${API_PREFIX}/media/photos`, { method: "POST", body: form });
}

export function getPhotoBlob(mediaId) {
  return request(resourcePath("media/photos", mediaId), { responseType: "blob" });
}

export function deletePhoto(mediaId) {
  return request(resourcePath("media/photos", mediaId), { method: "DELETE" });
}

export function analyzePhotoNarrative(mediaId) {
  return request(resourcePath("media/photos", mediaId, "/narrative-analysis"), {
    method: "POST", timeoutMs: 75000,
  });
}

export function getPhotoNarrativeAnalysis(analysisId) {
  return request(resourcePath("photo-analyses", analysisId));
}

export function getLatestPhotoNarrativeAnalysis(mediaId) {
  return request(resourcePath("media/photos", mediaId, "/narrative-analysis/latest"));
}

export function getPhotoInterviewConfig() {
  return request(`${API_PREFIX}/photo-interviews/config`);
}

export function createPhotoInterview(mediaIds, clientRequestId, analysisId, flowReleaseId) {
  const body = { media_ids: mediaIds, client_request_id: clientRequestId };
  // Optional fields only replay frozen historical requests; new drafts use
  // the server's single photo interview entry point.
  if (analysisId) body.analysis_id = analysisId;
  if (flowReleaseId) body.flow_release_id = flowReleaseId;
  return request(`${API_PREFIX}/photo-interviews`, {
    method: "POST", body,
  });
}

export function getPhotoInterview(launchId) {
  return request(resourcePath("photo-interviews", launchId));
}

export function retryPhotoInterview(launchId) {
  return request(resourcePath("photo-interviews", launchId, "/retry"), { method: "POST" });
}

export function releasePhotoInterviewPhotos(launchId) {
  return request(resourcePath("photo-interviews", launchId, "/release-photos"), { method: "POST" });
}

export function deletePhotoInterview(launchId) {
  return request(resourcePath("photo-interviews", launchId), { method: "DELETE" });
}

export function bootstrapBiography(title = "我的传记") {
  return request(`${API_PREFIX}/biographies/bootstrap`, {
    method: "POST",
    body: { title },
  });
}

export function getBiography(biographyId) {
  return request(resourcePath("biographies", biographyId));
}

export function getChapter(chapterId) {
  return request(resourcePath("chapters", chapterId));
}

export function getStory(storyId) {
  return request(resourcePath("stories", storyId));
}

export async function readHomeData() {
  const token = getAuthToken();
  const assertOwner = () => {
    if (token !== getAuthToken()) throw new ApiError("登录状态已变化，请重新打开当前页面。", { code: "AUTH_CONTEXT_CHANGED" });
  };
  const created = await bootstrapBiography();
  assertOwner();
  const biography = await getBiography(created.biography_id);
  assertOwner();
  const chapters = await Promise.all((biography.chapters || [])
    .filter(chapter => chapter.story_count > 0).map(chapter => getChapter(chapter.chapter_id)));
  assertOwner();
  const stories = chapters.flatMap(chapter => chapter.stories || []);
  stories.sort((left, right) => new Date(right.current_version?.created_at || 0) - new Date(left.current_version?.created_at || 0));
  return { biography, recentStory: stories[0] || null, stories };
}

export function createSession() {
  return request(`${API_PREFIX}/sessions`, { method: "POST" });
}

export function getSession(sessionId) {
  return request(resourcePath("sessions", sessionId));
}

export function getInterviewConfig() {
  return request(`${API_PREFIX}/interview/config`);
}

export function createInterviewSession(entry = "GENERAL", clientRequestId) {
  return request(`${API_PREFIX}/interview/sessions`, {
    method: "POST", body: { entry, client_request_id: clientRequestId },
  });
}

export function getInterviewSession(sessionId) {
  return request(resourcePath("interview/sessions", sessionId));
}

export function getUnfinishedInterview() {
  return request(`${API_PREFIX}/interview/sessions/unfinished`);
}

export function submitInterviewInput(sessionId, { clientRequestId, text = "", mediaIds = [] }) {
  return request(resourcePath("interview/sessions", sessionId, "/inputs"), {
    method: "POST", body: { client_request_id: clientRequestId, text, media_ids: mediaIds },
  });
}

export function pauseInterviewSession(sessionId) {
  return request(resourcePath("interview/sessions", sessionId, "/pause"), { method: "POST" });
}

export function resumeInterviewSession(sessionId, clientRequestId, openingResponseId) {
  const body = { client_request_id: clientRequestId };
  if (openingResponseId) body.opening_response_id = openingResponseId;
  return request(resourcePath("interview/sessions", sessionId, "/resume"), {
    method: "POST", body, timeoutMs: 45000,
  });
}

export function completeInterviewSession(sessionId, biographyId) {
  return request(resourcePath("interview/sessions", sessionId, "/complete"), {
    method: "POST", body: { biography_id: biographyId },
  });
}

export function getInterviewOrganization(sessionId) {
  return request(resourcePath("interview/sessions", sessionId, "/organization"));
}

export function retryInterviewOrganization(sessionId) {
  return request(resourcePath("interview/sessions", sessionId, "/organization/retry"), { method: "POST" });
}

function interviewOnUnload(sessionId, suffix, originalToken, body) {
  if (!sessionId || !originalToken) return;
  // A departing page owns the original account's session, even after login changes.
  try {
    void fetch(resourcePath("interview/sessions", sessionId, suffix), {
      method: "POST", keepalive: true, cache: "no-store",
      credentials: "same-origin",
      headers: sessionHeaders({ "Content-Type": "application/json" }, originalToken),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {});
  } catch (_error) { /* Browsers may refuse keepalive while shutting down. */ }
}

export function pauseInterviewSessionOnUnload(sessionId, originalToken) {
  interviewOnUnload(sessionId, "/pause", originalToken);
}

export function completeInterviewSessionOnUnload(sessionId, biographyId, originalToken) {
  if (biographyId) interviewOnUnload(sessionId, "/complete", originalToken, { biography_id: biographyId });
}

export function getRealtimeConfig() {
  return request(`${API_PREFIX}/realtime-interview/config`, { timeoutMs: 12000 });
}

export function startRealtimeCall(sessionId, clientRequestId) {
  return request(resourcePath("sessions", sessionId, "/realtime-calls"), {
    method: "POST", body: { client_request_id: clientRequestId }, timeoutMs: 45000,
  });
}

export function getRealtimeCall(callId) {
  return request(resourcePath("realtime-calls", callId), { timeoutMs: 12000 });
}

export function heartbeatRealtimeCall(callId) {
  return request(resourcePath("realtime-calls", callId, "/heartbeat"), { method: "POST", timeoutMs: 12000 });
}

export function stopRealtimeCall(callId, reason = "hangup") {
  return request(resourcePath("realtime-calls", callId, "/stop"), {
    method: "POST", body: { reason }, timeoutMs: 30000,
  });
}

export function stopRealtimeCallOnUnload(callId, originalToken) {
  if (!callId || !originalToken) return;
  // The expected session id also fences keepalive when the shared cookie changes.
  void fetch(resourcePath("realtime-calls", callId, "/stop"), {
    method: "POST", keepalive: true, cache: "no-store",
    credentials: "same-origin",
    headers: sessionHeaders({ "Content-Type": "application/json" }, originalToken),
    body: JSON.stringify({ reason: "background" }),
  }).catch(() => {});
}

export function submitTurn(sessionId, userText, clientRequestId = "") {
  const body = { user_text: userText };
  const normalizedClientRequestId = String(clientRequestId || "").trim();
  if (normalizedClientRequestId) body.client_request_id = normalizedClientRequestId;

  return request(resourcePath("sessions", sessionId, "/turns"), {
    method: "POST",
    body,
  });
}

export function completeSession(sessionId, biographyId) {
  return request(resourcePath("sessions", sessionId, "/complete"), {
    method: "POST",
    body: { biography_id: biographyId },
  });
}

export function getOrganization(sessionId) {
  return request(resourcePath("sessions", sessionId, "/organization"));
}

export function retryOrganization(sessionId) {
  return request(resourcePath("sessions", sessionId, "/organization/retry"), {
    method: "POST",
  });
}

function audioFileExtension(mimeType) {
  const baseMimeType = String(mimeType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
  }[baseMimeType] || "bin";
}

export function transcribeSpeech(audio, mimeType, languageHint = "") {
  const form = new FormData();
  const actualMimeType = String(mimeType || audio?.type || "").trim();
  const normalizedLanguageHint = String(languageHint || "").trim();
  const extension = audioFileExtension(actualMimeType);

  form.append("audio", audio, `recording.${extension}`);
  form.append("mime_type", actualMimeType);
  if (normalizedLanguageHint) form.append("language_hint", normalizedLanguageHint);

  return request(`${API_PREFIX}/speech/transcribe`, {
    method: "POST",
    body: form,
  });
}

export function submitVoiceTurn(
  sessionId,
  audio,
  clientRequestId,
  mimeType,
  languageHint = "",
) {
  const form = new FormData();
  const actualMimeType = String(mimeType || audio?.type || "").trim();
  const normalizedClientRequestId = String(clientRequestId || "").trim();
  const normalizedLanguageHint = String(languageHint || "").trim();
  const extension = audioFileExtension(actualMimeType);

  form.append("audio", audio, `recording.${extension}`);
  form.append("client_request_id", normalizedClientRequestId);
  form.append("mime_type", actualMimeType);
  if (normalizedLanguageHint) form.append("language_hint", normalizedLanguageHint);

  return request(resourcePath("sessions", sessionId, "/voice-turns"), {
    method: "POST",
    body: form,
    timeoutMs: VOICE_TURN_TIMEOUT_MS,
  });
}

export async function synthesizeTurnSpeech(
  sessionId,
  sequenceNo,
  { signal = null, timeoutMs = SPEECH_SYNTHESIS_TIMEOUT_MS } = {},
) {
  const normalizedSequenceNo = Number(sequenceNo);
  if (!Number.isInteger(normalizedSequenceNo) || normalizedSequenceNo < 0) {
    throw new ApiError("无法确定要播放的小暖回复。", {
      code: "TTS_TURN_INVALID",
    });
  }

  const owner = getAuthToken();
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(
      resourcePath(
        "sessions",
        sessionId,
        `/turns/${encodeURIComponent(normalizedSequenceNo)}/speech`,
      ),
      {
        method: "POST",
        credentials: "same-origin", headers: sessionHeaders({ Accept: "audio/*, application/json" }, owner),
        cache: "no-store",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      let payload = null;
      if (contentType.includes("application/json")) {
        try {
          payload = await response.json();
        } catch (_error) {
          payload = null;
        }
      }
      const parsed = errorPayload(payload, `HTTP_${response.status}`);
      if (owner !== getAuthToken()) throw changedContext();
      handleAuthenticationFailure(response.status, parsed.code, owner, true);
      throw new ApiError(parsed.message, {
        status: response.status,
        code: parsed.code,
        details: parsed.details,
      });
    }

    const audio = await response.blob();
    if (owner !== getAuthToken()) throw changedContext();
    if (!audio.size) {
      throw new ApiError("小暖的语音暂时没有生成，请稍后重试。", {
        code: "TTS_EMPTY_RESULT",
      });
    }
    return {
      audio,
      mimeType: response.headers.get("content-type") || audio.type || "audio/wav",
      provider: response.headers.get("x-tts-provider") || "",
      model: response.headers.get("x-tts-model") || "",
      latencyMs: Number(response.headers.get("x-tts-latency-ms")) || null,
      durationMs: Number(response.headers.get("x-audio-duration-ms")) || null,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError") {
      throw new ApiError(
        timedOut ? "小暖语音生成超时，请稍后重试。" : "小暖语音生成已取消。",
        { code: timedOut ? "TTS_TIMEOUT" : "REQUEST_CANCELLED" },
      );
    }
    throw new ApiError("暂时无法连接语音服务，请稍后重试。", {
      code: "NETWORK_ERROR",
      details: error,
    });
  } finally {
    window.clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }
}
