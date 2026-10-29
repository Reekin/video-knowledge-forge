// rank: score kept videos within each creator and choose what to study.
// Writes notes/<creator>/00-ranking.md, notes/<creator>/<video>/meta.json for every selected video,
// and overview.md. Videos that already have a transcript stay selected. Option: --line <0..1>
//
// score = quality x time decay, computed inside one creator's pool only:
//   quality = 0.6 x engagement percentile (weighted interaction rates of the source) + 0.4 x view
//             percentile among the videos published closest in time
//   decay   = 0.5 ^ (age / halfLifeDays), floored at evergreenFloor for evergreen content
// Selected: score >= line x the creator's best score. Sources without view counts select every kept video.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, safeName, day } from '../context.mjs';
import { sourceFor } from '../sources/index.mjs';

const NEIGHBORS = 15;
const NOW = Date.now() / 1000;
const pct = (arr, x) => arr.filter((a) => a <= x).length / arr.length;
const ratio = (a, b) => (b ? a / b : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const normModel = (m) => m.toLowerCase().replace(/[\s\-_.·]/g, '');
const ts = (d) => (d ? Date.parse(d) / 1000 : null);

function score(pool, weights, cfg) {
  const hasViews = pool.every((v) => typeof v.stat.view === 'number');
  const keys = Object.keys(weights).filter((k) => pool.every((v) => typeof v.stat[k] === 'number'));
  const total = keys.reduce((s, k) => s + weights[k], 0);
  const rates = Object.fromEntries(keys.map((k) => [k, pool.map((v) => ratio(v.stat[k], v.stat.view))]));
  const byTime = [...pool].sort((a, b) => a.pubdate - b.pubdate);
  for (const v of pool) {
    v.engagement = hasViews && total ? keys.reduce((s, k) => s + (weights[k] / total) * pct(rates[k], ratio(v.stat[k], v.stat.view)), 0) : 0.5;
    const near = [...byTime].sort((a, b) => Math.abs(a.pubdate - v.pubdate) - Math.abs(b.pubdate - v.pubdate)).slice(0, NEIGHBORS);
    v.viewPct = hasViews ? pct(near.map((n) => n.stat.view), v.stat.view) : 0.5;
    v.quality = 0.6 * v.engagement + 0.4 * v.viewPct;
    v.decay = Math.max(0.5 ** ((NOW - v.pubdate) / 86400 / cfg.halfLifeDays), v.cls.evergreen ? cfg.evergreenFloor : 0);
    v.score = v.quality * v.decay;
    v.eligible = !cfg.since || v.pubdate >= ts(cfg.since);
  }
  const sorted = (list) => list.sort((a, b) => b.score - a.score);
  return { ranked: [...sorted(pool.filter((v) => v.eligible)), ...sorted(pool.filter((v) => !v.eligible))], hasViews };
}

function writeCreator(ws, cfg, creator, { ranked, hasViews }, dropped, missing) {
  const dir = path.join(ws.notes, safeName(creator.name));
  fs.mkdirSync(dir, { recursive: true });
  const studied = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const metaFile = path.join(dir, e.name, 'meta.json');
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'transcript.md')) && fs.existsSync(metaFile)) {
      studied.set(readJson(metaFile).id, e.name);
    }
  }
  const eligible = ranked.filter((v) => v.eligible);
  const line = hasViews ? (eligible[0]?.score ?? 0) * cfg.line : -1;
  const selected = eligible.filter((v) => v.score >= line || studied.has(v.id));
  const names = new Set(studied.values());
  for (const v of selected) {
    if (studied.has(v.id)) { v.dirName = studied.get(v.id); continue; }
    let n = safeName(v.title);
    if (names.has(n)) n = `${n} ${v.id}`;
    names.add(n);
    v.dirName = n;
  }
  // Drop selections from an earlier run that never got past meta.json.
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || names.has(e.name)) continue;
    const files = fs.readdirSync(path.join(dir, e.name));
    if (files.length === 1 && files[0] === 'meta.json') fs.rmSync(path.join(dir, e.name), { recursive: true });
  }
  ranked.forEach((v, i) => { v.rank = i + 1; });
  for (const v of selected) {
    const { cls, engagement, viewPct, quality, decay, score: s, eligible: _e, rank, dirName, pubdate, duration, ...video } = v;
    writeJson(path.join(dir, dirName, 'meta.json'), {
      ...video, source: creator.source, creator: creator.name, creatorId: creator.id,
      pubdate: day(pubdate), durationSec: duration, classification: cls,
      ranking: { rank, score: r3(s), quality: r3(quality), engagement: r3(engagement), viewPct: r3(viewPct), decay: r3(decay) },
    });
  }
  const link = (v) => (/^https?:/.test(v.url) ? `[${v.title.replace(/[[\]|]/g, ' ')}](${v.url})` : v.title.replace(/\|/g, ' '));
  const pctOf = (v, k) => (typeof v.stat[k] === 'number' ? `${(ratio(v.stat[k], v.stat.view) * 100).toFixed(1)}%` : '-');
  const row = (v) => `| ${v.rank} | ${r3(v.score)} | ${link(v)} | ${day(v.pubdate)} | ${Math.round(v.duration / 60)}′ | ${v.stat.view ?? '-'} | ${pctOf(v, 'like')} | ${pctOf(v, 'reply')} | ${v.cls.category}${v.cls.verdict === 'unsure' ? '（待定）' : ''}${v.cls.evergreen ? '·原理' : ''}${v.cls.live ? '·直播/合集' : ''} |`;
  const head = '| 排名 | 得分 | 视频 | 发布 | 时长 | 播放 | 点赞率 | 评论率 | 分类 |\n|---|---|---|---|---|---|---|---|---|';
  const chosen = new Set(selected);
  const old = ranked.filter((v) => !v.eligible);
  fs.writeFileSync(path.join(dir, '00-ranking.md'), [
    `# ${creator.name} 视频筛选与排序`, '',
    `${creator.url ? `主页：${creator.url}　` : ''}共 ${ranked.length + dropped.length + missing} 条，候选 ${ranked.length} 条，剔除 ${dropped.length} 条${missing ? `，未分类 ${missing} 条` : ''}。精读 ${selected.length} 条${hasViews ? `：得分不低于本作者最高分的 ${cfg.line * 100}%（${r3(line)}），以及已经精读过的视频` : '：没有播放数据，全部候选都精读'}。`, '',
    `## 精读（${selected.length}）`, '', head, ...selected.map(row), '',
    '## 其余候选', '', head, ...eligible.filter((v) => !chosen.has(v)).map(row), '',
    ...(old.length ? [`## ${cfg.since} 以前（未参与排名）`, '', head, ...old.map(row), ''] : []),
    '## 剔除', '', '| 视频 | 发布 | 分类 | 理由 |', '|---|---|---|---|',
    ...dropped.sort((a, b) => b.pubdate - a.pubdate).map((v) => `| ${link(v)} | ${day(v.pubdate)} | ${v.cls.category} | ${v.cls.reason} |`), '',
  ].join('\n'));
  return { creator, total: ranked.length + dropped.length + missing, pool: ranked.length, dropped: dropped.length, selected: selected.length };
}

