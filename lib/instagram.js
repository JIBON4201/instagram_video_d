import { runYtDlp } from './ytdlp.js';

export class AppError extends Error {
  constructor(status, message, metadata) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.metadata = metadata || null;
  }
}

const ALLOWED_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'l.instagram.com',
]);
const POST_KINDS = new Set(['reel', 'reels', 'p', 'tv']);
const CODE_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;

export const QUALITY_IDS = new Set(['best', 'source', 'fast']);

export function extractUrlFromText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(URL_IN_TEXT);
  if (!match) return null;
  return match[0].replace(/[),.;!?]+$/, '');
}

/**
 * Accepts a pasted URL, a full share message, or a bare instagram.com link and
 * returns a canonical URL. Only instagram.com hosts are allowed, which also
 * keeps the backend from becoming a generic SSRF proxy.
 */
export function normalizeReelUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new AppError(400, 'Paste an Instagram reel link first.');
  }

  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) {
    raw = extractUrlFromText(raw) || `https://${raw}`;
  } else {
    raw = extractUrlFromText(raw) || raw;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'That does not look like a valid link.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'Only http(s) links are supported.');
  }
  if (url.username || url.password) {
    throw new AppError(400, 'That link is not valid.');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!ALLOWED_HOSTS.has(host)) {
    throw new AppError(400, 'Only instagram.com links are supported.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const kind = (segments[0] || '').toLowerCase();

  if (kind === 'share') {
    // Two shapes are in the wild:
    //   /share/reel/<code>/
    //   /share/<code>/
    if (segments.length === 2) {
      if (!CODE_PATTERN.test(segments[1])) {
        throw new AppError(400, 'That Instagram share link is not valid.');
      }
      return `https://www.instagram.com/share/${segments[1]}/`;
    }
    if (segments.length === 3) {
      const subKind = segments[1].toLowerCase();
      if (!POST_KINDS.has(subKind) || !CODE_PATTERN.test(segments[2])) {
        throw new AppError(400, 'That Instagram share link is not valid.');
      }
      return `https://www.instagram.com/share/${subKind === 'reels' ? 'reel' : subKind}/${segments[2]}/`;
    }
    throw new AppError(400, 'That Instagram share link is not valid.');
  }

  if (!POST_KINDS.has(kind) || segments.length !== 2) {
    throw new AppError(400, 'Use a link to a reel, video post, or IGTV video.');
  }
  if (!CODE_PATTERN.test(segments[1])) {
    throw new AppError(400, 'That Instagram link is not valid.');
  }

  const normalizedKind = kind === 'reels' ? 'reel' : kind;
  return `https://www.instagram.com/${normalizedKind}/${segments[1]}/`;
}

export function shortcodeFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    if (segments[0] === 'share') return segments.at(-1) || '';
    return segments[1] || '';
  } catch {
    return '';
  }
}

function codecName(vcodec) {
  const codec = String(vcodec || '').toLowerCase();
  if (codec.startsWith('avc') || codec.startsWith('h264')) return 'H.264';
  if (codec.startsWith('vp09') || codec.startsWith('vp9')) return 'VP9';
  if (codec.startsWith('av01')) return 'AV1';
  if (codec.startsWith('hev') || codec.startsWith('h265')) return 'HEVC';
  return 'MP4';
}

function isH264(vcodec) {
  const codec = String(vcodec || '').toLowerCase();
  return codec.startsWith('avc') || codec.startsWith('h264');
}

export function summarizeFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const knownVideo = formats.filter(
    (f) => f && f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0,
  );
  const progressive = formats.filter(
    (f) =>
      f &&
      f.ext === 'mp4' &&
      f.vcodec !== 'none' &&
      f.acodec !== 'none' &&
      !f.format_id?.startsWith('dash-'),
  );

  const best =
    knownVideo.sort(
      (a, b) => Number(b.height) - Number(a.height) || Number(b.tbr || 0) - Number(a.tbr || 0),
    )[0] || null;

  const width = best ? Number(best.width) || null : null;
  const height = best ? Number(best.height) || null : null;
  const qualityHeight = width && height ? Math.min(width, height) : height || null;
  const bestIsH264 = best ? isH264(best.vcodec) : true;
  const hasDash = Boolean(best);
  const hasProgressive = progressive.length > 0;
  const qualities = [];

  qualities.push({
    id: 'best',
    label: qualityHeight ? `${qualityHeight}p · Best` : 'Best quality',
    note: 'H.264 MP4 · plays on any device',
    recommended: true,
  });

  if (hasDash && !bestIsH264) {
    qualities.push({
      id: 'source',
      label: qualityHeight ? `${qualityHeight}p · Original` : 'Original source',
      note: `${codecName(best.vcodec)} · no re-encode · fastest`,
    });
  }

  if (hasDash && hasProgressive) {
    qualities.push({
      id: 'fast',
      label: 'Data saver',
      note: 'Progressive MP4 · smallest download',
    });
  }

  return {
    qualityHeight,
    width,
    height,
    videoCodec: best ? codecName(best.vcodec) : 'H.264',
    needsTranscode: hasDash && !bestIsH264,
    hasProgressive,
    qualities,
  };
}

