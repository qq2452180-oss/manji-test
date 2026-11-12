export function navigate(url, { replace = false } = {}) {
  if (replace) window.location.replace(url);
  else window.location.assign(url);
}

export function reloadPage() { window.location.reload(); }
