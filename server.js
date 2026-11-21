import http from 'node:http';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  AppError,
  QUALITY_IDS,
  extractReel,
  friendlyExtractorError,
  normalizeReelUrl,
  shortcodeFromUrl,
} from './lib/instagram.js';
import { downloadReel, isAbort } from './lib/download.js';
import { ytdlpVersion } from './lib/ytdlp.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT) || 1);
const MAX_QUEUED = Math.max(1, Number(process.env.MAX_QUEUED) || 20);
const JOB_TTL_MS = Math.max(5, Number(process.env.JOB_TTL_MIN) || 30) * 60_000;
const RESOLVE_TTL_MS = Math.max(2, Number(process.env.RESOLVE_TTL_MIN) || 10) * 60_000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_CACHE_ENTRIES = 100;
const TMP_ROOT = process.env.TMP_DIR || path.join(os.tmpdir(), 'reel-downloader');
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

const RATE_LIMIT_RESOLVE = Math.max(1, Number(process.env.RATE_LIMIT_RESOLVE) || 60);
const RATE_LIMIT_DOWNLOAD = Math.max(1, Number(process.env.RATE_LIMIT_DOWNLOAD) || 8);
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000);
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

const jobs = new Map();
const queue = [];
const resolveCache = new Map();
const thumbnails = new Map();
const rateBuckets = new Map();
let activeJobs = 0;
let ytdlp = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function log(level, message, meta = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'Invalid request body.');
  }
}

function clientIp(req) {
  if (process.env.TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function allowRequest(req, name, limit, windowMs) {
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  const remaining = Math.max(0, limit - bucket.count);
  const resetAt = bucket.resetAt;
  if (bucket.count > limit) {
    throw new AppError(429, 'Too many requests. Please wait a moment and try again.', { rateLimit: { limit, remaining, resetAt } });
  }
  return { limit, remaining, resetAt };
}

function cacheResolvedReel(reel) {
  resolveCache.delete(reel.shortcode);
  resolveCache.set(reel.shortcode, {
    reel,
    resolveId: reel.resolveId,
    expiresAt: Date.now() + RESOLVE_TTL_MS,
  });
  while (resolveCache.size > MAX_CACHE_ENTRIES) {
    const oldest = resolveCache.keys().next().value;
    resolveCache.delete(oldest);
  }
}

function cachedReel(url) {
  const shortcode = shortcodeFromUrl(url);
  const entry = resolveCache.get(shortcode);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    resolveCache.delete(shortcode);
    return null;
  }
  return entry.reel;
}

async function fetchThumbnail(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        referer: 'https://www.instagram.com/',
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    if (!type.startsWith('image/')) return null;
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 2 * 1024 * 1024) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) return null;
    return { buffer, type };
  } catch {
    return null;
  }
}

function publicReel(info, resolveId, thumbnail) {
  return {
    resolveId,
    sourceUrl: info.sourceUrl,
    webpageUrl: info.webpageUrl,
    shortcode: info.shortcode,
    title: info.title,
    description: String(info.description || '').slice(0, 2_000),
    authorHandle: info.authorHandle,
    authorName: info.authorName,
    likes: info.likes,
    comments: info.comments,
    views: info.views,
    duration: info.duration,
    timestamp: info.timestamp,
    slides: info.slides,
    qualityHeight: info.qualityHeight,
    width: info.width,
    height: info.height,
    videoCodec: info.videoCodec,
    qualities: info.qualities,
    thumbnail,
  };
}

async function handleResolve(req, res) {
  const rateInfo = allowRequest(req, 'resolve', RATE_LIMIT_RESOLVE, RATE_LIMIT_WINDOW_MS);
  const body = await readJson(req);
  const sourceUrl = normalizeReelUrl(body.url);

  const cached = cachedReel(sourceUrl);
  if (cached) {
    return sendJson(res, 200, { reel: cached, cached: true }, {
      'X-RateLimit-Limit': String(rateInfo.limit),
      'X-RateLimit-Remaining': String(rateInfo.remaining),
      'X-RateLimit-Reset': String(Math.ceil(rateInfo.resetAt / 1000)),
    });
  }

  const info = await extractReel(sourceUrl);
  const resolveId = crypto.randomUUID();
  const thumb = await fetchThumbnail(info.thumbnailUrl);
  let thumbnail = null;

  if (thumb) {
    thumbnails.set(resolveId, {
      ...thumb,
      expiresAt: Date.now() + JOB_TTL_MS,
    });
    while (thumbnails.size > MAX_CACHE_ENTRIES) {
      const oldest = thumbnails.keys().next().value;
      thumbnails.delete(oldest);
    }
    thumbnail = `/api/thumb/${resolveId}`;
  }

  const reel = publicReel({ ...info, resolveId }, resolveId, thumbnail);
  cacheResolvedReel(reel);
  return sendJson(res, 200, { reel, cached: false }, {
    'X-RateLimit-Limit': String(rateInfo.limit),
    'X-RateLimit-Remaining': String(rateInfo.remaining),
    'X-RateLimit-Reset': String(Math.ceil(rateInfo.resetAt / 1000)),
  });
}

