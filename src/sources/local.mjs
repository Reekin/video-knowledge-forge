// Local video files. Each source entry is one creator; there are no stats or comments, so every
// kept video is studied.
//
// Source specs (topic.sources[]):
//   { type: 'local', dir: 'D:/courses/blender', creator: 'Blender 课程' }   creator defaults to the folder name
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.flv']);
const files = new Map(); // id -> absolute path

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return EXT.has(path.extname(e.name).toLowerCase()) ? [p] : [];
  });
}

async function* groups(spec) {
  const dir = path.resolve(spec.dir);
  const name = spec.creator || path.basename(dir);
  const ids = walk(dir).sort().map((p) => {
    const id = crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
    files.set(id, p);
    return id;
  });
  yield { creator: { id: crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12), name, sign: '', url: '' }, ids: async () => ids };
}

function duration(file) {
  try {
    return Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })));
  } catch {
    return 0;
  }
}

async function detail(id) {
  const file = files.get(id);
  return {
    id, url: file, file, title: path.basename(file, path.extname(file)), desc: '',
    pubdate: Math.floor(fs.statSync(file).mtimeMs / 1000), duration: duration(file), pages: 1, stat: {},
  };
}

export default {
  types: ['local'],
  rateWeights: {},
  groups,
  detail,
  comments: null,
  understandArgs: (meta) => ['--file', meta.file],
};
