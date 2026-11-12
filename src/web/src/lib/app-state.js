/* 管理页面间共享的 Biography 和已讲过的未完成 Session 标识，不缓存服务端正文或历史。 */

const BIOGRAPHY_ID_KEY = "manji.web2.biography_id";
const ACTIVE_SESSION_ID_KEY = "manji.web2.active_session_id";
const ACTIVE_SESSION_IDS_KEY = "manji.web2.active_session_ids";
const ORGANIZATION_SESSION_ID_KEY = "manji.web2.organization_session_id";
const PHOTO_LAUNCH_IDS_KEY = "manji.web2.photo_interview_launch_ids";

function read(key) {
  try {
    return window.sessionStorage.getItem(key) || null;
  } catch (_error) {
    return null;
  }
}

function write(key, value) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch (_error) {
    // 浏览器禁用本地存储时，页面仍可依靠 URL 参数完成当前流程。
  }
}

export function getBiographyId() {
  return read(BIOGRAPHY_ID_KEY);
}

export function setBiographyId(biographyId) {
  write(BIOGRAPHY_ID_KEY, biographyId);
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

function normalizeSessionIds(sessionIds) {
  const normalized = [];
  const seen = new Set();
  (Array.isArray(sessionIds) ? sessionIds : []).forEach((sessionId) => {
    const value = normalizeSessionId(sessionId);
    if (!value || seen.has(value)) return;
    seen.add(value);
    normalized.push(value);
  });
  return normalized;
}

function persistActiveSessionIds(sessionIds) {
  const normalized = normalizeSessionIds(sessionIds);
  write(
    ACTIVE_SESSION_IDS_KEY,
    normalized.length ? JSON.stringify(normalized) : null,
  );
  // 保留旧键作为兼容镜像，供尚未迁移的页面读取最近 Session。
  write(ACTIVE_SESSION_ID_KEY, normalized[0] || null);
  return normalized;
}

export function getActiveSessionIds() {
  let storedSessionIds = [];
  const storedValue = read(ACTIVE_SESSION_IDS_KEY);
  if (storedValue) {
    try {
      storedSessionIds = normalizeSessionIds(JSON.parse(storedValue));
    } catch (_error) {
      storedSessionIds = [];
    }
  }

  const legacySessionId = normalizeSessionId(read(ACTIVE_SESSION_ID_KEY));
  if (!storedSessionIds.length && legacySessionId) {
    storedSessionIds = [legacySessionId];
  }

  return persistActiveSessionIds(storedSessionIds);
}

export function getActiveSessionId() {
  return getActiveSessionIds()[0] || null;
}

export function setActiveSessionId(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return getActiveSessionIds();
  return persistActiveSessionIds([
    normalizedSessionId,
    ...getActiveSessionIds().filter((item) => item !== normalizedSessionId),
  ]);
}

export function removeActiveSessionId(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return getActiveSessionIds();
  return persistActiveSessionIds(
    getActiveSessionIds().filter((item) => item !== normalizedSessionId),
  );
}

export function clearActiveSessionId(sessionId = "") {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (normalizedSessionId) return removeActiveSessionId(normalizedSessionId);
  return persistActiveSessionIds([]);
}

export function getOrganizationSessionId() {
  return read(ORGANIZATION_SESSION_ID_KEY);
}

export function setOrganizationSessionId(sessionId) {
  write(ORGANIZATION_SESSION_ID_KEY, sessionId);
}

export function clearOrganizationSessionId() {
  write(ORGANIZATION_SESSION_ID_KEY, null);
}

export function isDirectPhotoContext(context) {
  return context?.analysis_source === "DIRECT_IMAGE"
    && ["photo-dialogue", "photo-dialogue-1.0", "photo-dialogue-1.1"].includes(context?.flow_release_id);
}

export function isRetiredPhotoSession(session) {
  return session?.flow_version !== "interview" && session?.mode === "PHOTO" && !isDirectPhotoContext(session.photo_group);
}

export function isResumableSession(session) {
  if (session?.flow_version === "interview") {
    return session.status === "ACTIVE" && session.activity_state !== "FINISHING";
  }
  return session?.status === "ACTIVE" && !isRetiredPhotoSession(session)
    && (session.mode === "PHOTO" || (Array.isArray(session.turns) && session.turns.length > 0));
}

export function getPhotoLaunchIds() {
  try { return normalizeSessionIds(JSON.parse(read(PHOTO_LAUNCH_IDS_KEY) || "[]")); }
  catch (_error) { return []; }
}

export function setPhotoLaunchId(id) {
  if (!id) return;
  write(PHOTO_LAUNCH_IDS_KEY, JSON.stringify([id, ...getPhotoLaunchIds().filter((item) => item !== id)]));
}

export function removePhotoLaunchId(id) {
  const ids = getPhotoLaunchIds().filter((item) => item !== id);
  write(PHOTO_LAUNCH_IDS_KEY, ids.length ? JSON.stringify(ids) : null);
}