function safeFilenamePart(value, fallback) {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function buildFilename(reel, result) {
  const author = safeFilenamePart(reel?.authorHandle, 'instagram');
  const shortcode = safeFilenamePart(reel?.shortcode, 'reel');
  const shortSide = result.width && result.height ? Math.min(result.width, result.height) : null;
  const quality = shortSide ? `${shortSide}p` : 'video';
  return `${author}-${shortcode}-${quality}.mp4`;
}

function jobPayload(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress || 0),
    indeterminate: Boolean(job.indeterminate),
    stage: job.stage,
    detail: job.detail || '',
    quality: job.quality,
    sourceUrl: job.sourceUrl,
    reel: job.reel,
    result: job.result
      ? {
          ...job.result,
          downloadUrl: `/api/jobs/${job.id}/file`,
        }
      : null,
    error: job.error || null,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt || null,
  };
}

function publicDownloadError(error) {
  if (error instanceof AppError) {
    if (error.stderr && /instagram|login|rate|private|not available|unsupported/i.test(error.stderr)) {
      return friendlyExtractorError(error).message;
    }
    return error.message.split('\n')[0];
  }
  return 'Something went wrong while processing this reel. Please try again.';
}

async function removeJobDir(job) {
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

async function runJob(job) {
  job.status = 'resolving';
  job.stage = 'Checking reel…';
  job.progress = 1;

  try {
    if (!job.reel) {
      const info = await extractReel(job.sourceUrl);
      job.reel = publicReel({ ...info, resolveId: null }, null, null);
    }
    if (job.cancelled) throw new Error('cancelled');

    job.status = 'downloading';
    const result = await downloadReel({
      url: job.sourceUrl,
      quality: job.quality,
      dir: job.dir,
      signal: job.controller.signal,
      preferProgressive: Boolean(job.reel?.hasProgressive),
      onProgress: (update) => {
        if (job.cancelled) return;
        if (update.stage) job.stage = update.stage;
        if (update.detail) job.detail = update.detail;
        if (typeof update.progress === 'number' && Number.isFinite(update.progress)) {
          job.indeterminate = false;
          job.progress = Math.max(job.progress, Math.min(100, update.progress));
        } else {
          job.indeterminate = true;
        }
      },
    });

    if (job.cancelled) throw new Error('cancelled');

    const filename = buildFilename(job.reel, result);
    const finalPath = path.join(job.dir, filename);
    await fsp.rename(result.filePath, finalPath);
    const stat = await fsp.stat(finalPath);

    job.filePath = finalPath;
    job.result = {
      filename,
      size: stat.size,
      width: result.width,
      height: result.height,
      duration: result.duration,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
    };
    job.status = 'ready';
    job.stage = 'Ready to save';
    job.detail = '';
    job.progress = 100;
    job.indeterminate = false;
    job.expiresAt = Date.now() + JOB_TTL_MS;
  } catch (error) {
    if (isAbort(error) || job.cancelled) {
      job.status = 'cancelled';
      job.stage = 'Download cancelled';
      job.error = null;
      job.expiresAt = Date.now() + 2 * 60_000;
      await removeJobDir(job);
    } else {
      job.status = 'error';
      job.stage = 'Could not download this reel';
      job.error = publicDownloadError(error);
      job.expiresAt = Date.now() + JOB_TTL_MS;
      log('error', 'job failed', {
        jobId: job.id,
        status: job.status,
        message: error?.message,
        stack: error?.stack,
        stderr: error?.stderr,
        stdout: error?.stdout,
        code: error?.code,
        signal: error?.signal,
        cmd: error?.cmd,
      });
      await removeJobDir(job);
    }
  }
}

function pump() {
  while (activeJobs < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    activeJobs += 1;
    runJob(job)
      .catch((error) => log('error', 'job unexpected', {
        jobId: job.id,
        message: error?.message,
        stack: error?.stack,
      }))
      .finally(() => {
        activeJobs -= 1;
        pump();
      });
  }
}

async function handleDownload(req, res) {
  const rateInfo = allowRequest(req, 'download', RATE_LIMIT_DOWNLOAD, RATE_LIMIT_WINDOW_MS);
  const body = await readJson(req);
  const sourceUrl = normalizeReelUrl(body.url);
  const quality = body.quality || 'best';

  if (!QUALITY_IDS.has(quality)) {
    throw new AppError(400, 'Unknown quality option.');
  }
  if (queue.length >= MAX_QUEUED) {
    throw new AppError(429, 'The download queue is full. Please try again in a minute.', {
      rateLimit: { limit: RATE_LIMIT_DOWNLOAD, remaining: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS },
    });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    sourceUrl,
    quality,
    status: 'queued',
    stage: 'Queued…',
    detail: '',
    progress: 0,
    indeterminate: true,
    createdAt: Date.now(),
    expiresAt: null,
    controller: new AbortController(),
    dir: path.join(TMP_ROOT, id),
    reel: cachedReel(sourceUrl),
    result: null,
    filePath: null,
    error: null,
    cancelled: false,
  };

  jobs.set(id, job);
  queue.push(job);
  pump();

  return sendJson(res, 202, { jobId: id, status: job.status }, {
    'X-RateLimit-Limit': String(rateInfo.limit),
    'X-RateLimit-Remaining': String(rateInfo.remaining),
    'X-RateLimit-Reset': String(Math.ceil(rateInfo.resetAt / 1000)),
  });
}

function handleGetJob(req, res, id) {
  const job = jobs.get(id);
  if (!job) throw new AppError(404, 'Download not found or expired.');
  return sendJson(res, 200, { job: jobPayload(job) });
}

async function handleCancelJob(req, res, id) {
  const job = jobs.get(id);
  if (!job) throw new AppError(404, 'Download not found or expired.');

  if (job.status === 'ready') {
    await removeJobDir(job);
    jobs.delete(id);
    return sendJson(res, 200, { ok: true });
  }

  if (job.status === 'queued' || job.status === 'resolving' || job.status === 'downloading') {
    job.cancelled = true;
    job.controller.abort();
    job.status = 'cancelled';
    job.stage = 'Download cancelled';
    job.progress = 0;
    job.expiresAt = Date.now() + 2 * 60_000;
    await removeJobDir(job);
  }

  return sendJson(res, 200, { ok: true });
}

async function serveThumbnail(req, res, id) {
  const thumb = thumbnails.get(id);
  if (!thumb || thumb.expiresAt <= Date.now()) {
    thumbnails.delete(id);
    throw new AppError(404, 'Thumbnail not found.');
  }
  res.writeHead(200, {
    'Content-Type': thumb.type,
    'Content-Length': thumb.buffer.length,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(thumb.buffer);
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match) return null;

  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveJobFile(req, res, id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'ready' || !job.filePath) {
    throw new AppError(404, 'This download is not ready or has expired.');
  }

  let stat;
  try {
    stat = await fsp.stat(job.filePath);
  } catch {
    throw new AppError(404, 'This download has expired. Please download it again.');
  }

  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseRange(rangeHeader, stat.size) : null;
  const inline = new URL(req.url, 'http://localhost').searchParams.get('inline') === '1';
  const filename = job.result?.filename || path.basename(job.filePath);
  const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

  if (rangeHeader && !range) {
    res.writeHead(416, {
      'Content-Range': `bytes */${stat.size}`,
      'Content-Type': 'video/mp4',
    });
    return res.end();
  }

  if (range) {
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, no-store',
    });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(job.filePath, { start: range.start, end: range.end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': disposition,
    'Cache-Control': 'private, no-store',
  });
  if (req.method === 'HEAD') return res.end();
  return createReadStream(job.filePath).pipe(res);
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.includes('..') || relative.includes('\0')) {
    throw new AppError(404, 'Not found.');
  }

  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    throw new AppError(404, 'Not found.');
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new AppError(404, 'Not found.');
  }
  if (!stat.isFile()) throw new AppError(404, 'Not found.');

  const extension = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[extension];
  if (!type) throw new AppError(404, 'Not found.');

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  return createReadStream(filePath).pipe(res);
}

