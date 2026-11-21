import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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
    const target = path.join(os.tmpdir(), `reel-downloader-cookies-${process.pid}-${crypto.randomUUID().slice(0, 8)}.txt`);
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
    '--concurrent-fragments',
    '3',
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
    const allArgs = [...baseArgs(), ...args];
    if (process.platform === 'win32') {
      const child = spawn('python', ['-m', 'yt_dlp', ...allArgs], {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code === 0) return resolve({ stdout, stderr });
        const error = new Error(`Command failed with exit code ${code}`);
        error.stderr = stderr.slice(0, 2000);
        error.stdout = stdout.slice(0, 2000);
        return reject(error);
      });
      child.on('error', reject);
      return;
    }
    execFile(
      YTDLP,
      allArgs,
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
    if (process.platform === 'win32') {
      const child = spawn('python', ['-m', 'yt_dlp', '--version'], {
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.on('close', () => resolve(String(stdout).trim()));
      child.on('error', () => resolve(null));
      return;
    }
    execFile(YTDLP, ['--version'], { timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).trim());
    });
  });
}
