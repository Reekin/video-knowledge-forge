// Shared runtime: argument parsing, .env loading, topic loading and the workspace layout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `forge <stage> [positional...] --flag value --switch` -> { _: [...], flag: 'value', switch: true }
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Minimal KEY=VALUE loader; variables already set in the environment win.
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export async function loadTopic(spec) {
  if (!spec) throw new Error('missing --topic <dir or topic.mjs>, e.g. --topic topics/comfyui');
  let file = path.resolve(spec);
  if (!fs.existsSync(file)) file = path.join(ROOT, 'topics', spec);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'topic.mjs');
  if (!fs.existsSync(file)) throw new Error(`topic not found: ${spec}`);
  const topic = (await import(pathToFileURL(file).href)).default;
  for (const key of ['id', 'domain', 'audience', 'sources', 'parts', 'chapters']) {
    if (!topic[key]) throw new Error(`${file}: missing "${key}"`);
  }
  const partIds = new Set(topic.parts.map((p) => p.id));
  for (const c of topic.chapters) {
    if (!partIds.has(c.part)) throw new Error(`${file}: chapter ${c.id} uses unknown part "${c.part}"`);
  }
  return { file, ...topic };
}

export function workspace(topic, override) {
  const dir = path.resolve(override || path.join(ROOT, 'work', topic.id));
  const ws = {
    dir,
    data: path.join(dir, '_data'),
    notes: path.join(dir, 'notes'),
    site: path.join(dir, 'site'),
  };
  for (const d of [ws.data, ws.notes]) fs.mkdirSync(d, { recursive: true });
  return ws;
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 1));
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
export const safeName = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/[. ]+$/, '').slice(0, 80) || 'untitled';

// Every selected video directory (notes/<creator>/<video>/meta.json), best-ranked first.
export function listSelected(ws, only) {
  const out = [];
  for (const c of fs.readdirSync(ws.notes, { withFileTypes: true })) {
    if (!c.isDirectory()) continue;
    for (const v of fs.readdirSync(path.join(ws.notes, c.name), { withFileTypes: true })) {
      const metaFile = path.join(ws.notes, c.name, v.name, 'meta.json');
      if (!v.isDirectory() || !fs.existsSync(metaFile)) continue;
      const meta = readJson(metaFile);
      if (!only || meta.id === only) out.push({ dir: path.join(ws.notes, c.name, v.name), meta });
    }
  }
  return out.sort((a, b) => a.meta.ranking.rank - b.meta.ranking.rank);
}

// Runs fn over items with a fixed number of concurrent workers.
export async function pool(items, jobs, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
    for (let it; (it = queue.shift());) await fn(it);
  }));
}
