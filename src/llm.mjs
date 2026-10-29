// Text-model calls through the bundled AskLLM CLI (tools/askllm). The gateway comes from
// ASKLLM_BASE_URL / ASKLLM_API_KEY / ASKLLM_WIRE_API, or from the local Codex config when unset.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './context.mjs';

const ASK = path.join(ROOT, 'tools/askllm/ask_llm.py');
const PYTHON = process.env.FORGE_PYTHON || 'python';

export function ask(prompt, { model, effort = 'low', maxTokens = 24000 }) {
  if (!model) throw new Error('ask: model is required (set it in topic.models or pass --model)');
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [ASK, 'ask', '--prompt-file', '-', '--model', model, '--effort', effort,
      '--max-tokens', String(maxTokens), '--text'], { env: { ...process.env, PYTHONUTF8: '1' } });
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    p.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(`askllm: ${err.slice(0, 400)}`))));
    p.stdin.end(prompt, 'utf8');
  });
}

// Parses the first JSON object or array in a model answer (tolerates code fences and prose around it).
export function parseJson(text) {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return JSON.parse(text.slice(start, end + 1));
}

export async function askJson(prompt, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return parseJson(await ask(prompt, opts)); } catch (e) { last = e; }
  }
  throw last;
}

// Model for a stage: --model flag, then topic.models[stage].
export function stageModel(ctx, stage) {
  const model = ctx.args.model || ctx.topic.models?.[stage];
  if (!model) throw new Error(`no model for stage "${stage}": set topic.models.${stage} or pass --model`);
  return model;
}
