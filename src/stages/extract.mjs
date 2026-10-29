// extract: split each studied video (transcript summary + raw comments) into knowledge atoms tagged
// with the topic's chapters -> _data/atoms/<videoId>.json. Options: --only <videoId> --jobs --model
import fs from 'node:fs';
import path from 'node:path';
import { listSelected, writeJson, pool } from '../context.mjs';
import { askJson, stageModel } from '../llm.mjs';
import { renderComments, readComments } from './comments.mjs';

const rules = (topic) => `你在为一份“${topic.domain}”知识图谱拆解一期教程视频。读下面的视频总结和评论区原文（[作者] 是视频作者本人，↳ 是楼中楼回复，括号内是点赞数），把其中真正能教会别人的知识拆成独立的知识点。

章节（chapter 只能用这些 id）：
${topic.chapters.map((c) => `- ${c.id}：${c.name}（${c.scope}）`).join('\n')}

每个知识点：
- chapter：所属章节 id
- subject：知识点围绕的实体，用规范短名（具体的${topic.filter?.dependency?.label || '工具或模型'}、技术、插件或概念）。同一实体在不同视频里要用同一个名字
- kind：concept（原理/概念）| model（${topic.filter?.dependency?.label || '工具或模型'}的特点与定位）| recipe（可照做的流程）| param（参数取值建议）| pitfall（问题与解法）| tip（技巧）| compare（对比结论）
- title：一句话标题（15 字内）
- body：讲清楚“是什么/怎么做/为什么”，保留关键数值、名称和设置。2-4 句，写给想学会的人看，不要写“作者说”“视频中”之类的转述口吻
- level：入门 | 进阶 | 高阶

要求：只收录可复用的知识，跳过开场寒暄、广告、抽奖、作品展示、下载地址。评论区里作者答疑、有效的报错解法、观众实测参数和纠正意见同样拆成知识点；无人证实的猜测和闲聊不要。一期视频通常 8-25 个知识点。
另给出 oneLine：这期视频一句话讲了什么（20 字内）。

只输出 JSON：{"oneLine":"...","atoms":[{"chapter":"...","subject":"...","kind":"...","title":"...","body":"...","level":"..."}]}`;

export default async function extract({ topic, ws, args }) {
  const model = stageModel({ topic, args }, 'extract');
  const out = path.join(ws.data, 'atoms');
  const header = rules(topic);
  const ids = new Set(topic.chapters.map((c) => c.id));
  const todo = listSelected(ws, args.only).filter((s) => fs.existsSync(path.join(s.dir, 'transcript.md'))
    && !fs.existsSync(path.join(out, `${s.meta.id}.json`)));
  console.log(`${todo.length} videos to extract`);
  let n = 0;
  await pool(todo, Number(args.jobs || 10), async ({ dir, meta }) => {
    try {
      const transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
      const raw = readComments(dir);
      const prompt = [header, '', `# ${meta.title}`, `作者：${meta.creator}　发布：${meta.pubdate}`, '',
        '# 视频内容（转录后半部分的结构化总结）', transcript.slice(-14000), '',
        ...(raw ? ['# 评论区原文', renderComments(raw).slice(0, 30000)] : [])].join('\n');
      const res = await askJson(prompt, { model, effort: 'medium', maxTokens: 24000 });
      res.atoms = (res.atoms || []).filter((a) => ids.has(a.chapter) && a.subject && a.body);
      writeJson(path.join(out, `${meta.id}.json`), {
        id: meta.id, creator: meta.creator, title: meta.title, pubdate: meta.pubdate, url: meta.url, ...res,
      });
      console.log(`[${++n}] ${res.atoms.length} atoms  ${meta.creator} / ${meta.title.slice(0, 36)}`);
    } catch (e) {
      console.error(`FAILED ${meta.id}: ${e.message}`);
    }
  });
}