async function handleHealth(req, res) {
  if (ytdlp === null) ytdlp = await ytdlpVersion();
  return sendJson(res, 200, {
    ok: Boolean(ytdlp),
    ytdlp,
    uptime: Math.round(process.uptime()),
    activeJobs,
    queuedJobs: queue.length,
  });
}

async function route(req, res) {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    if (req.url === '/api/health') return;
    const safeUrl = String(req.url || '').split('?')[0];
    log('info', 'request', {
      requestId,
      method: req.method,
      url: safeUrl,
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    throw new AppError(400, 'Invalid URL.');
  }

  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/api/health' && req.method === 'GET') {
    return handleHealth(req, res);
  }
  if (pathname === '/api/resolve' && req.method === 'POST') {
    return handleResolve(req, res);
  }
  if (pathname === '/api/download' && req.method === 'POST') {
    return handleDownload(req, res);
  }
  if (parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const id = parts[2];
    if (parts.length === 3 && req.method === 'GET') return handleGetJob(req, res, id);
    if (parts.length === 3 && req.method === 'DELETE') return handleCancelJob(req, res, id);
    if (parts.length === 4 && parts[3] === 'file' && ['GET', 'HEAD'].includes(req.method)) {
      return serveJobFile(req, res, id);
    }
    throw new AppError(404, 'Not found.');
  }
  if (parts[0] === 'api' && parts[1] === 'thumb' && parts[2]) {
    if (parts.length === 3 && ['GET', 'HEAD'].includes(req.method)) {
      return serveThumbnail(req, res, parts[2]);
    }
    throw new AppError(404, 'Not found.');
  }
  if (parts[0] === 'api') {
    throw new AppError(404, 'Not found.');
  }
  if (pathname === '/robots.txt' && req.method === 'GET') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost:3000';
    const siteUrl = process.env.SITE_URL || `${proto}://${host}`;
    return sendText(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /public/\nSitemap: ${siteUrl}/sitemap.xml\n`, 'text/plain');
  }
  if (pathname === '/sitemap.xml' && req.method === 'GET') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost:3000';
    const siteUrl = process.env.SITE_URL || `${proto}://${host}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${siteUrl}/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>`;
    return sendText(res, 200, xml, 'application/xml');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new AppError(405, 'Method not allowed.');
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    const requestId = res.getHeader('X-Request-Id') || 'unknown';
    if (status >= 500) {
      log('error', 'server error', {
        requestId,
        status,
        message: error?.message,
        stack: error?.stack,
      });
    } else if (status >= 400) {
      log('warn', 'client error', {
        requestId,
        status,
        message: error?.message,
      });
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    const extraHeaders = {};
    if (error instanceof AppError && error.metadata?.rateLimit) {
      const rl = error.metadata.rateLimit;
      extraHeaders['X-RateLimit-Limit'] = String(rl.limit);
      extraHeaders['X-RateLimit-Remaining'] = String(rl.remaining);
      extraHeaders['X-RateLimit-Reset'] = String(Math.ceil(rl.resetAt / 1000));
      extraHeaders['Retry-After'] = String(Math.ceil((rl.resetAt - Date.now()) / 1000));
    }
    sendJson(res, status, {
      error:
        error instanceof AppError
          ? error.message
          : 'Something went wrong on the server. Please try again.',
    }, extraHeaders);
  }
});

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const expired =
      (job.status === 'ready' && job.expiresAt && job.expiresAt <= now) ||
      (['error', 'cancelled'].includes(job.status) && job.expiresAt && job.expiresAt <= now) ||
      (['queued', 'resolving', 'downloading'].includes(job.status) && job.expiresAt && job.expiresAt <= now);
    if (expired) {
      jobs.delete(id);
      if (job.controller && !job.controller.signal.aborted) {
        job.controller.abort();
      }
      removeJobDir(job);
    }
  }
  for (const [shortcode, entry] of resolveCache) {
    if (entry.expiresAt <= now) resolveCache.delete(shortcode);
  }
  for (const [id, thumb] of thumbnails) {
    if (thumb.expiresAt <= now) thumbnails.delete(id);
  }
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

async function main() {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(TMP_ROOT, { recursive: true });

  ytdlp = await ytdlpVersion();
  if (!ytdlp) {
    console.warn('Warning: yt-dlp was not found. Install it before downloading reels.');
  }

  setInterval(cleanup, 60_000).unref();

  server.listen(PORT, HOST, () => {
    console.log(`Reel Downloader running at http://localhost:${PORT}`);
    console.log(`yt-dlp: ${ytdlp || 'not found'} · ffmpeg: ${process.env.FFMPEG_PATH || 'ffmpeg'}`);
  });

  const shutdown = () => {
    console.log('Shutting down…');
    for (const job of jobs.values()) {
      if (['queued', 'resolving', 'downloading'].includes(job.status)) {
        job.cancelled = true;
        job.controller.abort();
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
