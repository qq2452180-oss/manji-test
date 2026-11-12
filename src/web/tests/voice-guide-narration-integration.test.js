import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, onUnmounted, ref, shallowRef } from 'vue';
import VoiceOnboarding from '../src/components/VoiceOnboarding.vue';
import { createOnboardingNarration, NARRATION_TEXT } from '../src/lib/onboarding-narration.js';
import manifest from '../src/assets/onboarding/manifest.json';

let clips, wrappers, playResults;

beforeEach(() => {
  clips = [];
  wrappers = [];
  playResults = [];
  // Only media playback is simulated: preload, player state, subtitle timing,
  // Vue rendering and tutorial controls all use production code.
  vi.stubGlobal('Audio', class {
    constructor(src) {
      this.src = src;
      this.currentTime = 0;
      this.muted = false;
      this.load = vi.fn();
      this.pause = vi.fn();
      this.play = vi.fn(() => playResults.shift() ?? Promise.resolve());
      clips.push(this);
    }
  });
});

afterEach(() => {
  wrappers.forEach(wrapper => wrapper.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openGuide() {
  let speaker, completion;
  const narration = shallowRef({});
  const screen = ref('permission');
  const notifications = [];
  const wrapper = mount(defineComponent({
    setup() {
      speaker = createOnboardingNarration({ onChange(state) {
        narration.value = state;
        notifications.push(state);
      } });
      speaker.prepare('guide');
      onUnmounted(() => speaker.destroy());
      function leaveGuide(destination) {
        speaker.stop();
        screen.value = destination;
      }
      return () => ['permission', 'guide'].includes(screen.value)
        ? h(VoiceOnboarding, {
          stage: screen.value, narration: narration.value,
          onAuthorize: () => {
            speaker.activate('guide');
            screen.value = 'guide';
            completion = speaker.play('guide');
          },
          onStart: () => leaveGuide('小暖正在听您说'),
          onPause: () => speaker.pause(),
          onPlay: () => speaker.play('guide'),
        })
        : h('main', { 'data-testid': 'destination' }, screen.value);
    },
  }));
  wrappers.push(wrapper);
  expect(clips).toHaveLength(1);
  expect(clips[0].load).toHaveBeenCalledOnce();
  expect(clips[0].play).not.toHaveBeenCalled();
  await wrapper.findAll('button').find(button => button.text() === '开启麦克风').trigger('click');
  await flushPromises();
  return { wrapper, completion, notifications };
}

async function advanceAudio(audio, seconds) {
  audio.currentTime = seconds;
  audio.ontimeupdate();
  await flushPromises();
}

describe('spoken guide with its rendered subtitles', () => {
  it('continuously reads the complete tutorial with one preloaded track and all three synchronized captions', async () => {
    const { wrapper, completion } = await openGuide();
    const displayed = [];
    for (const cue of manifest.guide_track.cues) {
      await advanceAudio(clips[0], cue.start_ms / 1000);
      const caption = wrapper.get('.onboarding-caption').text();
      displayed.push(caption);
      expect(caption).toBe(NARRATION_TEXT.guide.slice(0, cue.index + 1).join(''));
      expect(wrapper.get('.onboarding-caption > .is-current').text()).toBe(NARRATION_TEXT.guide[cue.index]);
      expect(clips[0].src).toContain('guide-full.wav');
      expect(wrapper.get('[aria-label="暂停讲解"]').attributes('disabled')).toBeUndefined();
    }
    expect(displayed).toHaveLength(3);
    expect(displayed.join('')).toContain('这个圈会跟着您的声音动');
    expect(displayed.join('')).toContain('右上角的暂停按钮');
    expect(displayed.join('')).toContain('点结束并整理');
    expect(clips).toHaveLength(1);
    expect(clips[0].play).toHaveBeenCalledOnce();
    clips[0].onended();
    await completion;
    await flushPromises();
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide.join(''));
    expect(wrapper.get('[aria-label="暂停讲解"]').attributes('disabled')).toBeDefined();
  });

  it('keeps the first caption while audio is loading and starts speaking only after playback begins', async () => {
    let resolvePlayback;
    playResults.push(new Promise(resolve => { resolvePlayback = resolve; }));
    const { wrapper } = await openGuide();
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide[0]);
    expect(wrapper.get('.onboarding-caption').classes()).not.toContain('is-reading');
    expect(wrapper.get('[aria-label="暂停讲解"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.voice-ring.is-speaking').exists()).toBe(false);
    resolvePlayback();
    await flushPromises();
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide[0]);
    expect(wrapper.get('[aria-label="暂停讲解"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.voice-ring.is-speaking').exists()).toBe(true);
    await advanceAudio(clips[0], manifest.guide_track.cues[1].start_ms / 1000);
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide.slice(0, 2).join(''));
    expect(clips[0].play).toHaveBeenCalledOnce();
  });

  it('does not advance subtitles on wall-clock time when the media clock is stalled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { wrapper } = await openGuide();
    expect(clips[0].currentTime).toBe(0);
    await vi.advanceTimersByTimeAsync(manifest.guide_track.cues[1].start_ms + 500);
    await flushPromises();
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide[0]);
    expect(clips[0].pause).not.toHaveBeenCalled();
    await advanceAudio(clips[0], manifest.guide_track.cues[1].start_ms / 1000);
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide.slice(0, 2).join(''));
  });

  it.each(['start', 'unmount'])('stops the complete tutorial on %s and ignores late media callbacks', async action => {
    const { wrapper, completion, notifications } = await openGuide();
    const audio = clips[0];
    await advanceAudio(audio, manifest.guide_track.cues[1].start_ms / 1000);
    expect(wrapper.get('.onboarding-caption').text()).toBe(NARRATION_TEXT.guide.slice(0, 2).join(''));
    const lateEnded = audio.onended;
    const lateProgress = audio.ontimeupdate;
    const latePlaying = audio.onplaying;
    const lateError = audio.onerror;
    expect(wrapper.text()).not.toContain('先打字聊');
    expect(wrapper.text()).not.toContain('返回聊天方式选择');
    if (action === 'start') {
      await wrapper.findAll('button').find(button => button.text() === '准备好了，咱们开始吧').trigger('click');
      expect(wrapper.get('[data-testid="destination"]').text()).toBe('小暖正在听您说');
    } else {
      wrapper.unmount(); wrappers = wrappers.filter(item => item !== wrapper);
    }
    await completion;
    expect(audio.muted).toBe(true);
    expect(audio.pause).toHaveBeenCalled();
    const count = notifications.length;
    lateEnded();
    lateProgress();
    latePlaying();
    lateError();
    await flushPromises();
    expect(notifications).toHaveLength(count);
    expect(audio.play).toHaveBeenCalledOnce();
    if (action === 'start') {
      expect(wrapper.find('.onboarding-caption').exists()).toBe(false);
      expect(wrapper.text()).toBe('小暖正在听您说');
    }
  });
});
