const POLL_INTERVAL = 850;

const $ = (id) => document.getElementById(id);

const el = {
  form: $('form'),
  url: $('url'),
  fetch: $('fetch'),
  preview: $('preview'),
  progress: $('progress'),
  result: $('result'),
  error: $('error'),
  thumb: $('thumb'),
  thumbFallback: $('thumb-fallback'),
  playOverlay: $('play-overlay'),
  duration: $('duration'),
  avatar: $('avatar'),
  authorName: $('author-name'),
  authorHandle: $('author-handle'),
  originalLink: $('original-link'),
  description: $('description'),
  qualities: $('qualities'),
  download: $('download'),
  reset: $('reset'),
  stage: $('stage'),
  percent: $('percent'),
  detail: $('detail'),
  bar: $('bar'),
  cancel: $('cancel'),
  save: $('save'),
  meta: $('meta'),
  again: $('again'),
  errorTitle: $('error-title'),
  errorMessage: $('error-message'),
  errorDismiss: $('error-dismiss'),
  toast: $('toast'),
};

const state = {
  reel: null,
  jobId: null,
  pollTimer: null,
  pollFailures: 0,
  resolving: false,
  downloading: false,
  toastTimer: null,
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  let data = null;
  try { data = await response.json(); } catch { /* empty or non-JSON */ }

  if (!response.ok) {
    throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status);
  }
  return data;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.hidden = false;
  el.toast.style.animation = 'none';
  el.toast.offsetWidth;
  el.toast.style.animation = '';
  state.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
}

function showError(title, message) {
  el.errorTitle.textContent = title;
  el.errorMessage.textContent = message;
  el.error.hidden = false;
  el.error.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function hideError() { el.error.hidden = true; }

function prettyDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function prettyBytes(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let size = v; let i = 0;
  while (size >= 1024 && i < u.length - 1) { size /= 1024; i += 1; }
  const r = size >= 100 || i === 0 ? Math.round(size) : size.toFixed(1);
  return `${r} ${u[i]}`;
}

function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }

function setFetchBusy(busy) {
  state.resolving = busy;
  el.fetch.disabled = busy;
  el.url.disabled = busy;
  el.fetch.textContent = busy ? 'Downloading&hellip;' : 'Download';
}

function resetPanels() {
  stopPolling();
  state.jobId = null;
  state.downloading = false;
  el.preview.hidden = true;
  el.progress.hidden = true;
  el.result.hidden = true;
  el.error.hidden = true;
  el.download.disabled = false;
  el.download.textContent = 'Download Video';
}

function renderQualities(reel) {
  console.debug('[DIAG] renderQualities called', { qualitiesEl: !!el.qualities, qualitiesId: el.qualities?.id });
  if (!el.qualities) {
    console.error('[DIAG] renderQualities: el.qualities is null! #qualities missing from DOM.');
    return;
  }
  el.qualities.replaceChildren();
  const qualities = Array.isArray(reel.qualities) && reel.qualities.length
    ? reel.qualities
    : [{ id: 'best', label: 'Best quality', note: 'MP4', recommended: true }];

  qualities.forEach((q, i) => {
    const label = document.createElement('label');
    label.className = 'quality';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'quality';
    input.value = q.id;
    input.checked = Boolean(q.recommended) || i === 0;

    const dot = document.createElement('span');
    dot.className = 'radio-dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    text.className = 'quality-text';

    const title = document.createElement('strong');
    title.textContent = q.label;

    text.appendChild(title);
    label.appendChild(input);
    label.appendChild(dot);
    label.appendChild(text);
    el.qualities.appendChild(label);
  });

  const style = document.createElement('style');
  style.textContent = `
    .quality:has(input:checked) { border-color: #8b5cf6; background: #12102a; box-shadow: inset 0 0 0 1px rgba(139, 92, 246, 0.15); }
    .quality:has(input:checked) .radio-dot { border-color: #8b5cf6; }
    .quality:has(input:checked) .radio-dot::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: linear-gradient(135deg, #fb7185, #ec4899, #8b5cf6); }
  `;
  document.head.appendChild(style);
}

