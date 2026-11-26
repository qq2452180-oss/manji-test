import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import HomeTestPage from '../src/pages/HomeTestPage.vue';

const storageKey = 'manji.home-test.selection.v1';
let network;
const originalUrl = window.location.href;
beforeEach(() => {
  window.history.replaceState({}, '', '/web/home-test.html');
  sessionStorage.clear();
  network = vi.fn(() => { throw new Error('The standalone preview must not call APIs'); });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', originalUrl);
  localStorage.clear();
});

describe('standalone home preview', () => {
  it('uses the real form and persists a fixed selection without login or API requests', async () => {
    let wrapper = mount(HomeTestPage);
    expect(wrapper.get('h1').text()).toBe('主人公资料');
    expect(wrapper.get('[type="submit"]').element.disabled).toBe(true);
    await wrapper.get('input[value="70"]').setValue();
    await wrapper.get('select[name="occupation"]').setValue('教师');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.get('.decade-current').text()).toContain('70 后 · 教师');
    expect(wrapper.find('.decade-current button').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('想起哪段，就从哪段讲，不必按顺序。');
    const next = wrapper.findAll('[role="tab"]')[1];
    await next.trigger('click'); await flushPromises();
    const selected = next.attributes('data-testid');
    wrapper.unmount();
    wrapper = mount(HomeTestPage); await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-testid')).toBe(selected);
    expect(network).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('previews topics and keeps navigation local, while reset only clears this test selection', async () => {
    sessionStorage.setItem('manji.connected.draft.preview-check', 'keep');
    sessionStorage.setItem(storageKey, JSON.stringify({ birthDecade: 60, occupation: null }));
    const wrapper = mount(HomeTestPage); await flushPromises();
    const dialog = wrapper.get('dialog').element;
    dialog.showModal = vi.fn(() => { dialog.open = true; });
    dialog.close = vi.fn(() => { dialog.open = false; });
    const topic = wrapper.findAll('.chapter-topic-row')[0];
    const title = topic.get('.chapter-topic-row-title').text();
    await topic.trigger('click'); await flushPromises();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(wrapper.get('#home-test-dialog-title').text()).toBe(title);
    await wrapper.get('dialog button').trigger('click');
    await wrapper.findAll('.prototype-nav button').find(button => button.text() === '家人').trigger('click'); await flushPromises();
    expect(wrapper.find('.prototype-nav a').exists()).toBe(false);
    expect(wrapper.get('#home-test-dialog-title').text()).toBe('家人');
    await wrapper.get('.home-test-toolbar button').trigger('click'); await flushPromises();
    expect(wrapper.get('h1').text()).toBe('主人公资料');
    expect(wrapper.find('input:checked').exists()).toBe(false);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(sessionStorage.getItem('manji.connected.draft.preview-check')).toBe('keep');
    expect(network).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('starts with an empty form when stored test data is invalid', () => {
    sessionStorage.setItem(storageKey, JSON.stringify({ birthDecade: 80, occupation: '教师' }));
    const wrapper = mount(HomeTestPage);
    expect(wrapper.find('form').exists()).toBe(true);
    expect(network).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('leaves account sessions and drafts untouched when page or storage events fire', () => {
    const sessionKey = 'manji.browser.session_id';
    sessionStorage.setItem(sessionKey, 'a'.repeat(64));
    sessionStorage.setItem('manji.connected.draft.preview-check', 'keep');
    localStorage.setItem(sessionKey, 'b'.repeat(64));
    const wrapper = mount(HomeTestPage);
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new StorageEvent('storage', { key: sessionKey }));
    expect(sessionStorage.getItem(sessionKey)).toBe('a'.repeat(64));
    expect(sessionStorage.getItem('manji.connected.draft.preview-check')).toBe('keep');
    expect(network).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
