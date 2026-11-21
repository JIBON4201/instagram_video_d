import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReelUrl,
  shortcodeFromUrl,
} from '../lib/instagram.js';

test('SSRF: rejects non-instagram.com hosts', async (t) => {
  const bad = [
    'https://evil.com/reel/ABC123/',
    'https://instagram.com.evil.com/reel/ABC123/',
    'https://evil.instagram.com/reel/ABC123/',
    'https://www.instagram.com.evil.com/',
    'http://127.0.0.1/reel/ABC123/',
    'http://localhost/reel/ABC123/',
    'http://192.168.1.1/reel/ABC123/',
    'http://10.0.0.1/reel/ABC123/',
    'http://172.16.0.1/reel/ABC123/',
    'https://[::1]/reel/ABC123/',
    'https://[::ffff:127.0.0.1]/reel/ABC123/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://evil.com/file',
  ];
  for (const value of bad) {
    await t.test(`rejects ${value}`, () => {
      assert.throws(() => normalizeReelUrl(value), undefined, `expected ${value} to be rejected`);
    });
  }
});

test('SSRF: rejects instagram.com with credentials', async (t) => {
  assert.throws(
    () => normalizeReelUrl('https://user:pass@www.instagram.com/reel/ABC123/'),
    undefined,
    'expected URL with credentials to be rejected'
  );
});

test('SSRF: accepts only allowed instagram.com hosts', async (t) => {
  const valid = [
    'https://www.instagram.com/reel/ABC123/',
    'https://instagram.com/reel/ABC123/',
    'https://m.instagram.com/reel/ABC123/',
    'https://l.instagram.com/reel/ABC123/',
  ];
  for (const value of valid) {
    await t.test(`accepts ${value}`, () => {
      const result = normalizeReelUrl(value);
      assert.ok(result.startsWith('https://www.instagram.com/'));
    });
  }
});

test('shortcode extraction returns empty string for invalid URLs', () => {
  assert.equal(shortcodeFromUrl('not a url'), '');
  assert.equal(shortcodeFromUrl(''), '');
  assert.equal(shortcodeFromUrl('https://evil.com/'), '');
});

test('normalizes tracking parameters stripped', () => {
  const result = normalizeReelUrl(
    'https://www.instagram.com/reel/DeVzrhxziNB/?igsh=abc123&utm_source=ig_web_copy_link&__coig_restricted=1'
  );
  assert.equal(result, 'https://www.instagram.com/reel/DeVzrhxziNB/');
});
