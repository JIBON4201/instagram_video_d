#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  QUALITY_IDS,
  extractReel,
  normalizeReelUrl,
} from './lib/instagram.js';
import { downloadReel, isAbort } from './lib/download.js';

const HELP = `
Reel Downloader CLI

Usage:
  node cli.js <instagram-url> [options]
  npm link && reel-downloader <instagram-url> [options]

Options:
  -q, --quality <best|source|fast>  Quality preset (default: best)
  -o, --out <dir>                   Output directory (default: current directory)
  -h, --help                        Show this help

Examples:
  node cli.js "https://www.instagram.com/reel/DeVzrhxziNB/"
  node cli.js "https://www.instagram.com/reel/DeVzrhxziNB/" -q source -o ~/Videos
`;

function humanSize(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function safePart(value, fallback) {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

async function uniquePath(dir, filename) {
  const extension = path.extname(filename);
  const base = path.basename(filename, extension);
  let candidate = path.join(dir, filename);
  let counter = 2;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base}-${counter}${extension}`);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      quality: { type: 'string', short: 'q', default: 'best' },
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || !positionals.length) {
    console.log(HELP.trim());
    process.exit(values.help ? 0 : 1);
  }

  const quality = values.quality;
  if (!QUALITY_IDS.has(quality)) {
    throw new Error(`Unknown quality "${quality}". Use best, source, or fast.`);
  }

  const sourceUrl = normalizeReelUrl(positionals[0]);
  const outDir = path.resolve(values.out || process.cwd());
  await fsp.mkdir(outDir, { recursive: true });

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reel-dl-'));
  const controller = new AbortController();
  process.on('SIGINT', () => {
    controller.abort();
    console.log('\nCancelling…');
  });

  let lastStage = '';
  let lastPercent = -1;
  const draw = (text) => {
    if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${text}`);
    lastStage = text;
  };

  try {
    console.log('Fetching reel details…');
    const meta = await extractReel(sourceUrl);
    const firstLine = String(meta.description || meta.title || '')
      .split('\n')
      .find((line) => line.trim());
    console.log(`@${meta.authorHandle}${firstLine ? ` — ${firstLine.slice(0, 90)}` : ''}`);
    console.log(`Downloading (${quality})…`);

    const result = await downloadReel({
      url: sourceUrl,
      quality,
      dir: workDir,
      signal: controller.signal,
      onProgress: (update) => {
        if (update.progress !== undefined && update.progress !== null) {
          const percent = Math.round(update.progress);
          const bucket = Math.floor(percent / 25) * 25;
          if (process.stdout.isTTY) {
            draw(`${update.stage} ${percent}% ${update.detail || ''}`.trim());
          } else if (update.stage !== lastStage || bucket !== lastPercent) {
            console.log(`${update.stage} ${percent}% ${update.detail || ''}`.trim());
            lastStage = update.stage;
            lastPercent = bucket;
          }
        } else if (update.stage !== lastStage) {
          const line = `${update.stage} ${update.detail || ''}`.trim();
          if (process.stdout.isTTY) draw(line);
          else console.log(line);
          lastStage = update.stage;
        }
      },
    });

    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');

    const shortSide = result.width && result.height ? Math.min(result.width, result.height) : null;
    const filename = `${safePart(meta.authorHandle, 'instagram')}-${safePart(
      meta.shortcode,
      'reel',
    )}-${shortSide ? `${shortSide}p` : 'video'}.mp4`;
    const destination = await uniquePath(outDir, filename);
    await fsp.copyFile(result.filePath, destination);

    console.log(`Saved ${destination}`);
    console.log(
      `  ${result.width || '?'}×${result.height || '?'} · ${humanSize(result.size)} · ${
        result.videoCodec
      }${result.audioCodec ? ` + ${result.audioCodec}` : ''}`,
    );
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  if (isAbort(error)) {
    console.error('Cancelled.');
    process.exit(130);
  }
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