export default async function rank({ topic, ws, args }) {
  const cfg = { line: 0.5, halfLifeDays: 180, evergreenFloor: 0.3, since: null, newModelSince: null, ...topic.rank };
  if (args.line) cfg.line = Number(args.line);
  const corpus = [];
  for (const creator of readJson(path.join(ws.data, 'creators.json'))) {
    const src = path.join(ws.data, 'videos', `${creator.id}.json`);
    const clsFile = path.join(ws.data, 'class', `${creator.id}.json`);
    if (!fs.existsSync(src) || !fs.existsSync(clsFile)) { console.log(`${creator.name}: not crawled/classified yet`); continue; }
    const cls = readJson(clsFile);
    corpus.push({ creator, videos: readJson(src).videos.map((v) => ({ ...v, cls: cls[v.id] })) });
  }

  // A dependency counts as new when its earliest appearance across all creators is on/after newModelSince.
  const firstSeen = new Map();
  for (const { videos } of corpus) {
    for (const v of videos) {
      for (const m of v.cls?.models ?? []) {
        const k = normModel(m);
        const cur = firstSeen.get(k);
        if (!cur || v.pubdate < cur.pubdate) firstSeen.set(k, { name: m, pubdate: v.pubdate, url: v.url, count: (cur?.count ?? 0) + 1 });
        else cur.count++;
      }
    }
  }
  const newSince = ts(cfg.newModelSince);
  const staleReason = (v) => {
    const ms = v.cls.models ?? [];
    if (!newSince || !v.cls.modelSpecific || !ms.length) return null;
    const seen = ms.map((m) => firstSeen.get(normModel(m)));
    if (seen.some((s) => s.pubdate >= newSince)) return null;
    return `旧版本：${seen.map((s) => `${s.name} 最早见于 ${day(s.pubdate)}`).join('；')}`;
  };

  const summary = [];
  for (const { creator, videos } of corpus) {
    for (const v of videos) {
      const r = v.cls && v.cls.verdict !== 'drop' && staleReason(v);
      if (r) v.cls = { ...v.cls, verdict: 'drop', category: '旧版本', reason: r };
    }
    const pool = videos.filter((v) => v.cls && v.cls.verdict !== 'drop');
    const dropped = videos.filter((v) => v.cls?.verdict === 'drop');
    const weights = sourceFor(creator.source).rateWeights;
    const s = writeCreator(ws, cfg, creator, score(pool, weights, cfg), dropped, videos.filter((v) => !v.cls).length);
    summary.push(s);
    console.log(`${creator.name}: total ${s.total}, pool ${s.pool}, dropped ${s.dropped}, selected ${s.selected}`);
  }

  const deps = [...firstSeen.values()].filter((s) => s.count >= 3).sort((a, b) => b.pubdate - a.pubdate);
  fs.writeFileSync(path.join(ws.dir, 'overview.md'), [
    `# ${topic.site?.title || topic.id} 素材总览`, '',
    '| 作者 | 投稿 | 候选 | 剔除 | 精读 |', '|---|---|---|---|---|',
    ...summary.map((s) => `| [${s.creator.name}](notes/${encodeURI(safeName(s.creator.name))}/00-ranking.md) | ${s.total} | ${s.pool} | ${s.dropped} | ${s.selected} |`), '',
    ...(deps.length ? ['## 依赖首次出现时间', '',
      `按全部作者投稿中最早以它为核心依赖的视频计算${newSince ? `，${cfg.newModelSince} 起出现的算新版本；强绑定具体版本、且所涉都不是新版本的视频归入剔除` : ''}。只列被 3 条以上视频依赖的。`, '',
      '| 名称 | 首次出现 | 视频数 |', '|---|---|---|',
      ...deps.map((s) => `| ${s.name} | ${/^https?:/.test(s.url) ? `[${day(s.pubdate)}](${s.url})` : day(s.pubdate)} | ${s.count} |`), ''] : []),
  ].join('\n'));
}
