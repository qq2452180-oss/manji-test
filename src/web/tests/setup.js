import { afterEach, beforeEach, vi } from 'vitest';
import { enableAutoUnmount } from '@vue/test-utils';

enableAutoUnmount(afterEach);
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  history.replaceState(null, '', '/web2/index.html');
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:test-image');
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
});
if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () { this.open = true; };
if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () { this.open = false; };
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });
