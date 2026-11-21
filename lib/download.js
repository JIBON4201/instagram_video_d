import { spawn, execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG, FFPROBE, YTDLP, baseArgs } from './ytdlp.js';
import { AppError, buildFormatSelector } from './instagram.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov']);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000);

function abortError() {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function lineReader(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
      if (line.trim()) onLine(line);
    }
  };
}

/**
 * Spawn a process, stream its output line-by-line, and clean up the whole
 * process group on abort or timeout.
 */
function runProcess(command, args, { signal, onLine, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());

    const isYtDlp = process.platform === 'win32' && command === YTDLP;
    const spawnCommand = isYtDlp ? 'python' : process.platform === 'win32' ? 'cmd.exe' : command;
    const spawnArgs = isYtDlp
      ? ['-m', 'yt_dlp', ...args]
      : process.platform === 'win32'
      ? ['/c', command, ...args]
      : args;

    const child = spawn(spawnCommand, spawnArgs, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    let settled = false;
    let timedOut = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    const onAbort = () => {
      killTree(child);
      finish(abortError());
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(
        new AppError(504, `${label || 'The download'} took too long and was stopped.`),
      );
    }, timeoutMs || DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();

    signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line, fromStderr = false) => {
      if (fromStderr && stderr.length < 500_000) stderr += `${line}\n`;
      try {
        onLine?.(line);
      } catch {
        /* progress handlers must never break a download */
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < 2_000_000) stdout += text;
      lineReader((line) => handleLine(line, false))(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      lineReader((line) => handleLine(line, true))(text);
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(
          new AppError(
            503,
            command === YTDLP
              ? 'yt-dlp is not installed on the server.'
              : 'ffmpeg is not installed on the server.',
          ),
        );
        return;
      }
      finish(error);
    });

    child.on('close', (code) => {
      if (signal?.aborted) return finish(abortError());
      if (timedOut) return;
      if (code === 0) return finish();
      const lines = stderr.trim().split('\n').filter(Boolean);
      const detail = lines.slice(-3).join('\n').replace(/\s+at\s+/g, ' ').slice(0, 500);
      const suffix = detail ? `: ${detail}` : '';
      const error = new AppError(502, `${label || 'The download'} failed${suffix}`);
      error.stderr = stderr.slice(0, 2000);
      finish(error);
    });
  });
}

function parseDuration(text) {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  return h * 3600 + m * 60 + s;
}

function parseStreamInfo(text) {
  const videoMatch = text.match(/Video: (\w+).*?,\s*(\d+)x(\d+),\s*/);
  const audioMatch = text.match(/Stream #\d+:\d+.*?Audio: (\w+)/);
  return {
    videoCodec: videoMatch ? videoMatch[1] : null,
    width: videoMatch ? Number(videoMatch[2]) : null,
    height: videoMatch ? Number(videoMatch[3]) : null,
    audioCodec: audioMatch ? audioMatch[1] : null,
  };
}

function probeFile(file) {
  return new Promise(async (resolve, reject) => {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (error) {
      const err = new AppError(500, 'Could not inspect the downloaded video.');
      err.stderr = error?.message || '';
      err.cmd = `stat ${file}`;
      return reject(err);
    }
    if (!stat.isFile() || stat.size <= 0) {
      const err = new AppError(500, 'The downloaded video file is empty or unreadable.');
      err.cmd = `stat ${file}`;
      return reject(err);
    }

    const probeArgs = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ];
    const cmd = `${FFMPEG} ${probeArgs.join(' ')}`;

    if (process.platform === 'win32') {
      const child = spawn(FFMPEG, ['-i', file, '-f', 'null', '-'], {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code !== 0) {
          const err = new AppError(500, 'Could not inspect the downloaded video.');
          err.stderr = stderr;
          err.code = code;
          err.cmd = cmd;
          return reject(err);
        }
        const duration = parseDuration(stderr);
        const streams = parseStreamInfo(stderr);
        resolve({
          format: { duration: duration ? String(duration) : null, size: null },
          streams: [
            {
              codec_type: 'video',
              codec_name: streams.videoCodec,
              width: streams.width,
              height: streams.height,
            },
            {
              codec_type: 'audio',
              codec_name: streams.audioCodec,
            },
          ].filter((s) => s.codec_name),
        });
      });
      child.on('error', (error) => {
        const err = new AppError(500, 'Could not inspect the downloaded video.');
        err.stderr = error?.message || '';
        err.code = error?.code;
        err.cmd = cmd;
        return reject(err);
      });
      return;
    }

    const ffprobeArgs = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ];

    execFile(
      FFPROBE,
      ffprobeArgs,
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          try {
            return resolve(JSON.parse(stdout));
          } catch {
            /* fall through to ffmpeg probe */
          }
        }

        execFile(
          FFMPEG,
          probeArgs,
          { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
          (error2, stdout2, stderr2) => {
            if (!error2) {
              try {
                return resolve(JSON.parse(stdout2));
              } catch {
                /* fall through to null muxer fallback */
              }
            }

            const child = spawn(FFMPEG, ['-i', file, '-f', 'null', '-'], {
              timeout: 30_000,
              maxBuffer: 16 * 1024 * 1024,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr3 = '';
            child.stderr.on('data', (d) => (stderr3 += d.toString()));
            child.on('close', (code) => {
              if (code !== 0) {
                const err = new AppError(500, 'Could not inspect the downloaded video.');
                err.stderr =
                  (error?.stderr || stderr || '') +
                  '\n' +
                  (error2?.stderr || stderr2 || '') +
                  '\n' +
                  stderr3;
                err.stdout =
                  (error?.stdout || stdout || '') +
                  '\n' +
                  (error2?.stdout || stdout2 || '');
                err.code = error2?.code ?? error?.code;
                err.signal = error2?.signal ?? error?.signal;
                err.cmd = cmd;
                return reject(err);
              }
              const duration = parseDuration(stderr3);
              const streams = parseStreamInfo(stderr3);
              resolve({
                format: { duration: duration ? String(duration) : null, size: null },
                streams: [
                  {
                    codec_type: 'video',
                    codec_name: streams.videoCodec,
                    width: streams.width,
                    height: streams.height,
                  },
                  {
                    codec_type: 'audio',
                    codec_name: streams.audioCodec,
                  },
                ].filter((s) => s.codec_name),
              });
            });
            child.on('error', (error3) => {
              const err = new AppError(500, 'Could not inspect the downloaded video.');
              err.stderr =
                (error?.stderr || stderr || '') +
                '\n' +
                (error2?.stderr || stderr2 || '') +
                '\n' +
                (error3?.message || '');
              err.code = error2?.code ?? error?.code ?? error3?.code;
              err.signal = error2?.signal ?? error?.signal;
              err.cmd = cmd;
              return reject(err);
            });
          },
        );
      },
    );
  });
}

