// build: assemble _data/synth into a static site at <workspace>/site (open site/index.html directly).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../context.mjs';

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.·（）()]/g, '');

export default async function build({ topic, ws }) {
  const SDIR = path.join(ws.data, 'synth');
  const nodes = fs.readdirSync(path.join(SDIR, 'nodes')).map((f) => readJson(path.join(SDIR, 'nodes', f)));
  const byName = new Map();
  for (const n of nodes) {
    byName.set(norm(n.name), n.id);
    for (const s of n.subjects || []) if (!byName.has(norm(s))) byName.set(norm(s), n.id);
  }
  const resolve = (name) => byName.get(norm(name));

  const videos = {};
  const adir = path.join(ws.data, 'atoms');
  for (const f of fs.readdirSync(adir)) {
    const v = readJson(path.join(adir, f));
    videos[v.id] = { creator: v.creator, title: v.title, date: v.pubdate, url: /^https?:/.test(v.url) ? v.url : '', line: v.oneLine };
  }

  const edges = new Map();
  for (const n of nodes) {
    n.related = (n.related || []).map((r) => ({ ...r, id: resolve(r.name) })).filter((r) => r.id && r.id !== n.id);
    for (const r of n.related) {
      const key = [n.id, r.id].sort().join('|');
      if (!edges.has(key)) edges.set(key, { a: n.id, b: r.id, rel: r.rel });
    }
  }

  const chapters = topic.chapters.flatMap((c) => {
    const mine = nodes.filter((n) => n.chapter === c.id);
    const file = path.join(SDIR, `chapter-${c.id}.json`);
    if (!mine.length || !fs.existsSync(file)) return [];
    const intro = readJson(file);
    const ordered = (intro.order || []).map(resolve).filter((id) => mine.some((n) => n.id === id));
    const order = [...new Set([...ordered, ...mine.sort((a, b) => b.weight - a.weight).map((n) => n.id)])];
    return [{ id: c.id, part: c.part, name: c.name, hook: intro.hook, mentalModel: intro.mentalModel, takeaways: intro.takeaways, order }];
  });
  const usedParts = new Set(chapters.map((c) => c.part));

  const g = readJson(path.join(SDIR, 'global.json'));
  const mapNodes = (list) => (list || []).map(resolve).filter(Boolean);
  const data = {
    site: topic.site,
    parts: topic.parts.filter((p) => usedParts.has(p.id)),
    chapters,
    nodes: nodes.map(({ subjects, ...n }) => n),
    edges: [...edges.values()],
    videos,
    headline: g.headline,
    paths: g.paths.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, id: resolve(s.node) })).filter((s) => s.id) })),
    intents: g.intents.map((i) => ({ ...i, nodes: mapNodes(i.nodes) })).filter((i) => i.nodes.length),
    landscape: g.landscape.map((m) => ({ ...m, id: resolve(m.node) })),
    glossary: g.glossary,
    builtAt: new Date().toISOString().slice(0, 10),
  };
  fs.mkdirSync(ws.site, { recursive: true });
  for (const f of ['index.html', 'app.js', 'style.css']) fs.copyFileSync(path.join(ROOT, 'site', f), path.join(ws.site, f));
  fs.writeFileSync(path.join(ws.site, 'data.js'), `window.KG = ${JSON.stringify(data)};\n`);
  console.log(`site: ${path.join(ws.site, 'index.html')}`);
  console.log(`nodes ${data.nodes.length}, edges ${data.edges.length}, chapters ${chapters.length}, paths ${data.paths.length}, intents ${data.intents.length}`);
}
