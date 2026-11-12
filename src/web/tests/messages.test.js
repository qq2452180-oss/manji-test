import { describe, expect, it } from 'vitest';
import { savedMessages } from '../src/lib/messages.js';

const at = seconds => `2026-10-19T10:00:${String(seconds).padStart(2, '0')}.000000Z`;
const opening = (call_id, text, created_at) => ({ call_id, text, created_at });
const turn = (sequence_no, user_text, assistant_text, extra = {}) => ({
  session_id: 'session-a', turn_id: `turn-${sequence_no}`, sequence_no, user_text, assistant_text, ...extra,
});
const messages = data => savedMessages({ session_id: 'session-a', ...data });

describe('saved interview message timeline', () => {
  it('places each saved resume question before its call answers and deduplicates by call ID', () => {
    const first = opening('call-1', '后来去了哪里？', at(10));
    const second = opening('call-2', '接着讲讲那份工作？', at(20));
    const result = messages({ opening_assistant_text: '从哪里说起？', resume_openings: [second, first, second], turns: [
      turn(3, '工作在船上。', '船上有什么？', { realtime_call_id: 'call-2', call_started_at: at(20), created_at: at(21) }),
      turn(1, '小时候住在河边。', '河边有什么？', { created_at: at(1) }),
      turn(2, '后来去城里。', '去做什么？', { realtime_call_id: 'call-1', call_started_at: at(10), created_at: at(11) }),
    ] });
    expect(result.map(item => item.text)).toEqual([
      '从哪里说起？', '小时候住在河边。', '河边有什么？', '后来去了哪里？', '后来去城里。', '去做什么？',
      '接着讲讲那份工作？', '工作在船上。', '船上有什么？',
    ]);
    expect(result.filter(item => item.id.startsWith('resume-opening:')).map(item => item.id))
      .toEqual(['resume-opening:call-1', 'resume-opening:call-2']);
  });

  it('keeps a late old-call turn before a new question even when call starts share a millisecond', () => {
    const oldTime = '2026-10-19T10:00:00.000100Z', newTime = '2026-10-19T10:00:00.000900Z';
    const result = messages({ resume_openings: [opening('new-call', '后来到了哪里？', newTime)], turns: [
      turn(2, '到了上海。', '在上海做什么？', { realtime_call_id: 'new-call', call_started_at: newTime, created_at: at(2) }),
      turn(3, '河边还有一座桥。', '', { realtime_call_id: 'old-call', call_started_at: oldTime, created_at: at(3), response_state: 'INTERRUPTED' }),
      turn(1, '我小时候住在河边。', '那里有什么？', { realtime_call_id: 'old-call', call_started_at: oldTime, created_at: at(1) }),
    ] });
    expect(result.filter(item => item.text).map(item => item.text)).toEqual([
      '我小时候住在河边。', '那里有什么？', '河边还有一座桥。', '后来到了哪里？', '到了上海。', '在上海做什么？',
    ]);
    expect(result.find(item => item.id === 'turn-3-assistant').state).toContain('回复已被打断');
  });

  it('retains sequence, photos and response states for older records without timestamps', () => {
    const result = messages({ turns: [
      turn(2, '后来去了城里。', '', { response_state: 'FAILED' }),
      turn(1, '', '照片里是谁？', { photos: [{ media_id: 'photo-a' }], media_ids: ['photo-a', 'photo-b'], response_state: 'GENERATED', realtime_call_id: 'photo-call' }),
    ] });
    expect(result.map(item => item.id)).toEqual(['turn-1-user', 'turn-1-assistant', 'turn-2-user', 'turn-2-assistant']);
    expect(result[0].photos).toEqual(['photo-a', 'photo-b']);
    expect(result[1].state).toContain('播放情况未确认');
    expect(result[3].state).toBe('小暖未能完成回复');
  });

  it('does not turn a current question or photo response replay into another saved message', () => {
    const result = messages({ question: '照片里是谁？', opening_response_id: 'photo-response', resume_openings: [],
      turns: [turn(1, '', '照片里是谁？', { media_ids: ['photo-a'], response_id: 'photo-response', response_state: 'GENERATED' })] });
    expect(result.filter(item => item.text === '照片里是谁？')).toHaveLength(1);
    expect(result.some(item => item.id.startsWith('resume-opening:'))).toBe(false);
  });

  it('uses the opening anchor when older RTC payloads omit call time and excludes foreign records', () => {
    const result = messages({ resume_openings: [
      opening('call-a', '上次提到那条河。', at(1)),
      { ...opening('foreign-call', '其他会话的秘密', at(1)), session_id: 'session-b' },
      opening('', '没有通话标识', at(1)), opening('blank', ' ', at(1)),
    ], turns: [
      turn(1, '河水很清。', '河边还有什么？', { realtime_call_id: 'call-a' }),
      turn(2, '其他会话的回答', '', { session_id: 'session-b' }),
    ] });
    expect(result.map(item => item.text)).toEqual(['上次提到那条河。', '河水很清。', '河边还有什么？']);
  });
});
