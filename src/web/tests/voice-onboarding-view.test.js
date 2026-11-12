import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import VoiceOnboarding from '../src/components/VoiceOnboarding.vue';
import VoiceRing from '../src/components/VoiceRing.vue';
import { NARRATION_TEXT } from '../src/lib/onboarding-narration.js';
const onboardingStyles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/voice-onboarding.css'), 'utf8');
const baseStyles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/base.css'), 'utf8');

const button = (wrapper, label) => wrapper.findAll('button').find(node => node.text() === label);

describe('first voice permission and teaching screens', () => {
  it('keeps the complete permission explanation readable and only emits an explicit authorization request', async () => {
    const wrapper = mount(VoiceOnboarding);
    expect(wrapper.get('h1').text()).toBe('让小暖听见您');
    expect(wrapper.text()).toContain('麦克风打开后，我就能听见您了。');
    expect(wrapper.text()).toContain('要是弹出询问，您选“允许”就好。');
    expect(wrapper.find('.onboarding-playback').exists()).toBe(false);
    expect(wrapper.emitted('play')).toBeUndefined();
    expect(wrapper.emitted('authorize')).toBeUndefined();
    await button(wrapper, '开启麦克风').trigger('click');
    expect(wrapper.emitted('authorize')).toHaveLength(1);
  });

  it.each(['permission', 'requesting', 'denied', 'guide'])('keeps the chosen voice path without chat-mode controls (%s)', stage => {
    const wrapper = mount(VoiceOnboarding, { props: { stage } });
    expect(wrapper.text()).not.toContain('先打字聊');
    expect(wrapper.text()).not.toContain('返回聊天方式选择');
    expect(wrapper.text()).not.toContain('改用文字');
    expect(wrapper.find('.onboarding-secondary').exists()).toBe(false);
    expect(wrapper.find('.onboarding-exit').exists()).toBe(false);
  });

  it('waits for the browser permission request without allowing duplicate authorization', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'requesting', busy: true } });
    expect(wrapper.get('[role="status"]').text()).toBe('请在浏览器的询问中选择允许');
    expect(button(wrapper, '正在等待允许…').attributes('disabled')).toBeDefined();
    await button(wrapper, '正在等待允许…').trigger('click');
    expect(wrapper.emitted('authorize')).toBeUndefined();
    expect(wrapper.emitted('text')).toBeUndefined();
    expect(wrapper.emitted('leave')).toBeUndefined();
  });

  it('shows the specific microphone failure and recoverable settings guidance without promising a system settings jump', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'denied', error: '麦克风正被其他应用使用。', hasPreview: true } });
    expect(wrapper.get('[role="alert"]').text()).toBe('麦克风正被其他应用使用。');
    expect(wrapper.get('summary').text()).toBe('如何开启麦克风');
    expect(wrapper.get('details').text()).toContain('不同浏览器的位置可能不同');
    expect(button(wrapper, '去设置里打开')).toBeUndefined();
    await button(wrapper, '已开启，重试').trigger('click');
    await button(wrapper, '查看已有故事').trigger('click');
    expect(wrapper.emitted('authorize')).toHaveLength(1);
    expect(wrapper.emitted('text')).toBeUndefined();
    expect(wrapper.emitted('preview')).toHaveLength(1);
  });

  it('reveals complete paragraphs with audio progress while retaining earlier paragraphs and immediate start', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', level: .6, narration: { text: NARRATION_TEXT.guide[0], index: 0, playing: true } } });
    expect(wrapper.get('h1').text()).toBe('小暖带您开始聊天');
    expect(wrapper.get('h1').classes()).toContain('sr-only');
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 1));
    expect(wrapper.get('.onboarding-caption').attributes('aria-live')).toBe('polite');
    expect(wrapper.get('.onboarding-caption').attributes('aria-atomic')).toBe('false');
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.getComponent(VoiceRing).props('level')).toBe(.6);
    expect(wrapper.getComponent(VoiceRing).props('state')).toBe('speaking');
    expect(button(wrapper, '准备好了，咱们开始吧').attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ narration: { index: 1, text: NARRATION_TEXT.guide[1], playing: true } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 2));
    expect(wrapper.get('.onboarding-caption .is-read').text()).toBe(NARRATION_TEXT.guide[0]);
    expect(wrapper.get('.onboarding-caption .is-current').text()).toBe(NARRATION_TEXT.guide[1]);
    await wrapper.setProps({ narration: { index: 2, playing: true } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide);
    await wrapper.get('[aria-label="暂停讲解"]').trigger('click');
    expect(wrapper.find('.onboarding-playback').exists()).toBe(false);
    await button(wrapper, '准备好了，咱们开始吧').trigger('click');
    expect(wrapper.emitted('pause')).toHaveLength(1);
    expect(wrapper.emitted('play')).toBeUndefined();
    expect(wrapper.emitted('start')).toHaveLength(1);
    await wrapper.setProps({ narration: { index: 2, playing: false, ended: true } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide);
    expect(wrapper.getComponent(VoiceRing).props('state')).toBe('listening');
  });

  it.each([
    { blocked: true },
    { error: '讲解暂时没有播放出来。' },
    { loading: true },
  ])('keeps tutorial captions and immediate start without playback status or retry controls (%j)', async narration => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', narration } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 1));
    expect(wrapper.text()).not.toContain('声音暂时没有播放');
    expect(wrapper.text()).not.toContain('小暖的声音正在准备中');
    expect(wrapper.text()).not.toContain('讲解暂时没有播放出来');
    expect(button(wrapper, '播放讲解')).toBeUndefined();
    expect(wrapper.find('.onboarding-playback').exists()).toBe(false);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(button(wrapper, '准备好了，咱们开始吧').attributes('disabled')).toBeUndefined();
    await button(wrapper, '准备好了，咱们开始吧').trigger('click');
    expect(wrapper.emitted('play')).toBeUndefined();
    expect(wrapper.emitted('start')).toHaveLength(1);
  });

  it('keeps only the reached paragraphs while buffering without pretending to speak', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', narration: {
      index: 1, text: NARRATION_TEXT.guide[1], playing: false, loading: true,
    } } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 2));
    expect(wrapper.text()).not.toContain('小暖的声音正在准备中');
    expect(wrapper.getComponent(VoiceRing).props('state')).toBe('idle');
    expect(wrapper.get('[aria-label="暂停讲解"]').attributes('disabled')).toBeDefined();
    await button(wrapper, '准备好了，咱们开始吧').trigger('click');
    expect(wrapper.emitted('start')).toHaveLength(1);
  });

  it('preserves paragraph progress on pause and resumes with the same top control', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', narration: {
      index: 1, text: NARRATION_TEXT.guide[1], playing: false, paused: true,
    } } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 2));
    expect(wrapper.getComponent(VoiceRing).props('state')).toBe('listening');
    expect(wrapper.find('.onboarding-playback').exists()).toBe(false);
    await wrapper.get('[aria-label="继续讲解"]').trigger('click');
    expect(wrapper.emitted('play')).toHaveLength(1);
    expect(wrapper.emitted('pause')).toBeUndefined();
    await wrapper.setProps({ narration: { index: 1, playing: false, loading: false, paused: false } });
    expect(wrapper.find('[aria-label="继续讲解"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="暂停讲解"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('.onboarding-caption > p')).toHaveLength(2);
  });

  it('retains reached paragraphs on a playback error without revealing later content or adding retry controls', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', narration: {
      index: 1, playing: false, error: '讲解暂时没有播放出来。',
    } } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 2));
    expect(button(wrapper, '播放讲解')).toBeUndefined();
    expect(wrapper.emitted('play')).toBeUndefined();
    await wrapper.setProps({ narration: { index: 0, loading: true, playing: false } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 1));
  });

  it('shows the opening paragraph before playback and can follow a current text before its index arrives', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide' } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 1));
    await wrapper.setProps({ narration: { text: NARRATION_TEXT.guide[1], playing: true } });
    expect(wrapper.findAll('.onboarding-caption > p').map(line => line.text())).toEqual(NARRATION_TEXT.guide.slice(0, 2));
  });

  it('blocks another start after the parent enters the connecting state without hiding an error', async () => {
    const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', busy: true, error: '暂时连接不上，请稍后重试。' } });
    expect(wrapper.get('[role="alert"]').text()).toContain('暂时连接不上');
    expect(button(wrapper, '正在准备…').attributes('disabled')).toBeDefined();
    await button(wrapper, '正在准备…').trigger('click');
    expect(wrapper.emitted('start')).toBeUndefined();
  });

  it('keeps large action targets and natural content height for narrow screens and enlarged text', () => {
    const style = document.createElement('style');
    style.textContent = onboardingStyles;
    document.head.append(style);
    try {
      const wrapper = mount(VoiceOnboarding, { props: { stage: 'guide', hasPreview: true }, attachTo: document.body });
      expect(getComputedStyle(wrapper.get('.onboarding-primary').element).minHeight).toBe('60px');
      expect(getComputedStyle(wrapper.get('.onboarding-exit').element).minHeight).toBe('44px');
      expect(['', 'auto']).toContain(getComputedStyle(wrapper.get('.onboarding-caption').element).height);
      expect(['', 'none']).toContain(getComputedStyle(wrapper.get('.onboarding-caption').element).maxHeight);
      expect(getComputedStyle(wrapper.get('.onboarding-caption').element).fontWeight).toBe('400');
      expect(getComputedStyle(wrapper.get('.onboarding-caption').element).textAlign).toBe('left');
    } finally { style.remove(); }
  });

  it('preserves the large primary action when the global button stylesheet loads afterward', () => {
    const style = document.createElement('style');
    style.textContent = onboardingStyles + '\n' + baseStyles;
    document.head.append(style);
    try {
      const wrapper = mount(VoiceOnboarding, { attachTo: document.body });
      const primary = getComputedStyle(wrapper.get('.onboarding-primary').element);
      expect(primary.minHeight).toBe('60px');
      expect(primary.padding).toBe('14px 20px');
      expect(primary.backgroundColor).toBe('rgb(203, 105, 74)');
    } finally { style.remove(); }
  });
});

describe('microphone volume ring', () => {
  it('clamps changing audio levels without creating a live accessibility announcement', async () => {
    const wrapper = mount(VoiceRing, { props: { state: 'listening', level: .7 } });
    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.attributes('aria-live')).toBeUndefined();
    expect(wrapper.element.style.getPropertyValue('--voice-level')).toBe('0.7');
    await wrapper.setProps({ level: .02 });
    expect(Number(wrapper.element.style.getPropertyValue('--voice-activity'))).toBeGreaterThan(.3);
    await wrapper.setProps({ level: 2 });
    expect(wrapper.element.style.getPropertyValue('--voice-level')).toBe('1');
    await wrapper.setProps({ level: -1 });
    expect(wrapper.element.style.getPropertyValue('--voice-level')).toBe('0');
    await wrapper.setProps({ level: Number.NaN });
    expect(wrapper.element.style.getPropertyValue('--voice-level')).toBe('0');
    await wrapper.setProps({ state: 'paused' });
    expect(wrapper.classes()).toContain('is-paused');
  });
});
