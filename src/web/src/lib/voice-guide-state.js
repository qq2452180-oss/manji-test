// Public presentation preference only; never a substitute for mic permission.
export const VOICE_GUIDE_KEY = 'manji.web2.voice-guide.completed.v1';

export function hasCompletedVoiceGuide() {
  return ['localStorage', 'sessionStorage'].some(area => {
    try { return window[area].getItem(VOICE_GUIDE_KEY) === '1'; } catch (_) { return false; }
  });
}

export function completeVoiceGuide() {
  for (const area of ['localStorage', 'sessionStorage']) {
    try { window[area].setItem(VOICE_GUIDE_KEY, '1'); } catch (_) { /* Optional preference. */ }
  }
}
