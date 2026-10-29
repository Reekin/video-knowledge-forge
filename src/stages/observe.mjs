// observe: readable notes distilled from each video's comments -> <video>/comment-notes.md.
// These notes are for people browsing the material; extraction reads the raw comments itself.
// Options: --only <videoId> --jobs --model
import fs from 'node:fs';
import path from 'node:path';
import { listSelected, pool } from '../context.mjs';
import { ask, stageModel } from '../llm.mjs';
import { renderComments, readComments } from './comments.mjs';

const SUMMARY_CHARS = 8000;

const rules = (topic) => `你在帮${topic.audience}整理一期教程视频的评论区。下面给出视频信息、视频内容总结和评论（[作者] 表示视频作者本人，↳ 为楼中楼回复，括号内是点赞数）。

从评论里提炼对学习和复现有用、而视频本身没讲或讲得不够的信息，用中文 Markdown 输出，按下列小节组织，没有内容的小节直接省略：

## 作者补充与答疑
作者在置顶和回复里给出的补充说明、参数建议、文件获取方式、对常见问题的回答。
## 报错与解决
观众遇到的报错和异常，以及评论里给出的有效解决方法。没有得到解答的也列出，标注“未解决”。
## 观众实测与改进
观众自己的配置、速度和资源数据，替换做法后的改进，与其他方案的对比结论。
## 纠正、争议与过时提示
指出视频内容有误、存在争议、或已经被新版本取代的评论。
## 资源线索
评论里提到的工具、模型、插件、仓库和获取途径（只记名称和途径）。

要求：每条写成一两句具体信息，末尾用括号注明来源（如“作者置顶”“@用户名，赞 66”）；合并重复的内容；不收录夸奖、催更、闲聊、广告和无信息量的提问。最后用一行“**评论区价值**：高/中/低，一句话说明”收尾。只输出 Markdown 正文。`;

export default async function observe({ topic, ws, args }) {
  const model = stageModel({ topic, args }, 'observe');
  const todo = listSelected(ws, args.only).filter((s) => fs.existsSync(path.join(s.dir, 'comments.json'))
    && fs.existsSync(path.join(s.dir, 'transcript.md')) && !fs.existsSync(path.join(s.dir, 'comment-notes.md')));
  console.log(`${todo.length} videos to observe`);
  let n = 0;
  await pool(todo, Number(args.jobs || 6), async ({ dir, meta }) => {
    try {
      const raw = readComments(dir);
      const transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
      const body = await ask([rules(topic), '',
        `# 视频：${meta.title}`, `作者：${meta.creator}　发布：${meta.pubdate}　评论总数：${raw.total ?? '未知'}`, `简介：${meta.desc}`, '',
        '# 视频内容总结', transcript.slice(-SUMMARY_CHARS), '', '# 评论', renderComments(raw)].join('\n'), { model, maxTokens: 40000 });
      fs.writeFileSync(path.join(dir, 'comment-notes.md'),
        `# 评论观察：${meta.title}\n\n收录置顶 ${raw.pinned.length} 条、热评 ${raw.hot.length} 条及其回复。\n\n${body}\n`);
      console.log(`[${++n}] ${meta.creator} / ${meta.title.slice(0, 40)}`);
    } catch (e) {
      console.error(`FAILED ${meta.id}: ${e.message}`);
    }
  });
}
