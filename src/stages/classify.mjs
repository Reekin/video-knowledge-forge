// classify: coarse keep/drop on title, description, date and length, following topic.filter.
// Writes _data/class/<creatorId>.json keyed by video id. Options: --only <creatorId> --jobs --model
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, pool, day } from '../context.mjs';
import { askJson, stageModel } from '../llm.mjs';

const BATCH = 40;

function rules(topic) {
  const f = topic.filter;
  const dep = f.dependency || { label: '工具或模型', hint: '写规范名（名称 + 版本）' };
  return `你在为${topic.audience}筛选视频。根据标题、简介、发布日期和时长判断每条视频是否值得深入学习。

保留（keep）：
${f.keep}
剔除（drop）：
${f.drop}
拿不准（unsure）：标题信息不足或内容混合的。宁可放进 unsure 也不要错杀。

另外给出：
- category：一个短中文标签，如 ${f.categories}
- models：视频内容核心依赖的具体${dep.label}数组，${dep.hint}；仅顺带提到的不要写；内容与具体${dep.label}无关时给空数组
- modelSpecific：内容价值是否主要绑定在 models 里的具体${dep.label}上（换了就基本失效），布尔值
- evergreen：内容是否属于不易随版本更替过时的原理或通用方法${f.evergreen ? `（如 ${f.evergreen}）` : ''}，布尔值
- live：是否为直播回放、合集或超长录屏，布尔值
- reason：一句话理由

只输出一个 JSON 数组，每个元素形如 {"id":"...","verdict":"keep|drop|unsure","category":"...","models":[],"modelSpecific":false,"evergreen":false,"live":false,"reason":"..."}，不要输出其他内容。`;
}

function line(v) {
  const desc = (v.desc || '').replace(/https?:\/\/\S+/g, '[链接]').replace(/\s+/g, ' ').slice(0, 300);
  return `id=${v.id} | ${day(v.pubdate)} | 时长${Math.round(v.duration / 60)}分钟 | 标题：${v.title} | 简介：${desc || '无'}`;
}

export default async function classify({ topic, ws, args }) {
  const model = stageModel({ topic, args }, 'classify');
  const header = rules(topic);
  const tasks = [];
  for (const creator of readJson(path.join(ws.data, 'creators.json'))) {
    if (args.only && creator.id !== String(args.only)) continue;
    const src = path.join(ws.data, 'videos', `${creator.id}.json`);
    if (!fs.existsSync(src)) continue;
    const out = path.join(ws.data, 'class', `${creator.id}.json`);
    const cls = fs.existsSync(out) ? readJson(out) : {};
    const todo = readJson(src).videos.filter((v) => !cls[v.id]);
    console.log(`${creator.name}: ${todo.length} to classify`);
    for (let i = 0; i < todo.length; i += BATCH) tasks.push({ creator, out, cls, batch: todo.slice(i, i + BATCH) });
  }
  let n = 0;
  await pool(tasks, Number(args.jobs || 8), async (t) => {
    const prompt = `${header}\n\n作者：${t.creator.name}（简介：${t.creator.sign || '无'}）\n\n${t.batch.map(line).join('\n')}`;
    let res;
    try { res = await askJson(prompt, { model }); } catch (e) { console.error(`${t.creator.name}: ${e.message}`); return; }
    const ids = new Set(t.batch.map((v) => v.id));
    for (const r of res) if (ids.has(String(r.id))) t.cls[r.id] = r;
    writeJson(t.out, t.cls);
    console.log(`${t.creator.name}: batch ${++n}/${tasks.length}`);
  });
}
