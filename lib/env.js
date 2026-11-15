import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let loaded = false;

/**
 * Minimal .env loader so `npm start` works without a dependency. Existing
 * environment variables always win; the file is optional.
 */
export function loadEnv() {
  if (loaded) return;
  loaded = true;

  let text;
  try {
    text = fs.readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();
