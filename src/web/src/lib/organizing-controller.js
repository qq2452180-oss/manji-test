export function createOrganizingController({ sessionId, api, state, onChange, authorize = async () => true,
  schedule = (fn, delay) => setTimeout(fn, delay), cancel = timer => clearTimeout(timer) }) {
  let visible = true, alive = true, generation = 0, timer = null;
  let materialRevision = -1, pollDelay = 2500;
  let view = { phase: 'loading', title: '', storyId: '', message: '', busy: false, retryAllowed: true, materialIssue: false };
  const update = patch => { view = { ...view, ...patch }; onChange({ ...view }); };
  const transient = error => !error?.status || [408, 429].includes(error.status) || error.status >= 500;
  function clearPoll() { if (timer !== null) cancel(timer); timer = null; }
  function clear() {
    generation += 1; clearPoll(); pollDelay = 2500;
    update({ phase: 'loading', title: '', storyId: '', message: '', busy: false, retryAllowed: true, materialIssue: false });
  }
  function current(version, token) {
    if (!alive || !visible || generation !== version) return false;
    if (token === api.getAuthToken()) return true;
    clear(); update({ phase: 'error', message: '登录状态已改变，请重新连接后查看整理进度。' }); return false;
  }
  function showJob(job) {
    const revision = Number(job?.material_revision);
    if (Number.isSafeInteger(revision) && revision < materialRevision) {
      if (view.phase === 'working' && alive && visible) timer = schedule(() => refresh(), pollDelay);
      return;
    }
    if (Number.isSafeInteger(revision)) materialRevision = revision;
    clearPoll();
    const materialIssue = ['MATERIAL_WAITING', 'MATERIAL_CONFLICT', 'MATERIAL_DELAYED'].includes(job?.phase)
      || ['MATERIAL_WAITING', 'MATERIAL_CONFLICT', 'MATERIAL_DELAYED'].includes(job?.error_code);
    const materialDelayed = job?.phase === 'MATERIAL_DELAYED' || job?.error_code === 'MATERIAL_DELAYED';
    pollDelay = materialDelayed ? 30000 : 2500;
    const revising = job?.phase === 'REVISING';
    update({ title: '', storyId: '', materialIssue, retryAllowed: !materialIssue && job?.retry_allowed !== false });
    // A previous story may still be SUCCEEDED while newer material is checked
    // or incorporated. Its link must not masquerade as the new result.
    if (materialIssue || revising) {
      state.setOrganizationSessionId(sessionId);
      update({ phase: 'working', message: job.error_message || (revising ? '新的讲述已保存，正在更新这篇故事。'
        : materialDelayed ? '通话已结束，整理暂未完成，已有记录已保留，系统会自动继续处理。'
          : '最后一段讲述还在核对，已有记录已保留，核对完成后会自动整理。') });
      if (alive && visible) timer = schedule(() => refresh(), pollDelay);
      return;
    }
    const noMaterial = job?.error_code === 'NO_MATERIAL' || job?.phase === 'NO_MATERIAL' || job?.status === 'NO_MATERIAL';
    update({ title: '', storyId: '', retryAllowed: !noMaterial && job?.retry_allowed !== false });
    if (noMaterial) {
      state.clearOrganizationSessionId(); state.removeActiveSessionId(sessionId);
      update({ phase: 'empty', message: job.error_message || '这次还没有可整理的讲述。下次再接着聊。' }); return;
    }
    if (job?.status === 'SUCCEEDED' && job.story_id) {
      state.setOrganizationSessionId(sessionId); state.removeActiveSessionId(sessionId);
      update({ phase: 'done', title: job.title || '这段故事整理好了', storyId: job.story_id,
        message: job.error_message || (job.error_code === 'STORY_REVISION_AVAILABLE' ? '补充后的故事版本已整理，您修改过的内容已保留。' : '') }); return;
    }
    if (job?.status === 'FAILED') {
      state.setOrganizationSessionId(sessionId);
      update({ phase: 'failed', message: job.error_message || '讲述已经保存，您可以重新整理。' }); return;
    }
    if (['PENDING', 'RUNNING', 'FINISHING'].includes(job?.status)) {
      state.setOrganizationSessionId(sessionId);
      update({ phase: 'working', message: job.phase === 'FINISHING' || job.status === 'FINISHING'
        ? '正在确认最后的文字，随后会整理故事。' : '小暖正在把讲述整理成故事。' });
      if (alive && visible) timer = schedule(() => refresh(), 2500);
      return;
    }
    update({ phase: 'error', message: '整理状态暂时不明，请稍后重试。' });
  }
  async function run(retrying) {
    if (!alive || !visible || view.busy || retrying && !view.retryAllowed) return;
    if (!sessionId) { update({ phase: 'error', message: '没有找到这次讲述，请从首页重新进入。' }); return; }
    const version = ++generation, token = api.getAuthToken(); clearPoll();
    update({ busy: true, ...(retrying ? { phase: 'working', message: '正在重新整理…' } : {}) });
    try {
      if (!await authorize() || !current(version, token)) return;
      const job = await (retrying ? api.retryOrganization(sessionId) : api.getOrganization(sessionId));
      if (current(version, token)) showJob(job);
    } catch (error) {
      if (!current(version, token)) return;
      if (transient(error)) {
        update({ phase: 'working', title: '', storyId: '', retryAllowed: false,
          message: '暂时无法读取整理进度，系统会自动继续查询，已有记录已保留。' });
        timer = schedule(() => refresh(), 30000);
        return;
      }
      if (error.status === 404) state.clearOrganizationSessionId();
      update({ phase: retrying ? 'failed' : 'error', title: '', storyId: '', message: error.message || '暂时没能查看整理进度，请重试。' });
    } finally { if (current(version, token)) update({ busy: false }); }
  }
  function refresh() { return run(false); }
  return { refresh, retry: () => run(true), snapshot: () => ({ ...view }),
    setVisible(value) { visible = value; if (!value) clear(); else return refresh(); },
    destroy() { alive = false; visible = false; clear(); } };
}