function describeMedia(probe) {
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new AppError(422, 'The downloaded file does not contain a video.');

  return {
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    duration: Number(probe.format?.duration) || Number(video.duration) || null,
    videoCodec: video.codec_name || null,
    audioCodec: audio?.codec_name || null,
    size: Number(probe.format?.size) || null,
    bitrate: Number(probe.format?.bit_rate) || null,
  };
}

function niceCodec(codec) {
  const value = String(codec || '').toLowerCase();
  if (value === 'h264') return 'H.264';
  if (value === 'vp9') return 'VP9';
  if (value === 'av1') return 'AV1';
  if (value === 'hevc') return 'HEVC';
  if (value === 'aac') return 'AAC';
  if (value === 'opus') return 'Opus';
  return value ? value.toUpperCase() : 'Unknown';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

async function findSourceFile(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name));

  if (!candidates.length) {
    throw new AppError(500, 'The download finished but no video file was produced.');
  }

  // Prefer the merged file that yt-dlp names source.mp4, otherwise take the
  // largest video file in the job directory.
  const merged = candidates.find((file) => path.basename(file) === 'source.mp4');
  const target = merged || (await (async () => {
    const stats = await Promise.all(
      candidates.map(async (file) => ({ file, size: (await fsp.stat(file)).size })),
    );
    stats.sort((a, b) => b.size - a.size);
    return stats[0].file;
  })());

  // Validate the selected file is readable and non-empty before returning it.
  const stat = await fsp.stat(target);
  if (!stat.isFile() || stat.size <= 0) {
    throw new AppError(500, 'The downloaded video file is empty or unreadable.');
  }
  return target;
}

function ffmpegProgress(onLine, duration) {
  return (line) => {
    const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
    if (!match || !duration) return;
    const seconds = Number(match[1]) / 1_000_000;
    const fraction = Math.max(0, Math.min(1, seconds / duration));
    onLine(fraction);
  };
}

async function remux(input, output, { signal, duration, onProgress }) {
  onProgress({ stage: 'Finalizing MP4…', progress: 92, detail: '' });
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
  const progress = ffmpegProgress((fraction) => {
    onProgress({ stage: 'Finalizing MP4…', progress: 92 + fraction * 7, detail: '' });
  }, duration);
  await runProcess(FFMPEG, args, {
    signal,
    timeoutMs: 2 * 60 * 1000,
    label: 'Finalizing the video',
    onLine: progress,
  });
}

async function transcode(input, output, { signal, duration, onProgress }) {
  onProgress({ stage: 'Converting to H.264…', progress: 68, detail: 'This keeps it playable everywhere' });
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    output,
  ];
  const progress = ffmpegProgress((fraction) => {
    onProgress({ stage: 'Converting to H.264…', progress: 68 + fraction * 31, detail: '' });
  }, duration);
  await runProcess(FFMPEG, args, {
    signal,
    timeoutMs: 8 * 60 * 1000,
    label: 'Converting the video',
    onLine: progress,
  });
}

/**
 * Download one reel and return a ready-to-serve MP4.
 *
 * quality:
 *   best   - highest source, converted to H.264 when necessary (default)
 *   source - highest source, remuxed without re-encoding
 *   fast   - progressive MP4, quickest download / smallest file
 */
