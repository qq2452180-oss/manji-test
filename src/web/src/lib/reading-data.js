export function chapterTime(chapter) {
  if (chapter.time_text) return chapter.time_text;
  if (chapter.start_year && chapter.end_year) return chapter.start_year === chapter.end_year
    ? `${chapter.start_year}年` : `${chapter.start_year}—${chapter.end_year}年`;
  if (chapter.start_year) return `${chapter.start_year}年起`;
  return chapter.end_year ? `${chapter.end_year}年前` : '';
}

export function storyParagraphs(version) {
  return String(version?.body || '').split(/\n\s*\n|\r?\n/).map(text => text.trim()).filter(Boolean);
}

export function storyPhotos(version) {
  return (Array.isArray(version?.photos) ? version.photos : [])
    .filter(photo => photo && typeof photo.media_id === 'string' && photo.media_id.trim())
    .slice().sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
}

// A hidden page and a changed account must discard pending private responses.
export function createReadingLoader({ kind, id, api, onState, authorize = async () => true }) {
  let generation = 0, visible = true;
  function clear(status = 'loading') { generation += 1; onState({ status }); }
  function current(version, token) {
    if (!visible || version !== generation) return false;
    if (token === api.getAuthToken()) return true;
    clear('guest'); return false;
  }
  async function load() {
    visible = true; clear();
    const version = generation, token = api.getAuthToken();
    if (!token) { onState({ status: 'guest' }); return; }
    try {
      if (!await authorize() || !current(version, token)) return;
      let result;
      if (kind === 'biography') {
        const book = await api.bootstrapBiography();
        if (!current(version, token)) return;
        result = await api.getBiography(book.biography_id);
      } else if (kind === 'chapter') {
        if (!id) throw new Error('请从传记目录重新打开这一章。');
        result = await api.getChapter(id);
        if (!result?.chapter || result.chapter.chapter_id !== id) throw new Error('章节信息不完整，请重新加载。');
      } else {
        if (!id) throw new Error('没有找到要查看的故事，请从传记页重新进入。');
        result = await api.getStory(id);
        if (!result || result.story_id !== id) throw new Error('故事信息不完整，请重新加载。');
      }
      if (current(version, token)) onState({ status: 'ready', result });
    } catch (error) {
      if (current(version, token)) onState({ status: 'error', message: error.message || '暂时无法读取，请稍后重试。' });
    }
  }
  return { load, clear, hide() { visible = false; clear(); } };
}
