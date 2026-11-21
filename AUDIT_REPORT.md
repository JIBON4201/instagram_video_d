# Production Audit Report — Instagram Reel Downloader

**Project:** `reel-downloader` (Instagram video downloader)
**Location:** `C:\Users\Dev\Documents\instagram video downloader`
**Date:** 2026-11-21
**Auditor:** Kilo (Senior Full-Stack / AppSec / DevOps)

---

## Executive Summary

The application is a working, self-hosted Instagram reel downloader with a polished web UI and CLI. It uses **pure Node.js** (stdlib only) plus external `yt-dlp` and `ffmpeg` binaries. It is **not** Next.js/TypeScript as the task brief assumed — there is no build step, no TypeScript, and no frontend framework.

**Critical finding:** The architecture is fundamentally mismatched with Vercel serverless constraints. Vercel functions are ephemeral, have execution timeouts (10s hobby / 60s pro), no guaranteed `ffmpeg`/`yt-dlp` binaries, no persistent filesystem, and distributed instances (in-memory rate limits don't work). A long-running download (yt-dlp + ffmpeg transcode can take minutes) cannot reliably run inside a single Vercel function invocation.

Recommendation: Keep the current architecture for **self-hosted / Docker / Render** deployment (as documented in the existing README). If Vercel is mandatory, a hybrid architecture is required — e.g., a long-running worker service for yt-dlp/ffmpeg processing with a thin Vercel frontend for job submission and status polling. This audit documents both paths.

---

## Phase 1 — Complete Project Audit

### File Inventory

| File | Lines | Role |
|------|-------|------|
| `server.js` | 691 | HTTP server, job queue, rate limiting, API routes, static serving |
| `cli.js` | 170 | CLI downloader entry point |
| `lib/env.js` | 38 | Minimal `.env` loader |
| `lib/instagram.js` | 290 | URL validation, normalization, yt-dlp metadata, quality logic, error mapping |
| `lib/ytdlp.js` | 114 | yt-dlp/ffmpeg discovery, cookie handling, `runYtDlp`, version check |
| `lib/download.js` | 530 | Download, merge, transcode, progress, probe, abort/timeout |
| `public/index.html` | 270 | Frontend HTML |
| `public/app.js` | 654 | Frontend vanilla JS (polling, progress, recent history) |
| `public/styles.css` | 1395 | Frontend CSS |
| `public/favicon.svg` | — | Favicon |
| `public/fonts/inter-var.woff2` | — | Self-hosted Inter font |
| `test/url.test.js` | 139 | 9 unit tests (URL validation, format selectors) |
| `package.json` | 37 | Manifest, scripts (`start`, `dev`, `check`, `test`) |
| `Dockerfile` | 25 | Container build (node:22-slim, python3-pip yt-dlp, ffmpeg) |
| `render.yaml` | 16 | Render blueprint |
| `.dockerignore` | 12 | Docker ignore rules |
| `.gitignore` | 10 | Git ignore rules |
| `.env.example` | 31 | Example environment config |
| `README.md` | 319 | Documentation |
| `LICENSE` | 21 | MIT license |

---

### Architecture Overview

1. Client submits Instagram URL → `POST /api/resolve` → yt-dlp `--dump-single-json` → metadata + thumbnail
2. Client picks quality → `POST /api/download` → job enqueued → `yt-dlp` download → `ffmpeg` remux/transcode → MP4 in temp dir
3. Client polls `GET /api/jobs/:id` for progress
4. Client downloads `GET /api/jobs/:id/file` (range-supported streaming)
5. `DELETE /api/jobs/:id` cancels and cleans up
6. `GET /api/health` health check

---

### Bugs & Issues Found

| # | Location | Severity | Issue |
|---|----------|----------|-------|
| B1 | `server.js:24` | Medium | `JOB_TTL_MS` uses `JOB_TTL_MIN` env var but README documents `JOB_TTL_MIN` — consistent, but `RESOLVE_TTL_MS` uses `RESOLVE_TTL_MIN` |
| B2 | `server.js:36` | Medium | `activeJobs` incremented in `pump()` without awaiting job start — race possible if `runJob` throws synchronously before `activeJobs` decrement |
| B3 | `server.js:37` | Low | `ytdlp` variable declared but reassigned in `main()` and `handleHealth()` — minor, works |
| B4 | `lib/download.js:188-211` | High | Windows `probeFile` uses `spawn(FFMPEG, ['-i', file, ...])` but `FFMPEG` may be `ffmpeg.exe` — works on Windows PATH, but `FFPROBE` constant in `ytdlp.js` is unused on Windows path |
| B5 | `lib/download.js:478` | Medium | `findSourceFile` prefers `source.mp4` but yt-dlp output filename is `${sourceBase}.%(ext)s` — may not produce `source.mp4`; falls back to largest video file, which is acceptable |
| B6 | `lib/download.js:516` | Low | `await fsp.rm(source, ...)` after return value constructed — if source was already renamed/moved, this is a no-op (catch swallows error) |
| B7 | `server.js:654-654` | Medium | `cleanup()` runs every 60s but jobs with `expiresAt` null (queued/resolving/downloading) are never cleaned by TTL — only on cancel or error |
| B8 | `lib/instagram.js:42` | Medium | `extractUrlFromText` called twice in some paths (line 42 and 44) — harmless but redundant |
| B9 | `public/app.js:177` | Low | `resetDownloadPanels` DELETEs previous job on every new resolve — abandons in-progress download without user confirmation |
| B10 | `public/app.js:302` | Medium | `resolveReel` doesn't validate URL client-side before POST — relies on server validation (acceptable, but no early feedback) |

---

### Security Findings

| # | Location | Severity | Issue |
|---|----------|----------|-------|
| S1 | `lib/instagram.js:11-16` | **Good** | URL allowlist restricted to `instagram.com` hosts — SSRF protection is present |
| S2 | `server.js:82-90` | **Good** | `clientIp` respects `TRUST_PROXY` for `X-Forwarded-For` |
| S3 | `server.js:92-104` | **Good** | Per-IP rate limiting (resolve: 60/min, download: 8/min) |
| S4 | `server.js:26` | **Good** | Request body limit 32KB |
| S5 | `server.js:563-570` | **Good** | CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy headers |
| S6 | `server.js:513-520` | **Good** | Path traversal protection in `serveStatic` (`..` and null byte checks, prefix validation) |
| S7 | `server.js:476` | Medium | `asciiName` sanitization for Content-Disposition filename — reasonable but `filename*` UTF-8 fallback still uses raw filename |
| S8 | `lib/ytdlp.js:24-33` | Low | Cookie file written to fixed temp path `reel-downloader-cookies.txt` with mode 0600 — if multiple instances run concurrently, race on cookie file write |
| S9 | `server.js:560` | **Info** | Request URL logged (minus query) — could log sensitive URLs if query contained tokens (Instagram URLs don't typically have secrets, but share codes could be sensitive) |
| S10 | `lib/download.js:101-102` | Low | stderr buffered up to 500KB and included in error messages — could leak yt-dlp debug output |
| S11 | `lib/download.js:112` | Low | stdout buffered up to 2MB — memory bound per request |

**Missing security controls:**
- No CSRF protection (same-origin API, but no `SameSite` cookie considerations since no cookies used)
- No `Strict-Transport-Security` header (relevant if served over HTTPS behind a proxy)
- No `Content-Security-Policy` `connect-src` restriction to same origin only — currently `'self'` which is good
- No request ID / correlation ID for distributed tracing
- Rate limiting is **in-memory only** — does not work across distributed serverless instances

---

### Performance Findings

| # | Location | Severity | Issue |
|---|----------|----------|-------|
| P1 | `server.js:31-35` | Medium | All state (jobs, queue, cache, rate buckets) in memory — doesn't survive restart, doesn't scale horizontally |
| P2 | `server.js:130-151` | Medium | Thumbnail fetched server-side and buffered entirely (max 8MB) — adds latency to resolve endpoint |
| P3 | `lib/download.js:112,101` | Medium | stdout/stderr buffered in memory (2MB / 500KB) per download |
| P4 | `lib/download.js:478-488` | Medium | `probeFile` spawns ffmpeg/ffprobe per download — adds ~1-3s latency |
| P5 | `lib/download.js:331-381` | High | Transcode path (`libx264`) can take minutes — blocks a job slot for the duration |
| P6 | `public/app.js:375-427` | Medium | Polling every 850ms — acceptable for UX but creates steady load |

---

### Vercel Compatibility (Critical)

The task requires Vercel deployment. The current architecture is **not compatible** with Vercel serverless functions without major changes:

| Constraint | Current App | Vercel Reality |
|---|---|---|
| Execution model | Long-running Node server | Serverless functions, ephemeral |
| Max duration | Unlimited (process stays up) | 10s (hobby) / 60s (pro) |
| yt-dlp binary | Assumed on PATH | Not guaranteed; must be packaged or layered |
| ffmpeg binary | Assumed on PATH | Not guaranteed in Node runtime |
| Filesystem | Persistent temp dir | Ephemeral `/tmp` only (512MB) |
| Rate limiting | In-memory Map | Distributed instances — in-memory fails |
| WebSockets/long polling | HTTP polling works | Works, but function cold starts add latency |
| Streaming | `createReadStream.pipe(res)` | Supported, but response size limits apply |

**Verdict:** The current monolithic Node server cannot be deployed to Vercel as-is. Options:
1. **Deploy elsewhere** (Render, Railway, Docker VPS, Fly.io) — matches existing `Dockerfile` and `render.yaml`
2. **Hybrid Vercel:** Vercel frontend + API for job submission, separate long-running worker for yt-dlp/ffmpeg
3. **Vercel + external processing:** Offload download to a worker queue (not implemented)

---

### Dependencies

**Runtime dependencies (external binaries, not npm):**
- `yt-dlp` — Instagram extraction (Python package)
- `ffmpeg` / `ffprobe` — merge, transcode, probe

**npm dependencies:** None (`"type": "module"`, stdlib only). This is a strength — no supply-chain risk from npm packages.

**Dev/test dependencies:** None — uses `node:test` built-in.

---

### Environment Variables

| Variable | Default | Required? | Notes |
|---|---|---|---|
| `PORT` | 3000 | No | |
| `HOST` | 0.0.0.0 | No | |
| `MAX_CONCURRENT` | 2 | No | |
| `MAX_QUEUED` | 40 | No | |
| `JOB_TTL_MIN` | 30 | No | |
| `RESOLVE_TTL_MIN` | 10 | No | |
| `TMP_DIR` | os tmpdir | No | |
| `YTDLP_PATH` | yt-dlp | No | |
| `FFMPEG_PATH` | ffmpeg | No | |
| `FFPROBE_PATH` | derived | No | |
| `COOKIES_FILE` | — | No | Optional |
| `INSTAGRAM_COOKIES_B64` | — | No | Optional |
| `TRUST_PROXY` | — | No | |
| `DOWNLOAD_TIMEOUT_MS` | 600000 | No | |

No secrets are hardcoded. `.env` is gitignored. Good.

---

### SEO

- `index.html` has `<title>`, `description` meta, `og:title`, `og:description`, `og:type`
- Missing: `og:image`, `twitter:card`, `twitter:title`, `twitter:description`, `canonical` link, `robots.txt`, `sitemap.xml`
- Heading hierarchy: `<h1>` in hero, `<h2>` in result panel, `<h3>` in steps — reasonable
- Semantic HTML: `<form>`, `<button>`, `<fieldset>`, `<legend>`, `<main>`, `<footer>`, `<header>` — good

---

### Frontend

- Vanilla JS, no build step — good for simplicity
- Responsive CSS with media queries (820px, 680px, 400px)
- Loading states, error panels, toast notifications
- Clipboard paste, recent history in localStorage
- Accessibility: `aria-label`, `aria-hidden`, `sr-only`, `type="button"` on non-submit buttons
- Missing: `lang` attribute present (`en`), `theme-color` meta present

---

### Testing

- 9 unit tests in `test/url.test.js` covering URL normalization, shortcode extraction, format selectors, summarization
- No integration tests, no security tests, no performance tests
- `npm run check` runs `node --check` syntax validation on all JS files
- `npm test` runs `node --test`

---

## Phase 2-11 Readiness

The audit identifies the following work streams:

1. **Download engine** — Generally solid. Needs: better source file detection, TTL cleanup for non-terminal jobs, ffprobe error handling.
2. **Security** — SSRF protection is good. Needs: HSTS, request IDs, distributed rate limiting (Vercel), stderr sanitization.
3. **Vercel** — Not compatible as-is. Needs architectural decision.
4. **Rate limiting** — In-memory only. Needs Redis/external for distributed.
5. **Frontend** — Generally good. Needs: SEO meta tags, `robots.txt`, `sitemap.xml`, legal pages.
6. **SEO** — Missing canonical, OG image, Twitter cards, robots.txt, sitemap.xml.
7. **Legal** — No privacy policy, terms, copyright, contact, about pages.
8. **Logging** — Basic console.log only. Needs structured logging, health check (exists).
9. **Testing** — Unit tests only. Needs integration, security, production tests.
10. **Deployment** — Docker/Render ready. Vercel not compatible without architectural changes.

---

## Recommendation

**Do not force this into Vercel serverless functions.** The yt-dlp + ffmpeg download pipeline requires a long-running process with persistent temp storage and external binaries — incompatible with Vercel's 10s/60s timeout and ephemeral filesystem.

**Recommended path:** Deploy on Render (as configured in `render.yaml`), Docker, or a VPS. The existing `Dockerfile` and `render.yaml` are production-ready for these platforms.

If Vercel is strictly required, implement a **hybrid architecture**: Vercel for the frontend + lightweight API (job submission, status), with a separate long-running worker service (Render worker, Railway, or VPS) handling yt-dlp/ffmpeg processing via a message queue.

---

## Files to be Modified (Planned)

1. `server.js` — Add request IDs, structured logging, HSTS, TTL cleanup for all job states, stderr sanitization
2. `lib/instagram.js` — Remove redundant `extractUrlFromText` call
3. `lib/download.js` — Fix source file detection, improve ffprobe error handling
4. `lib/ytdlp.js` — Fix cookie file race (unique temp file per instance)
5. `public/index.html` — Add SEO meta tags, canonical link, OG/Twitter tags
6. `public/app.js` — Add client-side URL validation, avoid auto-cancelling previous job
7. `public/styles.css` — Minor accessibility fixes if needed
8. `test/` — Add integration and security tests
9. `PRIVACY.md`, `TERMS.md`, `COPYRIGHT.md`, `CONTACT.md`, `ABOUT.md` — Legal pages
10. `package.json` — Add test scripts if needed
11. `README.md` — Document Vercel limitation and deployment options
