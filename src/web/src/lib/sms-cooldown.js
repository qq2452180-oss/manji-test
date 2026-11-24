const STORAGE_KEY = 'manji.sms.cooldowns';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 30;
export const SMS_LIMIT_LABELS = {
  SMS_PHONE_LIMIT: '该手机号近 24 小时的验证码发送次数已达上限',
  SMS_IP_LIMIT: '当前网络近 24 小时的验证码发送次数已达上限',
};

export async function cooldownKey(phone) {
  // Keep timing hints per tab without putting the phone number in browser storage.
  try {
    const saltKey = STORAGE_KEY + '.salt';
    let salt = sessionStorage.getItem(saltKey);
    if (!salt) {
      salt = crypto.randomUUID();
      sessionStorage.setItem(saltKey, salt);
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + phone));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

function storedCooldowns() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY)); }
  catch { /* Treat unavailable or unreadable storage as empty. */ }
  // Older tabs wrote an array ordered by send time.
  if (Array.isArray(saved)) saved = { entries: saved, latestKey: saved.at(-1)?.key };
  if (!Array.isArray(saved?.entries)) return { entries: [], latestKey: null };
  const now = Date.now();
  const entries = saved.entries.filter(entry => typeof entry?.key === 'string' && Number.isSafeInteger(entry.retryAt)
    && entry.retryAt > now && entry.retryAt <= now + DAY_MS
    && (entry.reason === 'SMS_COOLDOWN' || entry.reason === 'SMS_PHONE_LIMIT'));
  return { entries, latestKey: saved.latestKey };
}

export function readCooldown(key) {
  return key ? storedCooldowns().entries.find(entry => entry.key === key) || null : null;
}

export function readLatestCooldown() {
  const { entries, latestKey } = storedCooldowns();
  return entries.find(entry => entry.key === latestKey) || null;
}

export function writeCooldown(key, reason, retryAt) {
  if (!key) return;
  try {
    const entries = storedCooldowns().entries.filter(entry => entry.key !== key);
    // An IP limit may no longer apply after opening the page on a different network.
    if (reason !== 'SMS_IP_LIMIT' && retryAt > Date.now()) entries.push({ key, reason, retryAt });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: entries.slice(-MAX_ENTRIES), latestKey: key }));
  } catch { /* Sending still uses the server's limit when browser storage is unavailable. */ }
}
