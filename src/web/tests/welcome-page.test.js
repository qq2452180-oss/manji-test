import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import WelcomePage from '../src/pages/WelcomePage.vue';
import * as api from '../src/lib/api.js';
import { navigate } from '../src/lib/navigation.js';
import { finishFirstVisit } from '../src/lib/first-visit.js';

const identity = vi.hoisted(() => ({ token: '' }));
vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(() => identity.token), getCurrentUser: vi.fn(), startGuest: vi.fn(), getGuestTrial: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

beforeEach(() => {
  identity.token = '';
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  api.getCurrentUser.mockReset().mockResolvedValue({ id: 'guest-a', is_guest: true });
  api.startGuest.mockReset();
  api.getGuestTrial.mockReset();
});

describe('welcome page', () => {
  it('introduces Xiaonuan with one Start link without creating an identity or requesting media', async () => {
    const microphone = vi.fn(); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
    const wrapper = mount(WelcomePage); await flushPromises();
    expect(wrapper.get('h1').text()).toBe('你好，我是小暖。');
    expect(wrapper.get('.intro-primary').attributes('href')).toBe('./login.html?next=%2Fweb2%2Findex.html');
    expect(wrapper.findAll('a, button')).toHaveLength(1);
    expect(wrapper.get('.intro-primary').text()).toBe('开始');
    expect(wrapper.text()).toContain('我是一个用聊天的方式，帮您记录人生故事的语音伙伴。');
    expect(wrapper.text()).toContain('您讲，我听；讲过的话，我会帮您整理成一本书。');
    expect(wrapper.find('audio, video').exists()).toBe(false);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(api.startGuest).not.toHaveBeenCalled(); expect(microphone).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: 'member-a', is_guest: false }, './index.html'],
    [{ id: 'guest-a', is_guest: true }, './login.html?trial=1&next=%2Fweb2%2Findex.html'],
  ])('skips the welcome screen for a verified returning identity %j', async (user, destination) => {
    identity.token = 'returning-token'; api.getCurrentUser.mockResolvedValue(user);
    const wrapper = mount(WelcomePage); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(destination, { replace: true });
    expect(wrapper.find('#welcome-title').exists()).toBe(false);
    expect(api.startGuest).not.toHaveBeenCalled(); expect(api.getGuestTrial).not.toHaveBeenCalled();
  });

  it('sends a previous visitor without credentials to login instead of repeating welcome', async () => {
    finishFirstVisit();
    const wrapper = mount(WelcomePage); await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./login.html?next=%2Fweb2%2Findex.html', { replace: true });
    expect(wrapper.find('#welcome-title').exists()).toBe(false); expect(api.startGuest).not.toHaveBeenCalled();
  });

  it('sends an expired credential from welcome to login without creating a fresh guest', async () => {
    identity.token = 'expired'; api.getCurrentUser.mockImplementation(async () => {
      window.sessionStorage.clear(); identity.token = ''; window.dispatchEvent(new Event('manji:auth-changed')); throw { status: 401 };
    });
    mount(WelcomePage); await flushPromises();
    expect(api.startGuest).not.toHaveBeenCalled(); expect(api.getGuestTrial).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('./login.html?next=%2Fweb2%2Findex.html', { replace: true });
  });
});
