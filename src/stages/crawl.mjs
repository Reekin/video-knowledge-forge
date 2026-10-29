// crawl: list every creator and video of the topic's sources with stats.
// Writes _data/creators.json and _data/videos/<creatorId>.json; reruns only fetch new videos.
// Options: --only <creatorId>  --limit <n newest videos per creator>
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, sleep } from '../context.mjs';
import { sourceFor } from '../sources/index.mjs';

export default async function crawl({ topic, ws, args }) {
  const creators = [];
  for (const spec of topic.sources) {
    const source = sourceFor(spec.type);
    for await (const g of source.groups(spec)) {
      const creator = { ...g.creator, source: spec.type };
      creators.push(creator);
      writeJson(path.join(ws.data, 'creators.json'), creators);
      if (args.only && creator.id !== String(args.only)) continue;
      await crawlCreator(ws, source, creator, g.ids, args.limit ? Number(args.limit) : Infinity);
    }
  }
  console.log(`crawl done: ${creators.length} creators`);
}

async function crawlCreator(ws, source, creator, listIds, limit) {
  const file = path.join(ws.data, 'videos', `${creator.id}.json`);
  const have = new Map((fs.existsSync(file) ? readJson(file).videos : []).map((v) => [v.id, v]));
  const ids = (await listIds()).slice(0, limit);
  const todo = ids.filter((id) => !have.has(id));
  console.log(`${creator.name}: ${ids.length} videos, ${todo.length} to fetch`);
  const save = () => writeJson(file, { creator, crawledAt: new Date().toISOString(),
    videos: ids.filter((id) => have.has(id)).map((id) => have.get(id)) });
  for (const [i, id] of todo.entries()) {
    const v = await source.detail(id);
    if (v) have.set(id, v);
    else console.error(`  skip ${id}: unavailable`);
    if (i % 10 === 9) { save(); process.stdout.write(`  ${i + 1}/${todo.length}\r`); }
    if (source.throttleMs) await sleep(source.throttleMs);
  }
  save();
}
