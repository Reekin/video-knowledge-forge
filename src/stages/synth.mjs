// synth: turn knowledge atoms into the map: per-chapter node plans, node cards, chapter intros,
// then learning paths / intents / landscape / glossary. Writes _data/synth/*.json; finished files are
// kept, so delete one to regenerate it. Usage: forge synth [plan|nodes|chapters|global] --jobs --model
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, pool } from '../context.mjs';
import { askJson, stageModel } from '../llm.mjs';

const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export default async function synth({ topic, ws, args }) {
  const step = args._[0] || 'all';
  const model = stageModel({ topic, args }, 'synth');
  const jobs = Number(args.jobs || 10);
  const opts = (maxTokens) => ({ model, effort: 'medium', maxTokens });
  const SDIR = path.join(ws.data, 'synth');
  fs.mkdirSync(path.join(SDIR, 'nodes'), { recursive: true });
  const CH = topic.chapters;
  const chName = (id) => CH.find((c) => c.id === id).name;

  const VOICE = `写作口吻：你是一位很会讲课的知识区博主，读者是${topic.audience}。用平实短句直接讲，先讲清楚“这是什么、为什么需要它”，再讲“怎么做”。不提视频、作者、评论区、出处，不说“有人认为”“实测表明”，直接给结论。保留关键数值和名称。信息相互矛盾时取多数和较新的说法，必要时写出适用条件。`;

  const adir = path.join(ws.data, 'atoms');
  const atoms = fs.readdirSync(adir).map((f) => readJson(path.join(adir, f)))
    .flatMap((v) => v.atoms.map((a) => ({ ...a, videoId: v.id, pubdate: v.pubdate })));

  async function plan() {
    await pool(CH, jobs, async (ch) => {
      const file = path.join(SDIR, `plan-${ch.id}.json`);
      if (fs.existsSync(file)) return;
      const bySubject = new Map();
      for (const a of atoms.filter((x) => x.chapter === ch.id)) {
        if (!bySubject.has(a.subject)) bySubject.set(a.subject, []);
        bySubject.get(a.subject).push(a.title);
      }
      if (!bySubject.size) { writeJson(file, { nodes: [] }); return; }
      const list = [...bySubject].sort((a, b) => b[1].length - a[1].length)
        .map(([s, ts]) => `- ${s}（${ts.length}）：${[...new Set(ts)].slice(0, 12).join('；')}`).join('\n');
      const prompt = `你在规划知识图谱“${ch.name}”一章（范围：${ch.scope}）的知识节点。下面是这一章收集到的全部知识点，按实体（subject）分组，括号内是条数，后面是部分知识点标题。

把它们组织成知识节点，数量按素材多少决定，通常 4-16 个。一个节点是学习者会单独查阅的一个主题：一个${topic.filter?.dependency?.label || '工具或模型'}、一项技术、一个工具/插件、一个核心概念，或一类常见问题。合并同义或高度相关的实体，太零碎的并入最相关的节点，与本章无关或无价值的丢弃。每个出现 2 次以上的实体都要归入某个节点。

每个节点给出：
- name：节点名（简短规范，读者一眼能懂）
- kind：model | technique | tool | concept | problem | workflow
- level：入门 | 进阶 | 高阶
- subjects：归入它的实体名数组（必须原样使用下面列表里的名字）

只输出 JSON：{"nodes":[{"name":"...","kind":"...","level":"...","subjects":["..."]}]}

${list}`;
      try {
        const res = await askJson(prompt, opts(48000));
        writeJson(file, res);
        console.log(`plan ${ch.id}: ${res.nodes.length} nodes`);
      } catch (e) {
        console.error(`FAILED plan ${ch.id}: ${e.message.slice(0, 200)}`);
      }
    });
  }

  function directory() {
    return CH.flatMap((ch) => {
      const f = path.join(SDIR, `plan-${ch.id}.json`);
      return fs.existsSync(f) ? readJson(f).nodes.map((n) => ({ ...n, chapter: ch.id, id: `${ch.id}--${slug(n.name)}` })) : [];
    });
  }

  async function writeNodes() {
    const dir = directory();
    const catalog = CH.map((ch) => `${ch.name}：${dir.filter((n) => n.chapter === ch.id).map((n) => n.name).join('、')}`).join('\n');
    await pool(dir, jobs, async (node) => {
      const file = path.join(SDIR, 'nodes', `${node.id}.json`);
      if (fs.existsSync(file)) return;
      const subjects = new Set(node.subjects);
      const mine = atoms.filter((a) => a.chapter === node.chapter && subjects.has(a.subject))
        .sort((a, b) => b.pubdate.localeCompare(a.pubdate));
      if (!mine.length) return;
      const text = mine.map((a) => `[${a.kind}|${a.level}|${a.pubdate}] ${a.title}：${a.body}`).join('\n').slice(0, 60000);
      const prompt = `${VOICE}

请为知识图谱节点“${node.name}”（所在章节：${chName(node.chapter)}）写一篇学习卡片。下面是从大量教程中整理出的相关知识点（按发布时间从新到旧，越新越可信）。融会贯通后重写，合并重复，去掉过时和只对单个作品有意义的细节。

输出 JSON：
{
 "oneLiner": "一句话说清它是什么/解决什么（25 字内）",
 "essence": "核心理解：2-4 句，讲原理或心智模型，让人真正懂它",
 "steps": ["怎么做：可照做的步骤，每步一句；没有明确流程就给空数组"],
 "params": [{"name":"参数或设置","value":"推荐取值","note":"为什么/适用条件"}],
 "pitfalls": [{"q":"常见问题或症状","a":"原因与解法"}],
 "tips": ["进阶技巧或对比结论，每条一句"],
 "related": [{"name":"相关节点名，必须取自下方目录且不是自己","rel":"关系，如 依赖/替代方案/搭配使用/上游步骤/下游步骤/解决/对比"}]
}
params、pitfalls、tips 各不超过 8 条，挑最有用的；related 3-6 条。

知识图谱目录：
${catalog}

知识点：
${text}`;
      try {
        const res = await askJson(prompt, opts(32000));
        const counts = {};
        for (const a of mine) counts[a.videoId] = (counts[a.videoId] || 0) + 1;
        res.videos = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
        res.weight = mine.length;
        writeJson(file, { ...node, ...res });
        console.log(`node ${node.id}: ${mine.length} atoms`);
      } catch (e) {
        console.error(`FAILED node ${node.id}: ${e.message.slice(0, 200)}`);
      }
    });
  }

  const loadNodes = () => fs.readdirSync(path.join(SDIR, 'nodes')).map((f) => readJson(path.join(SDIR, 'nodes', f)));

  async function writeChapters() {
    const nodes = loadNodes();
    await pool(CH, jobs, async (ch) => {
      const file = path.join(SDIR, `chapter-${ch.id}.json`);
      const mine = nodes.filter((n) => n.chapter === ch.id);
      if (fs.existsSync(file) || !mine.length) return;
      const prompt = `${VOICE}

为知识图谱的“${ch.name}”一章写导读。本章节点如下（名称：一句话｜核心理解）：
${mine.map((n) => `- ${n.name}：${n.oneLiner}｜${n.essence}`).join('\n')}

输出 JSON：
{
 "hook": "这一章帮你解决什么问题（一句话，30 字内）",
 "mentalModel": "本章的全局心智模型：3-5 句，把节点之间的关系串起来讲，读完知道这些东西各管什么、怎么配合",
 "takeaways": ["最值得记住的 3-5 条要点，每条一句，具体可用"],
 "order": ["按推荐学习顺序排列的全部节点名"]
}`;
      try {
        writeJson(file, await askJson(prompt, opts(16000)));
        console.log(`chapter ${ch.id}`);
      } catch (e) {
        console.error(`FAILED chapter ${ch.id}: ${e.message.slice(0, 200)}`);
      }
    });
  }

  async function writeGlobal() {
    const file = path.join(SDIR, 'global.json');
    if (fs.existsSync(file)) return;
    const nodes = loadNodes();
    const groups = topic.site.landscape.groups;
    const g = topic.synth || {};
    const catalog = CH.map((ch) => `## ${ch.name}\n${nodes.filter((n) => n.chapter === ch.id).map((n) => `- ${n.name}（${n.kind}，${n.level}）：${n.oneLiner}`).join('\n')}`).join('\n');
    const prompt = `${VOICE}

下面是整张知识图谱的全部节点。请设计读者的学习入口，输出 JSON：
{
 "headline": "首页大标题下的一句导语（40 字内），概括${topic.domain}的现状与这张图谱能帮你做什么",
 "paths": [ {"name":"学习路径名","goal":"学完能做到什么","steps":[{"node":"节点名","why":"这一步学什么（15 字内）"}]} ],
 "intents": [ {"want":"我想……（读者的具体目标，口语化，15 字内）","answer":"一两句给出思路","nodes":["按使用顺序排列的节点名"]} ],
 "landscape": [ {"model":"${topic.site.landscape.label}名","group":"${groups.map((x) => x.id).join(' 或 ')}","role":"它在当前生态里的定位（20 字内）","strengths":"擅长","limits":"短板或门槛","node":"对应节点名"} ],
 "glossary": [ {"term":"术语","plain":"一句大白话解释"} ]
}
paths 给 ${g.paths || '3-4 条，从入门到进阶覆盖主要方向'}，每条 6-10 步；intents 给 16-24 个覆盖各章的常见目标；landscape 覆盖目录里出现的主要${topic.site.landscape.label}，group 含义：${groups.map((x) => `${x.id}=${x.name}`).join('，')}；glossary 给 20-30 个新手最常卡住的术语。所有节点名必须原样取自目录。

${catalog}`;
    writeJson(file, await askJson(prompt, opts(48000)));
    console.log('global');
  }

  if (['plan', 'all'].includes(step)) await plan();
  if (['nodes', 'all'].includes(step)) await writeNodes();
  if (['chapters', 'all'].includes(step)) await writeChapters();
  if (['global', 'all'].includes(step)) await writeGlobal();
}