function renderReel(reel) {
  console.debug('[DIAG] renderReel called', { hasThumbnail: !!reel?.thumbnail, thumbnail: reel?.thumbnail?.slice(0, 80) + '...', reelKeys: reel ? Object.keys(reel) : null });
  state.reel = reel;
  hideError();

  el.thumb.classList.remove('loaded');
  el.thumb.removeAttribute('src');
  el.thumbFallback.hidden = false;
  el.playOverlay.hidden = true;

  if (reel.thumbnail) {
    el.thumb.onload = () => { el.thumb.classList.add('loaded'); el.thumb.hidden = false; el.thumbFallback.hidden = true; el.playOverlay.hidden = false; };
    el.thumb.onerror = () => { el.thumb.hidden = true; el.thumbFallback.hidden = false; el.playOverlay.hidden = true; };
    el.thumb.src = reel.thumbnail;
  }

  const handle = String(reel.authorHandle || 'instagram').replace(/^@/, '');
  const name = String(reel.authorName || reel.authorHandle || 'Instagram Creator');
  el.authorName.textContent = name;
  el.authorHandle.textContent = `@${handle}`;
  el.avatar.textContent = (handle[0] || 'R').toUpperCase();

  const duration = prettyDuration(reel.duration);
  if (duration) { el.duration.textContent = duration; el.duration.hidden = false; } else { el.duration.hidden = true; }

  let description = String(reel.description || '').trim();
  description = description.replace(/\n{2,}/g, '\n');
  if (!description) {
    const title = String(reel.title || '').trim();
    description = title && !/^video by /i.test(title) ? title : `Reel by @${handle}`;
  }
  el.description.textContent = description;

  renderQualities(reel);
  el.originalLink.href = reel.webpageUrl || reel.sourceUrl || '#';

  resetPanels();
  el.preview.hidden = false;
  el.preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showProgressShell() {
  hideError();
  el.result.hidden = true;
  el.progress.hidden = false;
  el.bar.style.width = '0%';
  el.stage.textContent = 'Preparing your video&hellip;';
  el.detail.textContent = '';
  el.percent.textContent = '';
  el.cancel.disabled = false;
  el.progress.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateProgress(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const indeterminate = Boolean(job.indeterminate) ||
    job.status === 'queued' ||
    job.status === 'resolving' ||
    (job.status === 'downloading' && progress < 4);

  el.stage.textContent = job.stage || 'Working&hellip;';
  el.bar.classList.toggle('indeterminate', indeterminate);

  if (!indeterminate) {
    el.bar.style.width = `${progress}%`;
    el.percent.textContent = `${Math.round(progress)}%`;
  } else {
    el.percent.textContent = '';
  }

  if (job.detail) {
    el.detail.textContent = job.detail;
  } else if (indeterminate && job.status !== 'queued') {
    el.detail.textContent = 'This can take a few seconds.';
  } else {
    el.detail.textContent = '';
  }
}

async function pollJob(id) {
  if (state.jobId !== id) return;
  try {
    const { job } = await api(`/api/jobs/${id}`);
    state.pollFailures = 0;
    if (state.jobId !== id) return;

    updateProgress(job);

    if (job.status === 'ready') {
      stopPolling();
      state.downloading = false;
      state.jobId = null;
      el.progress.hidden = true;
      showResult(job);
      return;
    }
    if (job.status === 'error') {
      stopPolling();
      state.downloading = false;
      state.jobId = null;
      el.progress.hidden = true;
      showError('Download failed', job.error || 'Something went wrong. Please try again.');
      return;
    }
    if (job.status === 'cancelled') {
      stopPolling();
      state.downloading = false;
      state.jobId = null;
      el.progress.hidden = true;
      return;
    }
    state.pollTimer = setTimeout(() => pollJob(id), POLL_INTERVAL);
  } catch (error) {
    if (state.jobId !== id) return;
    state.pollFailures += 1;
    if (error.status === 404 || state.pollFailures >= 6) {
      stopPolling();
      state.downloading = false;
      state.jobId = null;
      el.progress.hidden = true;
      showError('Download lost', error.message || 'This download expired. Please try again.');
      return;
    }
    state.pollTimer = setTimeout(() => pollJob(id), 1600);
  }
}

async function startDownload() {
  if (!state.reel || state.downloading) return;

  const quality = document.querySelector('input[name="quality"]:checked')?.value || 'best';
  state.downloading = true;
  state.pollFailures = 0;
  el.download.disabled = true;
  el.download.textContent = 'Preparing&hellip;';
  showProgressShell();

  try {
    const { jobId } = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({ url: state.reel.sourceUrl, quality }),
    });
    state.jobId = jobId;
    pollJob(jobId);
  } catch (error) {
    state.downloading = false;
    state.jobId = null;
    el.download.disabled = false;
    el.download.textContent = 'Download Video';
    el.progress.hidden = true;
    showError(
      error.status === 429 ? 'Queue is full' : "Couldn't start the download",
      error.message,
    );
  }
}

