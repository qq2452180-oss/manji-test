import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getAuthToken, setAuthToken } from '../src/lib/api.js';
import * as api from '../src/lib/workflow-api.js';
import * as navigation from '../src/lib/workflow-navigation.js';

const guestToken = 'g'.repeat(43);
const memberToken = 'm'.repeat(43);
const member = { user_id: 23, is_guest: false };
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' }, json: async () => body,
});
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  setAuthToken('');
  history.replaceState(null, '', '/web/index.html');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('workflow identity', () => {
  it('requires a login without creating an anonymous identity', async () => {
    await expect(api.ensureIdentity()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await expect(api.startInterview(101)).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await expect(api.startInterview(undefined, { resumeMode: 'voice' })).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(getAuthToken()).toBe('');
  });

  it('verifies one member for concurrent callers and reuses the verified identity', async () => {
    setAuthToken(memberToken);
    const pending = deferred();
    fetch.mockReturnValue(pending.promise);
    const first = api.ensureIdentity();
    const second = api.ensureIdentity();
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/me');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${memberToken}`);
    pending.resolve(response(member));
    await expect(first).resolves.toEqual({ user_id: '23', is_guest: false });
    expect(getAuthToken()).toBe(memberToken);
    await expect(api.ensureIdentity()).resolves.toEqual({ user_id: '23', is_guest: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('blocks an existing guest without clearing its credential or drafts', async () => {
    setAuthToken(guestToken);
    const draft = JSON.stringify({ owner: guestToken, text: '待绑定的回忆' });
    sessionStorage.setItem('manji.connected.draft.41', draft);
    fetch.mockResolvedValue(response({ user_id: 17, is_guest: true }));
    await expect(api.ensureIdentity()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await expect(api.startInterview(101)).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me', '/api/auth/me']);
    expect(getAuthToken()).toBe(guestToken);
    expect(sessionStorage.getItem('manji.connected.draft.41')).toBe(draft);
  });

  it.each([{}, { user_id: 23 }, { user_id: 23, is_guest: 'false' }])('does not accept an unconfirmed member response %j', async payload => {
    setAuthToken(memberToken); fetch.mockResolvedValue(response(payload));
    await expect(api.ensureIdentity()).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' });
    expect(getAuthToken()).toBe(memberToken);
  });

  it('restores an existing identity using the current auth/me shape', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValue(response({ user_id: 23, is_guest: false }));
    await expect(api.ensureIdentity()).resolves.toEqual({ user_id: '23', is_guest: false });
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${memberToken}` }),
    }));
    expect(getAuthToken()).toBe(memberToken);
  });

  it('keeps expired identity and reports 401 without creating a guest or navigating', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValue(response({ detail: '请重新登录' }, 401));
    await expect(api.ensureIdentity()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await expect(api.getInterview(11)).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(getAuthToken()).toBe(memberToken);
    expect(location.pathname).toBe('/web/index.html');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me', '/api/interviews/11']);
  });

  it('does not create a different owner while reading an existing session without a token', async () => {
    await expect(api.getInterview(11)).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discards a late old-guest verification when another account becomes active', async () => {
    setAuthToken(guestToken);
    const pending = deferred();
    fetch.mockReturnValue(pending.promise);
    const creating = api.ensureIdentity();
    setAuthToken(memberToken);
    pending.resolve(response({ user_id: 17, is_guest: true }));
    await expect(creating).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(getAuthToken()).toBe(memberToken);
    fetch.mockResolvedValue(response({ user_id: 23, is_guest: false }));
    await expect(api.ensureIdentity()).resolves.toEqual({ user_id: '23', is_guest: false });
  });

  it('single-flights identity verification and rejects a switch away and back', async () => {
    setAuthToken(memberToken);
    const pending = deferred();
    fetch.mockReturnValue(pending.promise);
    const first = api.ensureIdentity();
    expect(api.ensureIdentity()).toBe(first);
    setAuthToken(guestToken);
    setAuthToken(memberToken);
    pending.resolve(response({ user_id: 23, is_guest: false }));
    await expect(first).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
  });

  it('keeps a newer member verification in flight when an older guest verification finishes', async () => {
    setAuthToken(guestToken);
    const oldGuest = deferred();
    const newMember = deferred();
    fetch.mockReturnValueOnce(oldGuest.promise).mockReturnValueOnce(newMember.promise);
    const oldRequest = api.ensureIdentity();
    setAuthToken(memberToken);
    const currentRequest = api.ensureIdentity();
    oldGuest.resolve(response({ user_id: 17, is_guest: true }));
    await expect(oldRequest).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(api.ensureIdentity()).toBe(currentRequest);
    newMember.resolve(response({ user_id: 23, is_guest: false }));
    await expect(currentRequest).resolves.toEqual({ user_id: '23', is_guest: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('workflow requests', () => {
  it('reads the public catalog and normalizes resource identifiers', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValue(response({ chapters: [{
      id: 8, title: '早年', topics: [{ id: 101, chapter_id: 8, title: '老家', description: '回忆住过的地方。' }],
    }] }));
    const catalog = await api.getCatalog();
    expect(fetch.mock.calls[0][0]).toBe('/api/catalog');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(catalog.chapters[0].id).toBe('8');
    expect(catalog.chapters[0].topics[0]).toMatchObject({ id: '101', chapter_id: '8' });
  });

  it('lets the public catalog finish while a new identity is established', async () => {
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const catalog = api.getCatalog();
    setAuthToken(guestToken);
    pending.resolve(response({ chapters: [] }));
    await expect(catalog).resolves.toEqual({ chapters: [] });
  });

  it.each([['00101', 101], [101, 101]])('starts text interview with topic %s', async (input, topic) => {
    setAuthToken(memberToken);
    fetch.mockResolvedValueOnce(response(member));
    fetch.mockResolvedValueOnce(response({ session_id: '41', status: 'awaiting_first_input', opening_text: '您想讲些什么？' }, 201));
    await expect(api.startInterview(input)).resolves.toMatchObject({ session_id: '41' });
    expect(fetch.mock.calls[1][0]).toBe('/api/interviews');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${memberToken}`);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ resume_mode: 'text', topic_id: topic });
  });

  it.each(['text', 'voice'])('starts a global %s interview without a topic', async resumeMode => {
    setAuthToken(memberToken);
    fetch.mockResolvedValueOnce(response(member));
    fetch.mockResolvedValueOnce(response({ session_id: '41', interview_scope: 'global', status: 'awaiting_first_input' }, 201));
    await expect(api.startInterview(undefined, { resumeMode })).resolves.toMatchObject({ session_id: '41', interview_scope: 'global' });
    expect(fetch.mock.calls[1][0]).toBe('/api/interviews');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${memberToken}`);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ resume_mode: resumeMode });
  });

  it('does not submit a new interview under a different account after identity verification', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValue(response(member));
    await api.ensureIdentity();
    const starting = api.startInterview(101);
    setAuthToken(guestToken);
    await expect(starting).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('starts a supplement bound to the original story and normalizes its target ID', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValueOnce(response({ user_id: 23, is_guest: false }));
    fetch.mockResolvedValueOnce(response({ session_id: 42, target_story_id: 73 }, 201));
    await expect(api.startInterview(101, { targetStoryId: '0073' }))
      .resolves.toEqual({ session_id: '42', target_story_id: '73' });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ resume_mode: 'text', topic_id: 101, target_story_id: 73 });
  });

  it('does not create a guest for supplementation and rejects an invalid target before requests', async () => {
    await expect(api.startInterview(101, { targetStoryId: 73 })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(api.startInterview(101, { targetStoryId: -1 })).rejects.toMatchObject({ code: 'INVALID_ID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rebases a supplement only when explicitly requested', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValue(response({ session_id: 42, story_id: 73 }));
    await api.finishInterview(42);
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    await api.finishInterview(42, { rebase: true });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ rebase: true });
  });

  it('uses the current interview and reading routes with exact text input', async () => {
    setAuthToken(guestToken);
    fetch.mockResolvedValue(response({ session_id: 41, story_id: 73, chapter_id: 8 }));
    const requests = [
      [() => api.getInterview('0041'), '/api/interviews/41', 'GET'],
      [() => api.submitText(41, ' 原话\n下一段 '), '/api/interviews/41/input', 'POST'],
      [() => api.retryInterview(41), '/api/interviews/41/retry', 'POST'],
      [() => api.finishInterview(41), '/api/interviews/41/finish', 'POST'],
      [() => api.getStory(73), '/api/stories/73', 'GET'],
      [() => api.getHome(), '/api/home', 'GET'],
      [() => api.getBiography(), '/api/biography', 'GET'],
      [() => api.getChapter(8), '/api/chapters/8', 'GET'],
    ];
    for (const [action, path, method] of requests) {
      await expect(action()).resolves.toEqual({ session_id: '41', story_id: '73', chapter_id: '8' });
      expect(fetch).toHaveBeenLastCalledWith(path, expect.objectContaining({ method, cache: 'no-store' }));
    }
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ text: ' 原话\n下一段 ' });
    expect(fetch.mock.calls.every(([url]) => !url.includes('/web2/') && !url.includes('/api/interview/'))).toBe(true);
  });

  it('keeps the top-level recovery session ID and complete error body', async () => {
    setAuthToken(memberToken);
    const body = { detail: '首问生成失败，请重试', session_id: 41, diagnostic: 'retry' };
    fetch.mockResolvedValueOnce(response(member));
    fetch.mockResolvedValueOnce(response(body, 502));
    const error = await api.startInterview(101).catch(value => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, sessionId: '41', body, details: body });
  });

  it.each([200, 401])('discards delayed status %i after an identity change while reading JSON', async status => {
    setAuthToken(guestToken);
    const pending = deferred();
    fetch.mockResolvedValue({ ...response({}, status), json: () => pending.promise });
    const reading = api.getInterview(41);
    await Promise.resolve();
    setAuthToken(memberToken);
    pending.resolve({ session_id: 41 });
    await expect(reading).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(getAuthToken()).toBe(memberToken);
  });

  it('gives finishing a five-minute timeout and reports aborts', async () => {
    vi.useFakeTimers();
    setAuthToken(guestToken);
    fetch.mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const finishing = api.finishInterview(41);
    const failure = expect(finishing).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(299999);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
  });

  it.each([undefined, null, 0, -1, 1.5, true, '', '1e2', '1/next', Number.MAX_SAFE_INTEGER + 1])('rejects invalid identifier %s before requests', async id => {
    if (id != null) await expect(api.startInterview(id)).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(api.getStory(id)).rejects.toMatchObject({ code: 'INVALID_ID' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('workflow voice calls', () => {
  const callId = 'a1b2c3d4'.repeat(4);
  const call = { call_id: callId, session_id: 41, status: 'PREPARED' };

  it('creates a voice interview and saves an existing interview mode', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValueOnce(response(member));
    fetch.mockResolvedValueOnce(response({ session_id: 41 }, 201));
    await api.startInterview(101, { resumeMode: 'voice' });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ resume_mode: 'voice', topic_id: 101 });
    fetch.mockResolvedValue(response({ session_id: 41, resume_mode: 'text' }));
    await expect(api.updateInterviewMode(41, 'text')).resolves.toEqual({ session_id: '41', resume_mode: 'text' });
    expect(fetch).toHaveBeenLastCalledWith('/api/interviews/41/mode', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ resume_mode: 'text' }),
    }));
  });

  it('prepares with the exact resume contract and preserves opaque RTC credentials', async () => {
    setAuthToken(guestToken);
    const credentials = { user_id: 'u_opaque_rtc_user', room_id: 123, sdk_app_id: 456, user_sig: 'rtc-signature' };
    fetch.mockResolvedValue(response({ ...call, credentials }, 201));
    await expect(api.prepareVoiceCall('0041', 'request-1', {
      resume_kind: 'pause_replay', resume_message_id: '3', ignored: 'not forwarded',
    })).resolves.toEqual({ ...call, session_id: '41', credentials });
    expect(fetch).toHaveBeenLastCalledWith('/api/interviews/41/calls', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${guestToken}` }),
      body: JSON.stringify({ client_request_id: 'request-1', resume_kind: 'pause_replay', resume_message_id: '3' }),
    }));
    await api.prepareVoiceCall(41, 'request-2', { resume_kind: 'home_return', resume_request_id: 'return-1' });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      client_request_id: 'request-2', resume_kind: 'home_return', resume_request_id: 'return-1',
    });
  });

  it('uses current start, query, and stop routes without a legacy reason body', async () => {
    setAuthToken(guestToken);
    fetch.mockResolvedValue(response(call));
    for (const [action, suffix, method] of [
      [api.startVoiceCall, '/start', 'POST'], [api.getVoiceCall, '', 'GET'], [api.stopVoiceCall, '/stop', 'POST'],
    ]) {
      await expect(action(callId)).resolves.toMatchObject({ call_id: callId, session_id: '41' });
      expect(fetch).toHaveBeenLastCalledWith(`/api/rtc/calls/${callId}${suffix}`, expect.objectContaining({ method }));
      expect(fetch.mock.calls.at(-1)[1].body).toBeUndefined();
    }
    await expect(api.getVoiceCall('41')).rejects.toMatchObject({ code: 'INVALID_CALL_ID' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps unload cleanup bound to the original owner after an account change', async () => {
    setAuthToken(memberToken);
    fetch.mockResolvedValue(response(call));
    api.stopVoiceCallOnUnload(callId, guestToken);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/rtc/calls/${callId}/stop`, {
      method: 'POST', keepalive: true, cache: 'no-store', headers: { Authorization: `Bearer ${guestToken}` },
    });
    api.stopVoiceCallOnUnload(callId, '');
    api.stopVoiceCallOnUnload('../other', guestToken);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects a delayed call response after switching accounts', async () => {
    setAuthToken(guestToken);
    const pending = deferred();
    fetch.mockReturnValue(pending.promise);
    const preparing = api.prepareVoiceCall(41, 'request-1');
    setAuthToken(memberToken);
    pending.resolve(response(call));
    await expect(preparing).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
  });
});

describe('workflow navigation', () => {
  it('builds current relative routes from numeric identifiers without a local catalog', () => {
    expect(navigation.homeUrl()).toBe('./index.html');
    expect(navigation.homeUrl('008')).toBe('./index.html?chapter_id=8');
    expect(navigation.interviewUrl()).toBe('./interview.html');
    expect(navigation.interviewUrl({ topicId: 101, chapterId: 8, sessionId: 41 }))
      .toBe('./interview.html?topic_id=101&chapter_id=8&session_id=41');
    expect(navigation.organizingUrl(41)).toBe('./organizing.html?session_id=41');
    expect(navigation.interviewUrl({ topicId: 101, chapterId: 8, sessionId: 42, storyId: 73 }))
      .toBe('./interview.html?topic_id=101&chapter_id=8&session_id=42&story_id=73');
    expect(navigation.organizingUrl(42, { storyId: 73 })).toBe('./organizing.html?session_id=42&story_id=73');
    expect(navigation.storyUrl(73, { sessionId: 41 })).toBe('./story.html?story_id=73&session_id=41');
    expect(navigation.biographyUrl()).toBe('./biography.html');
    expect(navigation.chapterUrl(8)).toBe('./chapter.html?chapter_id=8');
    expect(navigation.historyUrl(41)).toBe('./history.html?session_id=41');
    expect(navigation.historyUrl()).toBe('./history.html');
    expect(() => navigation.interviewUrl({ topicId: 'MJ2-L1-01' })).toThrow(ApiError);
    expect(() => navigation.storyUrl('1&session_id=2')).toThrow(ApiError);
  });
});
