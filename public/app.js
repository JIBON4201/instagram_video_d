const RECENT_KEY = 'reel-downloader:recent-v1';
const POLL_INTERVAL = 850;

function initSeo() {
  const siteUrl = window.location.origin;
  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = siteUrl + '/';

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.content = siteUrl;
  const twitterUrl = document.querySelector('meta[name="twitter:url"]');
  if (twitterUrl) twitterUrl.content = siteUrl;

  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  jsonLdScripts.forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      if (data['@type'] === 'WebApplication' && data.url === '') {
        data.url = siteUrl + '/';
        script.textContent = JSON.stringify(data);
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
}

initSeo();

const $ = (id) => document.getElementById(id);

const el = {
  form: $('url-form'),
  url: $('url'),
  paste: $('paste'),
  fetch: $('fetch'),
  fetchLabel: document.querySelector('#fetch .button-label'),
  preview: $('preview'),
  thumbImage: $('thumb-image'),
  thumbFallback: $('thumb-fallback'),
  durationChip: $('duration-chip'),
  avatar: $('avatar'),
  authorName: $('author-name'),
  authorHandle: $('author-handle'),
  description: $('description'),
  stats: $('stats'),
  originalLink: $('original-link'),
  qualities: $('qualities'),
  download: $('download'),
  progressPanel: $('progress-panel'),
  statusTitle: $('status-title'),
  statusPercent: $('status-percent'),
  statusDetail: $('status-detail'),
  progressTrack: $('progress-track'),
  progressBar: $('progress-bar'),
  cancel: $('cancel'),
  resultPanel: $('result-panel'),
  resultMeta: $('result-meta'),
  save: $('save'),
  again: $('again'),
  expiryNote: $('expiry-note'),
  errorPanel: $('error-panel'),
  errorTitle: $('error-title'),
  errorText: $('error-text'),
  dismissError: $('dismiss-error'),
  recentSection: $('recent-section'),
  recentList: $('recent-list'),
  clearRecent: $('clear-recent'),
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
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* empty or non-JSON response */
  }

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
  void el.toast.offsetWidth;
  el.toast.style.animation = '';
  state.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 5200);
}

function showError(title, message) {
  el.errorTitle.textContent = title;
  el.errorText.textContent = message;
  el.errorPanel.hidden = false;
  requestAnimationFrame(() => scrollTo(el.errorPanel));
}

function hideError() {
  el.errorPanel.hidden = true;
}

function scrollTo(node) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
}

function prettyCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number);
}

function prettyDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return null;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function prettyBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1);
  return `${rounded} ${units[index]}`;
}

