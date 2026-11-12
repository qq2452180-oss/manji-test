const words = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const closing = /[”’"'」』）)\]】]/u;
const punctuation = /[，、,：:。！？!?；;.]/u;
const seconds = value => {
  if (typeof value !== 'string' || !/^\d{2,}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return null;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
};

function shortSentences(text) {
  const sentences = [];
  let sentence = '';
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index], next = characters[index + 1];
    sentence += character;
    const boundary = /[。！？!?；;\n]/u.test(character)
      || character === '.' && !( /\d/u.test(characters[index - 1] || '') && /\d/u.test(next || ''));
    if (!boundary) continue;
    while (index + 1 < characters.length && (closing.test(characters[index + 1]) || /[。！？!?；;.]/u.test(characters[index + 1]))) {
      sentence += characters[++index];
    }
    if (sentence.trim()) sentences.push(sentence.trim());
    sentence = '';
  }
  if (sentence.trim()) sentences.push(sentence.trim());
  return sentences.flatMap(value => {
    const parts = [];
    let remaining = Array.from(value);
    while (remaining.length > 26) {
      let boundary = 0;
      for (let index = 12; index <= 26; index++) {
        if (/[，、,：:\s]/u.test(remaining[index - 1])) boundary = index;
      }
      if (!boundary && words) {
        let length = 0;
        for (const { segment } of words.segment(remaining.join(''))) {
          length += Array.from(segment).length;
          if (length > 26) break;
          boundary = length;
        }
      }
      boundary ||= 26;
      while (boundary < remaining.length && (closing.test(remaining[boundary]) || punctuation.test(remaining[boundary]))) boundary++;
      parts.push(remaining.slice(0, boundary).join('').trim());
      remaining = remaining.slice(boundary);
    }
    if (remaining.join('').trim()) parts.push(remaining.join('').trim());
    return parts;
  });
}

export function createCallSubtitles({
  onChange = () => {}, now = () => globalThis.performance?.now?.() ?? Date.now(),
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let cue = null, roundId = '', displayed = '', timer, version = 0;
  const retired = new Set();
  const publish = text => {
    if (text === displayed) return;
    displayed = text;
    onChange(text);
  };
  const stopTimer = () => {
    version++;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const clearCurrent = () => { stopTimer(); cue = null; publish(''); };
  const retire = id => {
    if (!id) return;
    retired.add(id);
    if (id === roundId) { clearCurrent(); roundId = ''; }
  };
  function render() {
    stopTimer();
    if (!cue) return;
    while (cue.index < cue.parts.length && now() >= cue.ends[cue.index]) cue.index++;
    if (cue.index === cue.parts.length) { publish(''); return; }
    publish(cue.parts[cue.index]);
    const revision = version;
    timer = schedule(() => {
      if (revision !== version) return;
      render();
    }, Math.max(1, cue.ends[cue.index] - now()));
  }
  function accept(value) {
    if (!value || typeof value.text !== 'string' || !value.text.trim()
      || typeof value.roundId !== 'string' || !value.roundId || retired.has(value.roundId)) return;
    const start = seconds(value.startTime), end = seconds(value.endTime);
    if (start !== null && end !== null && end < start) return;
    if (roundId && roundId !== value.roundId) retire(roundId);
    roundId = value.roundId;
    const previous = cue;
    if (previous && start !== null && previous.start !== null && start < previous.start) return;
    const revising = previous && start === previous.start;
    if (revising && (end !== null && previous.end !== null && end < previous.end
      || previous.complete && value.complete !== true)) return;
    if (revising && previous.text === value.text && previous.end === end && previous.complete === (value.complete === true)) return;
    let parts = shortSentences(value.text);
    if (revising && previous.index === previous.parts.length && value.text.startsWith(previous.text)) {
      // A partial sentence may finish displaying before more words arrive.
      // Its extension can still have one part; a part count alone loses it.
      parts = [...previous.parts, ...shortSentences(value.text.slice(previous.text.length))];
    }
    const weights = parts.map(part => Array.from(part).length);
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    const duration = start !== null && end !== null ? (end - start) * 1000 : 0;
    // Preserve the current position and unchanged sentence deadlines when a
    // cumulative packet grows. Reweighting its entire history can replay text.
    const index = revising ? Math.min(previous.index, parts.length) : 0;
    let shared = 0;
    if (revising) while (shared < parts.length && parts[shared] === previous.parts[shared]) shared++;
    let from = Math.max(index, shared);
    if (revising && shared === parts.length && duration !== previous.duration) from = index;
    const ends = revising ? previous.ends.slice(0, from) : [];
    // start_time is a provider media offset, not this browser's clock origin.
    const arrivedAt = revising ? previous.arrivedAt : now();
    if (from < parts.length) {
      const beginsAt = Math.max(now(), ends[from - 1] ?? arrivedAt);
      const remainingWeight = weights.slice(from).reduce((total, weight) => total + weight, 0);
      // No internal sentence timings are supplied. Use the packet duration if
      // available, otherwise a finite reading pace instead of freezing part 1.
      // A late append still needs display time even after the old cue expired.
      const fallback = duration > 0 ? duration * remainingWeight / totalWeight
        : weights.slice(from).reduce((total, weight) => total + Math.max(1200, weight * 200), 0);
      const endsAt = duration > 0 && arrivedAt + duration > beginsAt ? arrivedAt + duration : beginsAt + fallback;
      let weight = 0;
      for (let part = from; part < parts.length; part++) {
        weight += weights[part];
        ends[part] = part === parts.length - 1 ? endsAt : beginsAt + (endsAt - beginsAt) * weight / remainingWeight;
      }
    }
    cue = { text: value.text, start, end, complete: value.complete === true, parts, ends,
      duration, arrivedAt, index };
    render();
  }
  function reset() {
    clearCurrent(); roundId = ''; retired.clear();
  }
  return {
    accept,
    clear(event) {
      // The adapter's tail deadline closes intake, not local display of an
      // already accepted paragraph. Interrupt/new-round events still clear it.
      if (event?.roundId && event.reason === 'done_timeout') retired.add(event.roundId);
      else if (event?.roundId) retire(event.roundId);
      else reset();
    },
    state(event) {
      if (!event?.roundId) return;
      if (event.state === 4) { retire(event.roundId); return; }
      if (retired.has(event.roundId)) return;
      if ([2, 3].includes(event.state) && event.roundId !== roundId) {
        retire(roundId); roundId = event.roundId;
      }
    },
    reset,
  };
}
