// comments: pinned and hot comments with reply threads for every selected video -> <video>/comments.json.
// Sources without comments (local files) are skipped. Options: --only <videoId> --pages <n>
import fs from 'node:fs';
import path from 'node:path';
import { listSelected, writeJson } from '../context.mjs';
import { sourceFor } from '../sources/index.mjs';

export default async function comments({ ws, args }) {
  const todo = listSelected(ws, args.only).filter((s) => sourceFor(s.meta.source).comments
    && !fs.existsSync(path.join(s.dir, 'comments.json')));
  console.log(`${todo.length} videos to fetch comments for`);
  for (const [i, s] of todo.entries()) {
    try {
      const data = await sourceFor(s.meta.source).comments(s.meta, { pages: Number(args.pages || 5) });
      writeJson(path.join(s.dir, 'comments.json'), { id: s.meta.id, crawledAt: new Date().toISOString(), ...data });
      console.log(`[${i + 1}/${todo.length}] ${s.meta.creator} / ${s.meta.title.slice(0, 30)}: ${data.pinned.length} pinned, ${data.hot.length} hot`);
    } catch (e) {
      console.error(`[${i + 1}/${todo.length}] FAILED ${s.meta.id}: ${e.message}`);
    }
  }
}

// Plain-text rendering for prompts: [作者] marks the creator, ↳ marks replies, (n) is likes.
export function renderComments(raw) {
  const one = (c, prefix) => `${prefix}${c.isCreator ? '[作者] ' : ''}${c.user}（${c.like}）：${c.text.replace(/\s+/g, ' ')}${c.pictures ? ' [附图]' : ''}`;
  const block = (r, tag) => [one(r, tag), ...r.replies.map((c) => one(c, '  ↳ '))].join('\n');
  return [...raw.pinned.map((r) => block(r, '[置顶] ')), ...raw.hot.map((r) => block(r, ''))].join('\n');
}

export function readComments(dir) {
  const f = path.join(dir, 'comments.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