function timeAgo(timestamp) {
  const seconds = Math.max(1, Math.round((Date.now() - Number(timestamp)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(Number(timestamp)).toLocaleDateString();
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function setFetchBusy(busy) {
  state.resolving = busy;
  el.fetch.disabled = busy;
  el.fetch.classList.toggle('loading', busy);
  el.fetchLabel.textContent = busy ? 'Fetching' : 'Fetch reel';
  el.url.setAttribute('aria-busy', String(busy));
}

function resetDownloadPanels() {
  stopPolling();
  state.jobId = null;
  state.downloading = false;
  el.progressPanel.hidden = true;
  el.resultPanel.hidden = true;
  el.download.disabled = false;
  hideError();
}

function renderStats(reel) {
  el.stats.replaceChildren();
  const stats = [];
  const likes = prettyCount(reel.likes);
  const comments = prettyCount(reel.comments);
  const views = prettyCount(reel.views);
  if (likes) stats.push(`${likes} likes`);
  if (comments) stats.push(`${comments} comments`);
  if (views) stats.push(`${views} views`);
  if (reel.slides > 1) stats.push(`Slide 1 of ${reel.slides}`);

  for (const text of stats) {
    const span = document.createElement('span');
    span.className = 'stat';
    span.textContent = text;
    el.stats.append(span);
  }
  el.stats.hidden = stats.length === 0;
}

function renderQualities(reel) {
  el.qualities.replaceChildren();
  const qualities =
    Array.isArray(reel.qualities) && reel.qualities.length
      ? reel.qualities
      : [{ id: 'best', label: 'Best quality', note: 'MP4', recommended: true }];

  qualities.forEach((quality, index) => {
    const label = document.createElement('label');
    label.className = 'quality';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'quality';
    input.value = quality.id;
    input.checked = Boolean(quality.recommended) || index === 0;

    const dot = document.createElement('span');
    dot.className = 'radio-dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'quality-text';

    const title = document.createElement('strong');
    title.textContent = quality.label;
    if (quality.recommended) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Recommended';
      title.append(badge);
    }

    const note = document.createElement('small');
    note.textContent = quality.note || '';

    text.append(title, note);
    label.append(input, dot, text);
    el.qualities.append(label);
  });
}

function renderReel(reel) {
  state.reel = reel;
  hideError();

  el.thumbImage.hidden = true;
  el.thumbImage.removeAttribute('src');
  el.thumbFallback.hidden = false;

  if (reel.thumbnail) {
    el.thumbImage.onload = () => {
      el.thumbImage.hidden = false;
      el.thumbFallback.hidden = true;
    };
    el.thumbImage.onerror = () => {
      el.thumbImage.hidden = true;
      el.thumbFallback.hidden = false;
    };
    el.thumbImage.src = reel.thumbnail;
  }

  const handle = String(reel.authorHandle || 'instagram').replace(/^@/, '');
  const name = String(reel.authorName || reel.authorHandle || 'Instagram creator');
  el.authorName.textContent = name;
  el.authorHandle.textContent = `@${handle}`;
  el.avatar.textContent = (handle[0] || 'R').toUpperCase();

  const duration = prettyDuration(reel.duration);
  if (duration) {
    el.durationChip.textContent = duration;
    el.durationChip.hidden = false;
  } else {
    el.durationChip.hidden = true;
  }

  let description = String(reel.description || '').trim();
  description = description.replace(/\n{2,}/g, '\n');
  if (!description) {
    const title = String(reel.title || '').trim();
    description = title && !/^video by /i.test(title) ? title : `Reel by @${handle}`;
  }
  el.description.textContent = description;

  renderStats(reel);
  renderQualities(reel);

  el.originalLink.href = reel.webpageUrl || reel.sourceUrl || '#';
  el.url.value = reel.sourceUrl || el.url.value;

  el.preview.hidden = false;
  el.download.disabled = false;
  requestAnimationFrame(() => scrollTo(el.preview));
}

const INSTAGRAM_URL_PATTERN = /https?:\/\/(www\.)?(m\.|l\.)?instagram\.com\/(reel|reels|p|tv|share)\/[A-Za-z0-9_-]+\/?/;

async function resolveReel(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) {
    showToast('Paste an Instagram reel link first.');
    el.url.focus();
    return;
  }
  if (state.resolving) return;

  // Client-side validation for immediate feedback on obviously invalid URLs
  if (!INSTAGRAM_URL_PATTERN.test(value) && !value.includes('instagram.com/')) {
    showError('Invalid URL', 'Please paste a valid Instagram reel, post, or share link.');
    el.url.focus();
    return;
  }

  resetDownloadPanels();
  el.preview.hidden = true;
  state.reel = null;
  setFetchBusy(true);

  try {
    const { reel } = await api('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: value }),
    });
    renderReel(reel);
    addRecent(reel);
  } catch (error) {
    const title =
      error.status === 429
        ? 'Slow down a moment'
        : error.status === 503
          ? 'Instagram is being difficult'
          : 'Couldn’t load this reel';
    showError(title, error.message);
  } finally {
    setFetchBusy(false);
  }
}

function showProgressShell() {
  hideError();
  el.resultPanel.hidden = true;
  el.progressPanel.hidden = false;
  el.progressTrack.classList.add('indeterminate');
  el.progressBar.style.setProperty('--progress', '0%');
  el.statusTitle.textContent = 'Queued…';
  el.statusDetail.textContent = '';
  el.statusPercent.textContent = '';
  requestAnimationFrame(() => scrollTo(el.progressPanel));
}

function updateProgress(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const indeterminate =
    Boolean(job.indeterminate) ||
    job.status === 'queued' ||
    job.status === 'resolving' ||
    (job.status === 'downloading' && progress < 4);

  el.statusTitle.textContent = job.stage || 'Working…';
  el.progressTrack.classList.toggle('indeterminate', indeterminate);

  if (!indeterminate) {
    el.progressBar.style.setProperty('--progress', `${progress}%`);
    el.statusPercent.textContent = `${Math.round(progress)}%`;
  } else {
    el.statusPercent.textContent = '';
  }

  if (job.detail) {
    el.statusDetail.textContent = job.detail;
  } else if (indeterminate && job.status !== 'queued') {
    el.statusDetail.textContent = 'This can take a few seconds.';
  } else {
    el.statusDetail.textContent = '';
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
      el.download.disabled = false;
      el.progressPanel.hidden = true;
      showResult(job);
      return;
    }

    if (job.status === 'error') {
      stopPolling();
      state.downloading = false;
      state.jobId = null;
      el.download.disabled = false;
      el.progressPanel.hidden = true;
      showError('Download failed', job.error || 'Something went wrong. Please try again.');
      return;
    }

    if (job.status === 'cancelled') {
      stopPolling();
      state.downloading = false;
      state.jobId = null;
      el.download.disabled = false;
      el.progressPanel.hidden = true;
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
      el.download.disabled = false;
      el.progressPanel.hidden = true;
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
    el.progressPanel.hidden = true;
    showError(
      error.status === 429 ? 'Queue is full' : 'Couldn’t start the download',
      error.message,
    );
  }
}

function showResult(job) {
  const result = job.result || {};
  const parts = [];
  if (result.width && result.height) parts.push(`${result.width} × ${result.height}`);
  if (result.size) parts.push(prettyBytes(result.size));
  if (result.videoCodec) {
    parts.push(result.audioCodec ? `${result.videoCodec} + ${result.audioCodec}` : result.videoCodec);
  }
  const duration = prettyDuration(result.duration);
  if (duration) parts.push(duration);

  el.resultMeta.textContent = parts.join(' · ');
  el.save.href = result.downloadUrl || '#';
  el.save.download = result.filename || 'reel.mp4';

  const minutes = job.expiresAt
    ? Math.max(1, Math.round((new Date(job.expiresAt).getTime() - Date.now()) / 60000))
    : 30;
  el.expiryNote.textContent = result.filename
    ? `Link expires in ${minutes} min · ${result.filename}`
    : `Link expires in ${minutes} min.`;

  el.resultPanel.hidden = false;
  requestAnimationFrame(() => {
    scrollTo(el.resultPanel);
  });
}

async function cancelDownload() {
  const id = state.jobId;
  stopPolling();
  state.downloading = false;
  state.jobId = null;
  el.progressPanel.hidden = true;
  el.download.disabled = false;

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
  el.progressPanel.hidden = true;
  el.resultPanel.hidden = true;
  el.download.disabled = false;
  hideError();
  el.url.value = '';
  el.url.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- Recent history ---------- */

function recentItems() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.url === 'string' &&
        typeof item.title === 'string' &&
        typeof item.author === 'string' &&
        typeof item.at === 'number',
    );
  } catch {
    return [];
  }
}

