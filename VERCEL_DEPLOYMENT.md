# Vercel Deployment — Compatibility Notice

## Critical Finding

This application **cannot be deployed as a single Vercel serverless function**. The architecture requires long-running `yt-dlp` + `ffmpeg` processes that can take minutes, which exceeds Vercel's function timeouts (10s Hobby / 60s Pro). Additionally, `ffmpeg` and `yt-dlp` binaries are not guaranteed in the Vercel Node.js runtime, and the ephemeral filesystem is unsuitable for temporary video storage.

## Recommended Deployment Options

### Option A: Render / Docker / VPS (Recommended)

The existing `Dockerfile` and `render.yaml` are production-ready for these platforms. Deploy there for the full web UI + download pipeline.

```bash
# Docker
docker build -t reel-downloader .
docker run --rm -p 3000:3000 --name reel-downloader reel-downloader

# Render
# Connect GitHub repo, select "Blueprint", apply render.yaml
```

### Option B: Hybrid Architecture (Vercel Frontend + Separate Worker)

If Vercel is required for the frontend, use a hybrid architecture:

1. **Vercel**: Host the frontend (`public/`) and a lightweight API for job submission and status polling
2. **Worker service** (Render Worker, Railway, Fly.io, or VPS): Run the `server.js` download pipeline with `yt-dlp` + `ffmpeg`
3. **Shared job store**: Redis or database for job state shared between Vercel API and worker

This requires architectural changes beyond the scope of this audit. The current codebase uses in-memory job state (`Map`) which does not work across distributed instances.

## Environment Variables for Production

| Variable | Production Value | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `MAX_CONCURRENT` | `2` | Adjust based on worker capacity |
| `MAX_QUEUED` | `40` | |
| `JOB_TTL_MIN` | `30` | |
| `RESOLVE_TTL_MIN` | `10` | |
| `TMP_DIR` | `/tmp/reel-downloader` | Writable temp directory |
| `YTDLP_PATH` | `yt-dlp` | Must be installed on the host |
| `FFMPEG_PATH` | `ffmpeg` | Must be installed on the host |
| `COOKIES_FILE` | Optional | For auth-required reels |
| `TRUST_PROXY` | `1` | If behind a reverse proxy |

## What Does Not Work on Vercel

- Long-running download jobs (>10s)
- `ffmpeg` / `ffprobe` binary execution
- Persistent temp file storage
- In-memory rate limiting across instances
- Server-sent events or long-lived connections

## Files Modified for This Phase

None — no code changes can make yt-dlp + ffmpeg work reliably in Vercel serverless functions. The limitation is documented here instead.
