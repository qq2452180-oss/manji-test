import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { entryFor } from '../src/lib/entries.js';
import PrivatePhoto from '../src/components/PrivatePhoto.vue';
import * as api from '../src/lib/api.js';
vi.mock('../src/lib/api.js', () => ({ getAuthToken: vi.fn(() => 'owner-a'), getPhotoBlob: vi.fn() }));
vi.mock('../src/lib/navigation.js', () => ({ navigate: vi.fn(), reloadPage: vi.fn() }));

describe('existing web2 entry addresses', () => {
  it.each(['index', 'login', 'interview', 'history', 'organizing', 'biography', 'chapter', 'story', 'profile', 'profile-edit', 'preview'])('%s remains a Vue page', page => {
    expect(entryFor(`/web2/${page}.html`, '?id=kept')).toEqual({ page });
  });
  it('directory URL opens the home page', () => expect(entryFor('/web2/')).toEqual({ page: 'index' }));
  it('offers isolated prototype routes without changing formal entries', () => {
    expect(entryFor('/web2/', '?prototype=1')).toEqual({ page: 'prototype-home' });
    expect(entryFor('/web2/index.html', '?prototype=1')).toEqual({ page: 'prototype-home' });
    expect(entryFor('/web2/index.html', '?prototype=0')).toEqual({ page: 'index' });
    expect(entryFor('/web2/interview.html', '?prototype=1&chapter_id=origins&content_id=hometown')).toEqual({ page: 'prototype-interview' });
    expect(entryFor('/web2/interview.html', '?prototype=0')).toEqual({ page: 'interview' });
    expect(entryFor('/web2/interview.html', '?chapter_id=origins&content_id=hometown')).toEqual({ page: 'interview' });
    expect(entryFor('/web2/story.html', '?prototype=1&chapter_id=origins&content_id=hometown')).toEqual({ page: 'prototype-story' });
    expect(entryFor('/web2/story.html', '?prototype=0')).toEqual({ page: 'story' });
    expect(entryFor('/web2/story.html', '?chapter_id=origins&content_id=hometown')).toEqual({ page: 'story' });
    for (const page of ['biography', 'chapter', 'profile', 'history', 'organizing']) {
      expect(entryFor(`/web2/${page}.html`, '?prototype=1')).toEqual({ page: 'prototype-' + page });
      expect(entryFor(`/web2/${page}.html`, '?prototype=0')).toEqual({ page });
    }
    expect(entryFor('/web2/preview.html', '?prototype=1&kind=family')).toEqual({ page: 'prototype-family' });
  });
  it.each([
    ['photo', 'interview', 'entry', 'PHOTO'], ['text-chat', 'interview', 'interaction', 'text'],
    ['realtime-interview', 'interview', null, null], ['interview-history', 'history', null, null],
  ])('%s preserves saved sessions and other query parameters', (source, destination, key, value) => {
    const result = new URL(entryFor(`/web2/${source}.html`, '?session_id=old&source=bookmark').redirect, location.href);
    expect(result.pathname).toBe(`/web2/${destination}.html`);
    expect(result.searchParams.get('session_id')).toBe('old');
    expect(result.searchParams.get('source')).toBe('bookmark');
    expect(result.searchParams.has('new')).toBe(false);
    if (key) expect(result.searchParams.get(key)).toBe(value);
  });
  it('new aliases preserve the intentional new-entry behavior', () => {
    expect(entryFor('/web2/photo.html').redirect).toBe('./interview.html?entry=PHOTO&new=1');
    expect(entryFor('/web2/interview-history.html').redirect).toBe('./history.html');
  });
});

describe('private photo lifecycle', () => {
  it('discards an image that arrives after an account change', async () => {
    let resolve;
    api.getPhotoBlob.mockReturnValue(new Promise(done => { resolve = done; }));
    const create = vi.spyOn(URL, 'createObjectURL');
    const wrapper = mount(PrivatePhoto, { props: { mediaId: 'private-a' } });
    api.getAuthToken.mockReturnValue('owner-b');
    window.dispatchEvent(new Event('manji:auth-changed'));
    resolve(new Blob(['image'])); await flushPromises();
    expect(wrapper.find('img').exists()).toBe(false); expect(create).not.toHaveBeenCalled();
  });
  it('changing the photo releases the old URL and unmount releases the new one', async () => {
    api.getAuthToken.mockReturnValue('owner-a'); api.getPhotoBlob.mockResolvedValue(new Blob(['image']));
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two');
    const release = vi.spyOn(URL, 'revokeObjectURL');
    const wrapper = mount(PrivatePhoto, { props: { mediaId: 'one' } }); await flushPromises();
    const obsoleteImage = wrapper.find('img').element.cloneNode();
    await wrapper.setProps({ mediaId: 'two' }); await flushPromises();
    expect(wrapper.find('img').attributes('src')).toBe('blob:two');
    expect(release).toHaveBeenCalledWith('blob:one');
    // An obsolete detached thumbnail must not clear its replacement.
    expect(obsoleteImage.getAttribute('src')).toBe('blob:one');
    wrapper.unmount(); expect(release).toHaveBeenCalledWith('blob:two');
  });
  it('a failed image can be fetched again by clicking its retry control', async () => {
    api.getAuthToken.mockReturnValue('owner-a'); api.getPhotoBlob.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Blob(['image']));
    const wrapper = mount(PrivatePhoto, { props: { mediaId: 'one' } }); await flushPromises();
    expect(wrapper.text()).toContain('点击重试');
    await wrapper.get('button.material-photo').trigger('click'); await flushPromises();
    expect(wrapper.find('img').exists()).toBe(true); expect(api.getPhotoBlob).toHaveBeenCalledTimes(2);
  });
});