function saveRecent(items) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, 6)));
  } catch {
    /* storage can be unavailable in private mode */
  }
}

function addRecent(reel) {
  const items = recentItems().filter(
    (item) => item.url !== reel.sourceUrl && item.shortcode !== reel.shortcode,
  );
  const title =
    String(reel.description || reel.title || '')
      .trim()
      .split('\n')[0]
      .slice(0, 90) || `Reel by @${reel.authorHandle}`;
  items.unshift({
    url: reel.sourceUrl,
    shortcode: reel.shortcode || '',
    title,
    author: reel.authorHandle || 'instagram',
    at: Date.now(),
  });
  saveRecent(items);
  renderRecent();
}

function renderRecent() {
  const items = recentItems();
  el.recentSection.hidden = items.length === 0;
  el.recentList.replaceChildren();

  for (const item of items.slice(0, 4)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.title = item.title;

    const avatar = document.createElement('span');
    avatar.className = 'recent-avatar';
    avatar.textContent = (item.author[0] || 'R').toUpperCase();

    const text = document.createElement('span');
    text.className = 'recent-text';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('span');
    meta.textContent = `@${item.author} · ${timeAgo(item.at)}`;
    text.append(title, meta);

    const arrow = document.createElement('span');
    arrow.className = 'recent-arrow';
    arrow.textContent = '↗';
    arrow.setAttribute('aria-hidden', 'true');

    button.append(avatar, text, arrow);
    button.addEventListener('click', () => {
      el.url.value = item.url;
      resolveReel(item.url);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    el.recentList.append(button);
  }
}

/* ---------- Events ---------- */

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  resolveReel(el.url.value);
});

el.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast('Your clipboard is empty.');
      return;
    }
    el.url.value = text.trim();
    resolveReel(text);
  } catch {
    showToast('Clipboard access was blocked. Paste with Ctrl+V or ⌘V.');
    el.url.focus();
  }
});

el.url.addEventListener('paste', () => {
  setTimeout(() => {
    const value = el.url.value.trim();
    if (/instagram\.com\//i.test(value) && !state.resolving) {
      resolveReel(value);
    }
  }, 40);
});

el.download.addEventListener('click', startDownload);
el.cancel.addEventListener('click', cancelDownload);
el.again.addEventListener('click', resetToSearch);
el.dismissError.addEventListener('click', hideError);

el.clearRecent.addEventListener('click', () => {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* ignore */
  }
  renderRecent();
});

window.addEventListener('pagehide', () => {
  if (state.jobId) {
    fetch(`/api/jobs/${state.jobId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
});

renderRecent();
if (window.matchMedia('(pointer: fine)').matches) {
  el.url.focus({ preventScroll: true });
}