export async function downloadReel({
  url,
  quality = 'best',
  dir,
  onProgress = () => {},
  signal,
  preferProgressive = false,
}) {
  await fsp.mkdir(dir, { recursive: true });
  const sourceBase = path.join(dir, 'source');
  const finalPath = path.join(dir, 'final.mp4');
  let lastDownloaded = 0;
  let lastPercent = 0;
  let currentTrack = 'video';

  const emit = (payload) => {
    try {
      onProgress(payload);
    } catch {
      /* ignore */
    }
  };

  emit({ stage: 'Starting download…', progress: 2, detail: '' });

  const args = [
    ...baseArgs(),
    '--concurrent-fragments',
    '3',
    '--newline',
    '--progress',
    '--progress-template',
    'download:PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.eta)s|%(progress.speed)s',
    '-f',
    buildFormatSelector(quality, preferProgressive),
    '--merge-output-format',
    'mp4',
    '--no-mtime',
    '-o',
    `${sourceBase}.%(ext)s`,
    url,
  ];

  await runProcess(YTDLP, args, {
    signal,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    label: 'The download',
    onLine: (line) => {
      if (line.startsWith('[download] Destination:')) {
        const file = line.slice('[download] Destination:'.length).trim();
        const isAudio = /\.(m4a|mp3|opus|ogg|aac)$/i.test(file);
        currentTrack = isAudio ? 'audio' : 'video';
        lastDownloaded = 0;
        emit({
          stage: `Downloading ${currentTrack}…`,
          progress: Math.max(5, lastPercent),
          detail: '',
        });
        return;
      }

      if (line.startsWith('PROGRESS|')) {
        const [, bytes, total] = line.split('|');
        const downloaded = Number(bytes);
        const totalBytes = Number(total);
        if (Number.isFinite(downloaded)) lastDownloaded = downloaded;
        if (Number.isFinite(totalBytes) && totalBytes > 0 && Number.isFinite(downloaded)) {
          const percent = Math.max(4, Math.min(62, (downloaded / totalBytes) * 62));
          lastPercent = Math.max(lastPercent, percent);
          emit({
            stage: `Downloading ${currentTrack}…`,
            progress: lastPercent,
            detail: `${formatBytes(downloaded)} of ${formatBytes(totalBytes)}`,
          });
        } else if (Number.isFinite(downloaded)) {
          emit({
            stage: `Downloading ${currentTrack}…`,
            progress: null,
            detail: `${formatBytes(downloaded)} downloaded`,
          });
        }
        return;
      }

      if (line.includes('[Merger]')) {
        emit({ stage: 'Merging video and audio…', progress: 64, detail: '' });
      }
    },
  });

  const source = await findSourceFile(dir);
  const sourceProbe = describeMedia(await probeFile(source));
  const sourceIsH264 = sourceProbe.videoCodec === 'h264';
  const audioIsAac = !sourceProbe.audioCodec || sourceProbe.audioCodec === 'aac';
  const sourceExt = path.extname(source).toLowerCase();

  emit({ stage: 'Preparing video…', progress: 66, detail: '' });

  let outputPath = finalPath;
  let outputProbe = sourceProbe;
  let usedFfmpeg = false;

  // Fast quality: if source is already MP4 with H.264 video, skip ffmpeg entirely
  if (quality === 'fast' && sourceExt === '.mp4' && sourceIsH264 && audioIsAac) {
    await fsp.copyFile(source, outputPath);
    usedFfmpeg = false;
  } else if (quality === 'best' && (!sourceIsH264 || !audioIsAac)) {
    await transcode(source, finalPath, {
      signal,
      duration: sourceProbe.duration,
      onProgress: emit,
    });
    usedFfmpeg = true;
  } else {
    try {
      await remux(source, finalPath, {
        signal,
        duration: sourceProbe.duration,
        onProgress: emit,
      });
      usedFfmpeg = true;
    } catch (error) {
      if (isAbort(error)) throw error;
      await transcode(source, finalPath, {
        signal,
        duration: sourceProbe.duration,
        onProgress: emit,
      });
      usedFfmpeg = true;
    }
  }

  // Skip redundant second probeFile: we know output properties from source + operation
  const outputStat = await fsp.stat(outputPath);
  if (!outputStat.isFile() || outputStat.size <= 0) {
    throw new AppError(500, 'The final video file is empty or unreadable.');
  }

  if (usedFfmpeg && quality === 'best' && (!sourceIsH264 || !audioIsAac)) {
    outputProbe = {
      ...sourceProbe,
      videoCodec: 'h264',
      audioCodec: 'aac',
      size: outputStat.size,
    };
  }

  emit({ stage: 'Done', progress: 100, detail: '' });

  await fsp.rm(source, { force: true }).catch(() => {});

  return {
    filePath: outputPath,
    size: outputProbe.size || outputStat.size,
    width: outputProbe.width,
    height: outputProbe.height,
    duration: outputProbe.duration,
    videoCodec: niceCodec(outputProbe.videoCodec),
    audioCodec: outputProbe.audioCodec ? niceCodec(outputProbe.audioCodec) : null,
    quality,
  };
}

export { isAbort };