export function buildFormatSelector(quality, preferProgressive = false) {
  if (quality === 'fast') {
    return 'best[ext=mp4]/best';
  }
  if (quality === 'best' && preferProgressive) {
    return 'best[ext=mp4]/bestvideo+bestaudio/best';
  }
  return 'bestvideo+bestaudio/best';
}

function videoInfoFromJson(info, sourceUrl) {
  let slides = 1;
  let item = info;

  if (!item) throw new AppError(502, 'Instagram returned an empty response.');

  if (Array.isArray(item.entries) || item._type === 'playlist') {
    const entries = (item.entries || []).filter(Boolean);
    slides = Math.max(entries.length, 1);
    const videoEntry = entries.find((entry) => Array.isArray(entry.formats) && entry.formats.length);
    if (!videoEntry) {
      throw new AppError(422, 'This Instagram post does not contain a video.');
    }
    item = videoEntry;
  }

  const hasVideo =
    Array.isArray(item.formats) &&
    item.formats.some(
      (f) => f && f.vcodec && f.vcodec !== 'none' && (f.height || f.format_id?.startsWith('dash-')),
    );
  const hasProgressive = Array.isArray(item.formats) && item.formats.some((f) => f?.ext === 'mp4');

  if (!hasVideo && !hasProgressive && !item.url) {
    throw new AppError(422, 'This Instagram post does not contain a video.');
  }

  const summary = summarizeFormats(item);
  const handle = String(item.channel || item.uploader || 'instagram').replace(/^@/, '');
  const displayName = String(item.uploader || item.channel || handle);

  return {
    sourceUrl,
    webpageUrl: item.webpage_url || sourceUrl,
    shortcode: item.id || shortcodeFromUrl(sourceUrl),
    title: item.title || '',
    description: item.description || '',
    authorHandle: handle,
    authorName: displayName,
    likes: Number(item.like_count) || null,
    comments: Number(item.comment_count) || null,
    views: Number(item.view_count) || null,
    duration: Number(item.duration) || null,
    timestamp: Number(item.timestamp) || null,
    thumbnailUrl: item.thumbnail || null,
    slides,
    ...summary,
  };
}

/** Fetch reel metadata with yt-dlp. */
export async function extractReel(sourceUrl) {
  let result;
  try {
    result = await runYtDlp([
      '--dump-single-json',
      sourceUrl,
    ]);
  } catch (error) {
    throw friendlyExtractorError(error);
  }

  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new AppError(502, 'Instagram returned an unexpected response. Try again in a moment.');
  }

  return videoInfoFromJson(info, sourceUrl);
}

export function friendlyExtractorError(error) {
  const text = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase();

  if (error?.killed || /timed? ?out|etimedout/.test(text)) {
    return new AppError(504, 'Instagram took too long to respond. Try again.');
  }
  if (
    /login required|rate.?limit|rate-limit|checkpoint|requires authentication|http error 401|http error 429|not authorized/.test(
      text,
    )
  ) {
    return new AppError(
      503,
      'Instagram is asking for a login right now. Try again in a few minutes, or add cookies (see README).',
    );
  }
  if (/private|not available|unavailable|removed|deleted|http error 404|not found/.test(text)) {
    return new AppError(404, 'This reel is private, deleted, or not available in this region.');
  }
  if (/unsupported url|no video|there is no video/.test(text)) {
    return new AppError(422, 'This link does not point to an Instagram video.');
  }
  if (/network|enotfound|eai_again|getaddrinfo|connection|fetch error/.test(text)) {
    return new AppError(502, 'Could not reach Instagram. Check the server connection and try again.');
  }
  return new AppError(502, 'Could not read this reel. It may be private or temporarily unavailable.');
}
