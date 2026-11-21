#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn('python', ['-m', 'yt_dlp', ...process.argv.slice(2)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('close', (code) => process.exit(code || 0));
