import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import './env.js';

export const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE =
  process.env.FFPROBE_PATH ||
  (path.basename(FFMPEG) === 'ffmpeg'
    ? path.join(path.dirname(FFMPEG) === '.' ? '' : path.dirname(FFMPEG), 'ffprobe')
    : 'ffprobe');

let cookieFile = null;

/**
 * Cookies are optional. Public reels normally work without them, but a
 * logged-in cookie file helps when Instagram asks for authentication.
 *
 * Accepts either a path (COOKIES_FILE) or a base64-encoded Netscape cookie
 * file (INSTAGRAM_COOKIES_B64) which is written to a private temp file.
 */
export function getCookiesFile() {
  if (process.env.COOKIES_FILE) return process.env.COOKIES_FILE;
  if (process.env.INSTAGRAM_COOKIES_B64 && !cookieFile) {
    const target = path.join(os.tmpdir(), 'reel-downloader-cookies.txt');
    fs.writeFileSync(target, Buffer.from(process.env.INSTAGRAM_COOKIES_B64, 'base64'), {
      mode: 0o600,
    });
    cookieFile = target;
  }
  return cookieFile;
}

export function cookieArgs() {
  const file = getCookiesFile();
  return file ? ['--cookies', file] : [];
}

export function baseArgs() {
  return [
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout',
    '15',
    '--retries',
    '3',
    '--extractor-retries',
    '2',
    ...cookieArgs(),
  ];
}

/** Run yt-dlp once and buffer its output. Used for metadata extraction. */
export function runYtDlp(args, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      [...baseArgs(), ...args],
      { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          error.stdout = stdout;
          return reject(error);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function ytdlpVersion() {
  return new Promise((resolve) => {
    execFile(YTDLP, ['--version'], { timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).trim());
    });
  });
}
