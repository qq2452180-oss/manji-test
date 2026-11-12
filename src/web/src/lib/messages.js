// A photograph is material on its own turn, never an invented user statement.
export function savedMessages(session) {
  const messages = [], opening = String(session.opening_assistant_text || '').trim();
  if (opening) messages.push({ id:'opening', role:'assistant', text:opening, photos:[] });
  const turns = (session.turns || []).filter(turn => turn && (!turn.session_id || turn.session_id === session.session_id))
    .slice().sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0));
  const openings = new Map();
  for (const item of session.resume_openings || []) {
    if (!item || item.session_id && item.session_id !== session.session_id) continue;
    const callId = String(item.call_id || '').trim(), text = String(item.text || '').trim();
    if (callId && text) openings.set(callId, { ...item, call_id: callId, text });
  }
  const timestamp = value => {
    const result = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(result)) return null;
    // PostgreSQL timestamps retain microseconds; Date.parse alone merges calls
    // that began within the same millisecond and can misplace late old turns.
    const fraction = String(value).match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})?$/i)?.[1] || '';
    return result * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
  };
  const timeline = turns.map((turn, index) => ({ turn, index, order: Number(turn.sequence_no || index + 1),
    // Late bridge inputs stay with their original call, before a later resume.
    time: timestamp(turn.call_started_at) ?? timestamp(openings.get(turn.realtime_call_id)?.created_at)
      ?? timestamp(turn.created_at) ?? -Infinity }));
  for (const item of openings.values()) timeline.push({ opening: item, order: -1, time: timestamp(item.created_at) ?? -Infinity });
  timeline.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1) || a.order - b.order);
  timeline.forEach(({ turn, index, opening: resumed }) => {
    if (resumed) {
      messages.push({ id:'resume-opening:' + resumed.call_id, role:'assistant', text:resumed.text, photos:[] });
      return;
    }
    const id = String(turn.turn_id || turn.sequence_no || index), text = String(turn.user_text || '').trim();
    const ids = (turn.photos || []).map(photo => photo.media_id).concat(turn.media_ids || []).filter(Boolean);
    const photos = [...new Set(ids)];
    if (text || photos.length) messages.push({ id:id + '-user', role:'user', text, photos });
    const state = { GENERATING:'小暖正在准备回复', GENERATED:turn.realtime_call_id ? '回复已生成，播放情况未确认' : '', FAILED:'小暖未能完成回复', INTERRUPTED:'回复已被打断，播放情况未确认' }[turn.response_state] || '';
    if (turn.assistant_text || state) messages.push({ id:id + '-assistant', role:'assistant', text:String(turn.assistant_text || '').trim(), state, photos:[] });
  });
  return messages;
}
