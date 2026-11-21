import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFormatSelector,
  summarizeFormats,
  QUALITY_IDS,
} from '../lib/instagram.js';
import { formatBytes } from '../lib/download.js';

test('QUALITY_IDS contains expected values', () => {
  assert.ok(QUALITY_IDS.has('best'));
  assert.ok(QUALITY_IDS.has('source'));
  assert.ok(QUALITY_IDS.has('fast'));
  assert.equal(QUALITY_IDS.size, 3);
});

test('buildFormatSelector returns correct selectors', () => {
  assert.equal(buildFormatSelector('best'), 'bestvideo+bestaudio/best');
  assert.equal(buildFormatSelector('source'), 'bestvideo+bestaudio/best');
  assert.equal(buildFormatSelector('fast'), 'best[ext=mp4]/best');
  // Invalid quality falls back to best selector (no throw)
  assert.equal(buildFormatSelector('invalid'), 'bestvideo+bestaudio/best');
});

test('formatBytes formats correctly', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(-1), '0 MB');
  assert.equal(formatBytes(NaN), '0 MB');
});

test('summarizeFormats handles empty formats', () => {
  const summary = summarizeFormats({ formats: [] });
  assert.equal(summary.qualityHeight, null);
  assert.equal(summary.width, null);
  assert.equal(summary.height, null);
  assert.equal(summary.videoCodec, 'H.264');
  assert.equal(summary.needsTranscode, false);
  assert.equal(summary.hasProgressive, false);
  assert.equal(summary.qualities.length, 1);
  assert.equal(summary.qualities[0].id, 'best');
});

test('summarizeFormats handles missing formats', () => {
  const summary = summarizeFormats({});
  assert.equal(summary.qualityHeight, null);
  assert.equal(summary.qualities.length, 1);
});

test('summarizeFormats identifies progressive MP4', () => {
  const summary = summarizeFormats({
    formats: [
      { ext: 'mp4', vcodec: 'avc1.640028', acodec: 'mp4a.40.2', height: 720, width: 1280 },
    ],
  });
  assert.equal(summary.hasProgressive, true);
  assert.equal(summary.needsTranscode, false);
  assert.equal(summary.videoCodec, 'H.264');
});

test('summarizeFormats identifies VP9 needing transcode', () => {
  const summary = summarizeFormats({
    formats: [
      { ext: 'mp4', vcodec: 'vp09.00.40.08', acodec: 'none', height: 1920, width: 1080 },
      { ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.5' },
      { ext: 'mp4', vcodec: 'avc1.640028', acodec: 'mp4a.40.2', height: 720, width: 1280 },
    ],
  });
  assert.equal(summary.videoCodec, 'VP9');
  assert.equal(summary.needsTranscode, true);
  assert.equal(summary.qualityHeight, 1080);
  assert.deepEqual(
    summary.qualities.map((q) => q.id),
    ['best', 'source', 'fast']
  );
});
