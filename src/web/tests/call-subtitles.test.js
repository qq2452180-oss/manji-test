import { describe, expect, it } from 'vitest';
import { createCallSubtitles } from '../src/lib/call-subtitles.js';

function setup() {
  let time = 0, displayed = '';
  const timers = [], changes = [];
  const subtitles = createCallSubtitles({
    onChange: value => { displayed = value; changes.push(value); }, now: () => time,
    schedule: (callback, delay) => {
      const timer = { callback, at: time + delay, cancelled: false };
      timers.push(timer); return timer;
    },
    cancel: timer => { timer.cancelled = true; },
  });
  return { subtitles, timers, changes, get text() { return displayed; },
    advance(next) {
      let callbacks = 0;
      while (true) {
        const timer = timers.filter(item => !item.cancelled && item.at <= next).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        if (++callbacks > 100) throw new Error('Subtitle timers did not advance.');
        timer.cancelled = true; time = timer.at; timer.callback();
      }
      time = next;
    },
  };
}
const packet = (text = '第一句话。第二句话。', overrides = {}) => ({
  text, roundId: 'round-a', startTime: '00:01:00', endTime: '00:01:08', complete: true, ...overrides,
});

describe('one current call subtitle', () => {
  it('replaces short sentences within a long packet and ends at its exact overall duration', () => {
    const view = setup();
    view.advance(1000); view.subtitles.accept(packet());
    expect(view.text).toBe('第一句话。');
    view.advance(4999); expect(view.text).toBe('第一句话。');
    view.advance(5000); expect(view.text).toBe('第二句话。');
    view.advance(8999); expect(view.text).toBe('第二句话。');
    view.advance(9000); expect(view.text).toBe('');
    expect(view.changes).toEqual(['第一句话。', '第二句话。', '']);
  });

  it('advances unequal sentences from fractional arrival time without a zero-delay loop or drift', () => {
    const view = setup(), arrivedAt = 123.456;
    view.advance(arrivedAt);
    view.subtitles.accept(packet('一。这是二句。第三句话现在开始。'));
    expect(view.text).toBe('一。');
    view.advance(arrivedAt + 1000);
    expect(view.text).toBe('这是二句。');
    view.advance(arrivedAt + 3500);
    expect(view.text).toBe('第三句话现在开始。');
    view.advance(arrivedAt + 8000);
    expect(view.text).toBe('');
    expect(view.changes).toEqual(['一。', '这是二句。', '第三句话现在开始。', '']);
    expect(view.timers).toHaveLength(3);
  });

  it('splits a long sentence without losing text and uses a bounded fallback when its duration is zero', () => {
    const view = setup();
    const text = '小时候大家每天都喜欢坐在院子里的那棵大树下面，一边慢慢乘凉一边认真听大人讲从前生活里的故事。';
    view.subtitles.accept(packet(text));
    expect(Array.from(view.text).length).toBeLessThanOrEqual(27);
    expect(view.text.length).toBeLessThan(text.length);
    view.advance(8000);
    expect(view.changes.filter(Boolean).join('')).toBe(text);
    expect(view.text).toBe('');
    const changesBeforeZeroDuration = view.changes.length;
    view.subtitles.accept(packet(text, { startTime: '00:02:00', endTime: '00:02:00' }));
    const first = view.text;
    expect(first.length).toBeLessThan(text.length);
    view.advance(30000);
    expect(view.changes.slice(changesBeforeZeroDuration).filter(Boolean).join('')).toBe(text);
    expect(view.text).toBe('');
  });

  it('keeps the first arrival clock on revisions and ignores duplicates or already elapsed content', () => {
    const view = setup();
    view.subtitles.accept(packet('第一句话。', { endTime: '00:01:04', complete: false }));
    view.advance(3000);
    view.subtitles.accept(packet());
    view.subtitles.accept(packet());
    expect(view.text).toBe('第一句话。');
    view.advance(4000); expect(view.text).toBe('第二句话。');
    view.subtitles.accept(packet('迟到未完成。', { complete: false }));
    expect(view.text).toBe('第二句话。');
    view.advance(8000); expect(view.text).toBe('');
    view.subtitles.accept(packet());
    expect(view.text).toBe('');
    view.subtitles.accept(packet('修订后的第一句话。修订后的第二句话。'));
    expect(view.text).toBe('');
  });

  it('does not return to an earlier sentence when cumulative text and duration expand', () => {
    const view = setup();
    view.subtitles.accept(packet('第一句话。第二句话。', { endTime: '00:01:04', complete: false }));
    view.advance(3000);
    expect(view.text).toBe('第二句话。');
    view.subtitles.accept(packet('第一句话。第二句话。第三句话。', { endTime: '00:01:12' }));
    expect(view.text).toBe('第二句话。');
    view.advance(12000);
    expect(view.changes.filter(Boolean)).toEqual(['第一句话。', '第二句话。', '第三句话。']);
    expect(view.text).toBe('');
  });

  it('shows newly appended text after the original cue expired without replaying its old prefix', () => {
    const view = setup();
    view.subtitles.accept(packet('第一句话。', { endTime: '00:01:02', complete: false }));
    view.advance(6000);
    expect(view.text).toBe('');
    view.subtitles.accept(packet('第一句话。第二句话。', { endTime: '00:01:04' }));
    expect(view.text).toBe('第二句话。');
    view.advance(30000);
    expect(view.changes.filter(Boolean)).toEqual(['第一句话。', '第二句话。']);
    expect(view.text).toBe('');
  });

  it.each(['00:01:00', '00:01:02'])('shows the appended suffix of a completed short line after duration %s becomes valid', endTime => {
    const view = setup();
    const prefix = '这是一个还没有说完';
    const suffix = '但现在补齐了的句子。';
    view.subtitles.accept(packet(prefix, { endTime, complete: false }));
    view.advance(3000);
    expect(view.text).toBe('');
    view.subtitles.accept(packet(prefix + suffix, { endTime: '00:01:05' }));
    expect(view.text).toBe(suffix);
    view.advance(10000);
    expect(view.text).toBe('');
    expect(view.changes.filter(Boolean)).toEqual([prefix, suffix]);
    expect(view.changes.filter(Boolean).join('')).toBe(prefix + suffix);
  });

  it('gives each new packet immediate priority and fences timers from an earlier packet', () => {
    const view = setup();
    view.subtitles.accept(packet());
    const obsolete = view.timers.at(-1).callback;
    view.advance(1000);
    view.subtitles.accept(packet('新的字幕。', { startTime: '00:01:08', endTime: '00:01:10' }));
    expect(view.text).toBe('新的字幕。');
    obsolete(); expect(view.text).toBe('新的字幕。');
    view.subtitles.accept(packet()); expect(view.text).toBe('新的字幕。');
    view.advance(3000); expect(view.text).toBe('');
    view.advance(10000); expect(view.text).toBe('');
  });

  it('retires interruption without allowing queued or late text to reappear', () => {
    const view = setup();
    view.subtitles.accept(packet());
    const obsolete = view.timers.at(-1).callback;
    view.subtitles.state({ roundId: 'round-a', state: 4 });
    expect(view.text).toBe('');
    obsolete(); view.subtitles.accept(packet()); view.advance(10000);
    expect(view.text).toBe('');
    expect(view.changes).toEqual(['第一句话。', '']);
  });

  it('finishes accepted subtitles after done and tail expiry while rejecting later packets', () => {
    const view = setup();
    view.subtitles.accept(packet());
    view.advance(1000);
    view.subtitles.state({ roundId: 'round-a', state: 5 });
    expect(view.text).toBe('第一句话。');
    view.advance(3000);
    view.subtitles.clear({ roundId: 'round-a', reason: 'done_timeout' });
    expect(view.text).toBe('第一句话。');
    view.subtitles.accept(packet('尾窗关闭后到达的字幕。', { startTime: '00:01:09', endTime: '00:01:11' }));
    expect(view.text).toBe('第一句话。');
    view.advance(4000); expect(view.text).toBe('第二句话。');
    view.advance(8000); expect(view.text).toBe('');
    expect(view.changes).toEqual(['第一句话。', '第二句话。', '']);
  });

  it('preserves state 1, clears on a new speaking round, and isolates reset from stale timers', () => {
    const view = setup();
    view.subtitles.accept(packet());
    const obsolete = view.timers.at(-1).callback;
    view.subtitles.state({ roundId: 'round-b', state: 1 });
    expect(view.text).toBe('第一句话。');
    view.subtitles.state({ roundId: 'round-b', state: 2 });
    expect(view.text).toBe('');
    view.subtitles.accept(packet()); expect(view.text).toBe('');
    view.subtitles.accept(packet('新一轮字幕。', { roundId: 'round-b' }));
    expect(view.text).toBe('新一轮字幕。');
    view.subtitles.clear({ roundId: 'round-a', reason: 'done_timeout' });
    expect(view.text).toBe('新一轮字幕。');
    const beforeReset = view.timers.at(-1).callback;
    view.subtitles.reset();
    view.subtitles.accept(packet('重连后的字幕。'));
    obsolete(); beforeReset();
    expect(view.text).toBe('重连后的字幕。');
    view.subtitles.clear({ roundId: 'round-a', reason: 'done_timeout' });
    expect(view.text).toBe('重连后的字幕。');
    view.subtitles.accept(packet('过期字幕。'));
    expect(view.text).toBe('重连后的字幕。');
    view.advance(8000);
    expect(view.text).toBe('');
  });
});