function showResult(job) {
  const result = job.result || {};
  const parts = [];
  if (result.width && result.height) parts.push(`${result.width} \u00d7 ${result.height}`);
  if (result.size) parts.push(prettyBytes(result.size));
  if (result.videoCodec) {
    parts.push(result.audioCodec ? `${result.videoCodec} + ${result.audioCodec}` : result.videoCodec);
  }
  const duration = prettyDuration(result.duration);
  if (duration) parts.push(duration);

  el.meta.textContent = parts.join(' \u00b7 ');
  el.save.href = result.downloadUrl || '#';
  el.save.download = result.filename || 'reel.mp4';

  el.result.hidden = false;
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function cancelDownload() {
  const id = state.jobId;
  stopPolling();
  state.downloading = false;
  state.jobId = null;
  el.progress.hidden = true;
  el.download.disabled = false;
  el.download.textContent = 'Download Video';

  if (id) {
    api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  showToast('Download cancelled.');
}

function resetToSearch() {
  stopPolling();
  state.reel = null;
  state.jobId = null;
  state.downloading = false;
  el.preview.hidden = true;
  el.progress.hidden = true;
  el.result.hidden = true;
  el.error.hidden = true;
  el.url.value = '';
  el.url.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function resolveReel(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    showToast('Paste an Instagram reel link first.');
    el.url.focus();
    return;
  }
  if (state.resolving) return;

  resetPanels();
  el.preview.hidden = true;
  setFetchBusy(true);

  try {
    console.debug('[DIAG] resolveReel: calling /api/resolve with url=', value.slice(0, 100));
    const { reel } = await api('/api/resolve', { method: 'POST', body: JSON.stringify({ url: value }) });
    console.debug('[DIAG] resolveReel: API response received', { reel: reel ? Object.keys(reel) : null, thumbnail: reel?.thumbnail ? reel.thumbnail.slice(0, 80) + '...' : null });
    renderReel(reel);
  } catch (error) {
    console.error('[DIAG] resolveReel: API error', { status: error.status, message: error.message, stack: error.stack });
    const title = error.status === 429 ? 'Slow down a moment'
      : error.status === 503 ? 'Instagram is being difficult'
      : "Couldn't load this reel";
    showError(title, error.message);
  } finally {
    setFetchBusy(false);
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  resolveReel(el.url.value);
});

el.download.addEventListener('click', startDownload);
el.cancel.addEventListener('click', cancelDownload);
el.again.addEventListener('click', resetToSearch);
el.reset.addEventListener('click', resetToSearch);
el.errorDismiss.addEventListener('click', hideError);

window.addEventListener('pagehide', () => {
  if (state.jobId) {
    fetch(`/api/jobs/${state.jobId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
});

el.url.focus({ preventScroll: true });
