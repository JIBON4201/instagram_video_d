import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFormatSelector,
  normalizeReelUrl,
  shortcodeFromUrl,
  summarizeFormats,
} from '../lib/instagram.js';

test('normalizes a reel link and strips tracking parameters', () => {
  assert.equal(
    normalizeReelUrl(
      'https://www.instagram.com/reel/DeVzrhxziNB/?exln=bXg3a3VrbzI1ZnEw&utm_source=ig_web_copy_link',
    ),
    'https://www.instagram.com/reel/DeVzrhxziNB/',
  );
});

test('normalizes post kinds and mobile hosts', () => {
  assert.equal(
    normalizeReelUrl('https://m.instagram.com/reels/ABC_123-xyz/'),
    'https://www.instagram.com/reel/ABC_123-xyz/',
  );
  assert.equal(
    normalizeReelUrl('instagram.com/p/ABC123/'),
    'https://www.instagram.com/p/ABC123/',
  );
  assert.equal(
    normalizeReelUrl('https://www.instagram.com/tv/ABC123/?utm_source=x'),
    'https://www.instagram.com/tv/ABC123/',
  );
});

test('extracts the link from a pasted share message', () => {
  assert.equal(
    normalizeReelUrl(
      'Check this out https://www.instagram.com/reel/DeVzrhxziNB/?igsh=abc, it is funny',
    ),
    'https://www.instagram.com/reel/DeVzrhxziNB/',
  );
});

test('accepts both Instagram share-link shapes', () => {
  assert.equal(
    normalizeReelUrl('https://www.instagram.com/share/reel/BAH123abc/'),
    'https://www.instagram.com/share/reel/BAH123abc/',
  );
  assert.equal(
    normalizeReelUrl('https://www.instagram.com/share/BAH123abc/?igsh=x'),
    'https://www.instagram.com/share/BAH123abc/',
  );
});

test('rejects links that are not Instagram video posts', () => {
  const bad = [
    '',
    'not a link',
    'https://www.instagram.com.evil.com/reel/ABC123/',
    'https://evil.com/instagram.com/reel/ABC123/',
    'https://www.instagram.com/stories/someone/123/',
    'https://www.instagram.com/reel/',
    'https://www.instagram.com/reel/ABC123/embed/',
    'https://youtube.com/watch?v=ABC123',
    'javascript:alert(1)',
  ];
  for (const value of bad) {
    assert.throws(() => normalizeReelUrl(value), undefined, `expected ${value} to be rejected`);
  }
});

test('finds the shortcode used as a cache key', () => {
  assert.equal(shortcodeFromUrl('https://www.instagram.com/reel/DeVzrhxziNB/'), 'DeVzrhxziNB');
  assert.equal(shortcodeFromUrl('https://www.instagram.com/share/reel/BAH123/'), 'BAH123');
  assert.equal(shortcodeFromUrl('https://www.instagram.com/p/ABC_123/'), 'ABC_123');
});

test('uses a merged stream for best/source and a single file for fast', () => {
  assert.match(buildFormatSelector('best'), /bestvideo\+bestaudio/);
  assert.match(buildFormatSelector('source'), /bestvideo\+bestaudio/);
  assert.match(buildFormatSelector('fast'), /best\[ext=mp4\]/);
});

test('summarizes a 1080x1920 VP9 reel with progressive fallback', () => {
  const info = {
    formats: [
      { format_id: 'dash-a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.5' },
      { format_id: '1', ext: 'mp4', vcodec: null, acodec: null },
      {
        format_id: 'dash-720',
        ext: 'mp4',
        width: 720,
        height: 1280,
        vcodec: 'vp09.00.31.08',
        acodec: 'none',
      },
      {
        format_id: 'dash-1080',
        ext: 'mp4',
        width: 1080,
        height: 1920,
        vcodec: 'vp09.00.40.08',
        acodec: 'none',
      },
    ],
  };

  const summary = summarizeFormats(info);
  assert.equal(summary.qualityHeight, 1080);
  assert.equal(summary.height, 1920);
  assert.equal(summary.videoCodec, 'VP9');
  assert.equal(summary.needsTranscode, true);
  assert.deepEqual(
    summary.qualities.map((quality) => quality.id),
    ['best', 'source', 'fast'],
  );
  assert.match(summary.qualities[0].label, /1080p/);
});

test('does not offer a duplicate original option when the source is H.264', () => {
  const summary = summarizeFormats({
    formats: [
      {
        format_id: 'dash-1080',
        ext: 'mp4',
        width: 1080,
        height: 1920,
        vcodec: 'avc1.640028',
        acodec: 'none',
      },
      { format_id: 'dash-a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' },
    ],
  });
  assert.equal(summary.needsTranscode, false);
  assert.deepEqual(
    summary.qualities.map((quality) => quality.id),
    ['best'],
  );
});
