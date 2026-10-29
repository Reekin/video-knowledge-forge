#!/usr/bin/env node
// video-knowledge-forge CLI. Run `node forge.mjs help` for usage.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, parseArgs, loadEnv, loadTopic, workspace } from './src/context.mjs';
import { sourceFor } from './src/sources/index.mjs';

const PIPELINE = ['crawl', 'classify', 'rank', 'comments', 'understand', 'observe', 'extract', 'synth', 'build'];

const HELP = `video-knowledge-forge: creators' videos -> transcripts, comment notes, knowledge map site

usage: node forge.mjs <stage> --topic <topics/name> [options]

stages (in pipeline order)
  crawl        list creators and videos with stats          --only <creatorId> --limit <n>
  classify     LLM keep/drop by title and description       --only <creatorId> --jobs --model
  rank         score within each creator, pick what to study --line <0..1>
  comments     pinned and hot comments of selected videos    --only <videoId> --pages <n>
  understand   transcript + summary per video                --only <videoId> --jobs <n>
  observe      readable comment notes per video              --only <videoId> --jobs --model
  extract      knowledge atoms per video                     --only <videoId> --jobs --model
  synth        plan nodes, write cards, chapters, entry points  [plan|nodes|chapters|global] --jobs --model
  build        static site at work/<topic>/site
  run          every stage above in order (--from <stage> to resume from one)
  publish      push the site to GitHub Pages                 --repo <name> --dry-run

other commands
  login        Bilibili QR login (stores the cookie BBDown and crawling share)
  check        verify tools, keys and logins for the topic
  open         open the built site

common options
  --topic <dir|topic.mjs>   topic config (required)
  --workspace <dir>         output directory (default work/<topic id>)
  --model <id>              override the stage's model from topic.models`;

loadEnv();
const args = parseArgs(process.argv.slice(2));
const command = args._.shift();

async function runStage(name, ctx) {
  console.log(`\n=== ${name}`);
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/stages', `${name}.mjs`)).href);
  await mod.default(ctx);
}

async function check(topic) {
  const probe = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' });
  const line = (ok, what, detail = '') => console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  const types = new Set(topic.sources.map((s) => s.type));
  line(probe(process.env.FORGE_PYTHON || 'python', ['--version']).status === 0, 'python 3.11+ (AskLLM)');
  line(probe('ffmpeg', ['-version']).status === 0, 'ffmpeg (video preprocessing)');
  const info = probe(process.env.FORGE_PYTHON || 'python', [path.join(ROOT, 'tools/askllm/ask_llm.py'), 'info']);
  line(info.status === 0, 'LLM gateway', info.status === 0 ? JSON.parse(info.stdout).base_url : info.stderr.trim().slice(0, 200));
  line(!!process.env.PROVIDER_1_BASE_URL && !!process.env.PROVIDER_1_API_KEY, 'video provider (PROVIDER_1_BASE_URL / PROVIDER_1_API_KEY)');
  for (const [stage, model] of Object.entries(topic.models || {})) line(!!model, `model for ${stage}`, model);
  if ([...types].some((t) => t.startsWith('bilibili'))) {
    try { line(true, 'bilibili login', await sourceFor('bilibili-up').checkLogin()); } catch (e) { line(false, 'bilibili login', e.message); }
  }
  if (types.has('youtube')) line(probe(process.env.YTDLP_PATH || 'yt-dlp', ['--version']).status === 0, 'yt-dlp');
}

async function main() {
  if (!command || command === 'help' || args.help) { console.log(HELP); return; }
  if (command === 'login') {
    const { cmd, args: a } = sourceFor('bilibili-up').login();
    spawnSync(cmd, a, { stdio: 'inherit' });
    return;
  }
  const topic = await loadTopic(args.topic);
  const ws = workspace(topic, args.workspace);
  const ctx = { topic, ws, args };
  if (command === 'check') return check(topic);
  if (command === 'open') {
    const index = path.join(ws.site, 'index.html');
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', index]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [index]];
    spawnSync(opener[0], opener[1], { stdio: 'ignore' });
    return;
  }
  if (command === 'run') {
    const from = args.from ? PIPELINE.indexOf(args.from) : 0;
    if (from < 0) throw new Error(`unknown stage for --from: ${args.from}`);
    for (const stage of PIPELINE.slice(from)) await runStage(stage, ctx);
    return;
  }
  if (![...PIPELINE, 'publish'].includes(command)) throw new Error(`unknown command "${command}"; see node forge.mjs help`);
  await runStage(command, ctx);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
