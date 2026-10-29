// understand: transcript plus structured summary for every selected video -> <video>/transcript.md,
// through the bundled video-understand CLI (tools/video-understand). Options: --only <videoId> --jobs <n>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, listSelected } from '../context.mjs';
import { sourceFor } from '../sources/index.mjs';

const TOOL = path.join(ROOT, 'tools/video-understand');

const BASE_PROMPT = `Understand this video in detail. In the first half of your answer, output a complete sentence-by-sentence transcript with timestamps, preserving the original order of speech as closely as possible. Each transcript entry must include a timestamp range plus the spoken content, and when helpful a brief note about the corresponding visuals. After the transcript section, provide a second half with a structured summary of the key information, topics, people, objects, scene changes, and other notable details.`;

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['src/cli.mjs', ...args], { cwd: TOOL });
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    p.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function understandPage(meta, page, prompt) {
  const source = sourceFor(meta.source);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await run([...source.understandArgs(meta, page), '--prompt', prompt, '--json']);
    if (r.code === 0) {
      try { return JSON.parse(r.out).resultText; } catch { /* retry */ }
    }
    const msg = (r.err.match(/"message": "([^"]+)"/g) || []).pop() || r.err.slice(-300);
    console.error(`${meta.id} p${page} attempt ${attempt} failed: ${msg}`);
  }
  return null;
}

export default async function understand({ topic, ws, args }) {
  const prompt = topic.understandPrompt ? `${BASE_PROMPT}\n\nAdditional requirements: ${topic.understandPrompt}` : BASE_PROMPT;
  const done = (s) => fs.existsSync(path.join(s.dir, 'transcript.md'));
  const todo = listSelected(ws, args.only).filter((s) => !done(s));
  console.log(`${todo.length} videos to understand`);
  let ok = 0, failed = 0;
  await Promise.all(Array.from({ length: Number(args.jobs || 6) }, async () => {
    for (let s; (s = todo.shift());) {
      const { meta } = s;
      const parts = [];
      for (let page = 1; page <= (meta.pages || 1); page++) {
        const text = await understandPage(meta, page, prompt);
        if (!text) { parts.length = 0; break; }
        parts.push(meta.pages > 1 ? `## P${page}\n\n${text}` : text);
      }
      if (parts.length) {
        const link = /^https?:/.test(meta.url) ? `[${meta.id}](${meta.url})` : meta.title;
        fs.writeFileSync(path.join(s.dir, 'transcript.md'),
          `# ${meta.title}\n\n${meta.creator}　${meta.pubdate}　${link}　时长 ${Math.round(meta.durationSec / 60)} 分钟\n\n${parts.join('\n\n')}`);
        ok++;
      } else failed++;
      console.log(`${parts.length ? 'ok' : 'FAILED'} [${ok + failed}] ${meta.creator} / ${meta.title.slice(0, 40)}`);
    }
  }));
  console.log(`understood ${ok}, failed ${failed}`);
}
