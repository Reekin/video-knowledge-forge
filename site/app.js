/* Knowledge map site. Everything topic-specific comes from data.js (window.KG); KG.site holds branding. */
const KG = window.KG;
const SITE = KG.site;
const view = document.getElementById('view');
const tooltip = document.getElementById('tooltip');

// Part colours come from the topic, falling back to the house palette in order.
const PALETTE = ['var(--red)', 'var(--teal)', 'var(--blue)', 'var(--ochre)', '#7a3fa0', '#3d7a2a'];
document.head.insertAdjacentHTML('beforeend', `<style>${KG.parts.map((p, i) =>
  `[data-part="${p.id}"]{--accent:${p.color || PALETTE[i % PALETTE.length]}}`).join('')}</style>`);
document.title = `${SITE.title} · ${SITE.subtitle}`;
document.querySelector('.brand-mark').textContent = SITE.mark || SITE.title.slice(0, 1);
document.querySelector('.brand-text').innerHTML = `${SITE.title.replace(/[&<]/g, '')}<small>${SITE.subtitle.replace(/[&<]/g, '')}</small>`;
document.querySelector('[data-nav="models"]').textContent = SITE.landscape.label;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nodeById = new Map(KG.nodes.map((n) => [n.id, n]));
const chapterById = new Map(KG.chapters.map((c) => [c.id, c]));
const partById = new Map(KG.parts.map((p) => [p.id, p]));
const partOf = (n) => chapterById.get(n.chapter).part;
const chapterNo = (id) => String(KG.chapters.findIndex((c) => c.id === id) + 1).padStart(2, '0');
const KIND = { model: '模型', technique: '技术', tool: '工具', concept: '概念', problem: '疑难', workflow: '流程' };
const neighbors = new Map(KG.nodes.map((n) => [n.id, []]));
for (const e of KG.edges) {
  neighbors.get(e.a)?.push({ id: e.b, rel: e.rel });
  neighbors.get(e.b)?.push({ id: e.a, rel: e.rel });
}

/* ---------- mastery (localStorage) ---------- */
const mastered = new Set(JSON.parse(localStorage.getItem('kg-mastered') || '[]'));
function toggleMastered(id) {
  mastered.has(id) ? mastered.delete(id) : mastered.add(id);
  localStorage.setItem('kg-mastered', JSON.stringify([...mastered]));
  updatePill();
}
function updatePill() {
  document.getElementById('progressPill').innerHTML = `已掌握 <b>${mastered.size}</b> / ${KG.nodes.length}`;
}

/* ---------- rich text: inline code, cross references, glossary terms ---------- */
const linkables = [
  ...KG.nodes.map((n) => ({ text: n.name, html: (t) => `<a class="xref" href="#/n/${n.id}" data-node="${n.id}">${t}</a>`, id: n.id })),
  ...KG.glossary.map((g) => ({ text: g.term, html: (t) => `<span class="term" data-term="${esc(g.term)}">${t}</span>`, id: 'g:' + g.term })),
].filter((l) => l.text && l.text.length >= 2).sort((a, b) => b.text.length - a.text.length);
const linkRe = new RegExp(linkables.map((l) => esc(l.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
const linkByText = new Map(linkables.map((l) => [esc(l.text), l]));

function rich(text, used = new Set()) {
  let html = esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  if (!linkables.length) return html;
  let inCode = false;
  return html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) { if (part === '<code>') inCode = true; if (part === '</code>') inCode = false; return part; }
    if (inCode) return part;
    return part.replace(linkRe, (m) => {
      const l = linkByText.get(m);
      if (!l || used.has(l.id)) return m;
      used.add(l.id);
      return l.html(m);
    });
  }).join('');
}

/* ---------- small builders ---------- */
const badges = (n) => `<div class="badges"><span class="badge kind">${KIND[n.kind] || n.kind}</span><span class="badge lv-${esc(n.level)}">${esc(n.level)}</span></div>`;
function nodeCard(n, i, step) {
  return `<a class="node-card rise ${mastered.has(n.id) ? 'mastered' : ''}" style="--i:${i}" data-part="${partOf(n)}" href="#/n/${n.id}">
    ${step ? `<span class="step">${String(step).padStart(2, '0')}</span>` : ''}
    ${badges(n)}<h3>${esc(n.name)}</h3><p>${esc(n.oneLiner)}</p></a>`;
}
function chain(ids) {
  return `<div class="chain">${ids.map((id) => nodeById.get(id)).filter(Boolean)
    .map((n) => `<a href="#/n/${n.id}" data-part="${partOf(n)}">${esc(n.name)}</a>`).join('<i>→</i>')}</div>`;
}

/* ---------- views ---------- */
function home() {
  const parts = KG.parts.map((p) => {
    const chs = KG.chapters.filter((c) => c.part === p.id);
    return `<div class="part rise" data-part="${p.id}">
      <div class="part-side"><div class="part-name">${esc(p.name)}</div><p>${esc(p.desc)}</p></div>
      <div class="chapters">${chs.map((c, i) => {
        const done = c.order.filter((id) => mastered.has(id)).length;
        return `<a class="ch-card rise" style="--i:${i}" href="#/c/${c.id}">
          <span class="ch-no">§${chapterNo(c.id)}</span><h3>${esc(c.name)}</h3><p>${esc(c.hook)}</p>
          <div class="ch-meta"><span>${c.order.length} 个知识点</span>${done ? `<span class="done">已掌握 ${done}</span>` : ''}</div></a>`;
      }).join('')}</div></div>`;
  }).join('');
  view.innerHTML = `
  <section class="hero"><div class="wrap hero-grid">
    <div>
      <div class="eyebrow rise">${esc(SITE.eyebrow || '')}</div>
      <h1 class="rise" style="--i:1">${esc(SITE.title.slice(0, -(SITE.accentChars ?? 2)))}<em>${esc(SITE.title.slice(-(SITE.accentChars ?? 2)))}</em></h1>
      <p class="lead rise" style="--i:2">${esc(KG.headline)}</p>
      <button class="hero-ask rise" style="--i:3" data-open-search><span>我想……</span><kbd>Ctrl K</kbd></button>
      <div class="hero-stats rise" style="--i:4">
        <div>${KG.nodes.length}<small>个知识点</small></div>
        <div>${KG.chapters.length}<small>个章节</small></div>
        <div>${KG.paths.length}<small>条学习路线</small></div>
      </div>
    </div>
    <div class="hero-art rise" style="--i:3">${heroArt()}</div>
  </div></section>
  <div class="wrap">
    <section class="section"><div class="section-head"><div><div class="eyebrow">从目标出发</div><h2>你想做成什么？</h2></div><p>挑一个最接近的目标，按顺序点开这些知识点。</p></div>
      <div class="intents" id="intents">${KG.intents.map((it, i) => `<div class="intent rise ${i >= 8 ? 'extra' : ''}" style="--i:${i % 8}" data-part="${partOf(nodeById.get(it.nodes[0]))}">
        <h3><small>我想</small>${esc(it.want.replace(/^我想/, ''))}</h3><p>${rich(it.answer)}</p>${chain(it.nodes)}</div>`).join('')}</div>
      ${KG.intents.length > 8 ? `<button class="show-more" id="moreIntents">再看 ${KG.intents.length - 8} 个目标</button>` : ''}
    </section>
    <section class="section"><div class="section-head"><div><div class="eyebrow">系统地学</div><h2>${KG.parts.length} 个板块，${KG.chapters.length} 章</h2></div><a class="more" href="#/map">在星图里看全貌 →</a></div>${parts}</section>
    <section class="section"><div class="section-head"><div><div class="eyebrow">跟着走</div><h2>学习路线</h2></div><a class="more" href="#/paths">查看全部路线 →</a></div>
      <div class="paths-grid">${KG.paths.map((p, i) => `<a class="path-card rise" style="--i:${i}" href="#/paths"><span class="num">0${i + 1}</span>
        <h3>${esc(p.name)}</h3><p>${esc(p.goal)}</p><div class="track">${p.steps.map((s) => `<i class="${mastered.has(s.id) ? 'done' : ''}"></i>`).join('')}</div></a>`).join('')}</div>
    </section>
    <section class="section" style="padding-bottom:80px"><div class="section-head"><div><div class="eyebrow">当下的主力</div><h2>${esc(SITE.landscape.label)}版图</h2></div><a class="more" href="#/models">逐个了解 →</a></div>
      <div class="chips">${KG.landscape.map((m) => `<a class="chip on" data-part="${landscapePart(m)}" href="${m.id ? '#/n/' + m.id : '#/models'}">${esc(m.model)}</a>`).join('')}</div>
    </section>
  </div>`;
  const more = document.getElementById('moreIntents');
  if (more) more.onclick = () => { document.getElementById('intents').classList.add('all'); more.remove(); };
}

function heroArt() {
  // A miniature of the real constellation; the whole thing links to the full map.
  const { nodes, links } = layout();
  const xs = nodes.map((d) => d.x), ys = nodes.map((d) => d.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const s = 560 / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  const P = (d) => [20 + (d.x - minX) * s, 20 + (d.y - minY) * s];
  const partCenter = KG.parts.map((p) => {
    const mine = nodes.filter((d) => partOf(d.n) === p.id).map(P);
    return { p, x: mine.reduce((a, q) => a + q[0], 0) / mine.length, y: mine.reduce((a, q) => a + q[1], 0) / mine.length };
  });
  return `<a href="#/map" title="打开知识星图"><svg viewBox="0 0 600 600">
    ${links.map(([a, b]) => { const [x1, y1] = P(nodes[a]), [x2, y2] = P(nodes[b]); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--ink)" stroke-opacity=".07"/>`; }).join('')}
    ${nodes.map((d, i) => { const [x, y] = P(d); return `<circle class="star" style="--d:${(i * 0.37) % 6}s" data-part="${partOf(d.n)}" cx="${x}" cy="${y}" r="${Math.max(2, d.r * s * 0.9)}" fill="var(--accent)"/>`; }).join('')}
    ${partCenter.map((c) => `<text class="lbl" data-part="${c.p.id}" x="${c.x}" y="${c.y}" text-anchor="middle">${esc(c.p.name)}</text>`).join('')}
  </svg></a>`;
}

function chaptersPage() {
  view.innerHTML = `<div class="wrap"><div class="page-head"><div class="eyebrow">目录</div><h1>全部章节</h1><p>从地基到创作，按板块排好了学习顺序。</p></div>
  ${KG.parts.map((p) => `<div class="toc-part" data-part="${p.id}"><h2>${esc(p.name)}</h2>
    ${KG.chapters.filter((c) => c.part === p.id).map((c) => `<div class="toc-ch rise"><div class="n">${chapterNo(c.id)}</div><div>
      <h3><a href="#/c/${c.id}">${esc(c.name)}</a></h3><p>${esc(c.hook)}</p>
      <div class="toc-nodes">${c.order.map((id) => nodeById.get(id)).filter(Boolean).map((n) => `<a class="${mastered.has(n.id) ? 'mastered' : ''}" href="#/n/${n.id}">${esc(n.name)}</a>`).join('')}</div></div></div>`).join('')}</div>`).join('')}
  <div style="height:80px"></div></div>`;
}

function chapterPage(id) {
  const c = chapterById.get(id);
  if (!c) return notFound();
  const p = partById.get(c.part);
  const nodes = c.order.map((nid) => nodeById.get(nid)).filter(Boolean);
  const idx = KG.chapters.indexOf(c);
  const prev = KG.chapters[idx - 1], next = KG.chapters[idx + 1];
  view.innerHTML = `<div data-part="${c.part}"><div class="wrap">
    <div class="ch-hero"><div class="crumbs rise"><a href="#/chapters">章节</a><span>/</span><span>${esc(p.name)}</span></div>
      <div class="ch-hero-grid"><div class="big-no rise">${chapterNo(c.id)}</div>
      <div><h1 class="rise" style="--i:1">${esc(c.name)}</h1><p class="hook rise" style="--i:2">${esc(c.hook)}</p></div></div></div>
    <div class="model-block"><p class="mental rise" style="--i:3">${rich(c.mentalModel)}</p>
      <div class="rise" style="--i:4"><div class="eyebrow" style="margin-bottom:8px">记住这几条</div><ol class="takeaways">${(c.takeaways || []).map((t) => `<li>${rich(t)}</li>`).join('')}</ol></div></div>
    <div class="section-head"><div><div class="eyebrow">按这个顺序学</div><h2>本章知识点</h2></div></div>
    <div class="node-grid">${nodes.map((n, i) => nodeCard(n, i, i + 1)).join('')}</div>
    <div class="pager" style="padding-bottom:80px">
      ${prev ? `<a href="#/c/${prev.id}"><small>上一章</small>§${chapterNo(prev.id)} ${esc(prev.name)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="#/c/${next.id}"><small>下一章</small>§${chapterNo(next.id)} ${esc(next.name)}</a>` : ''}
    </div></div></div>`;
}

function egoGraph(n) {
  const rel = neighbors.get(n.id).slice(0, 8);
  const W = 300, H = 240, cx = W / 2, cy = H / 2;
  const items = rel.map((r, i) => {
    const a = -Math.PI / 2 + (i / rel.length) * Math.PI * 2;
    const m = nodeById.get(r.id);
    return { m, x: cx + 108 * Math.cos(a), y: cy + 84 * Math.sin(a), rel: r.rel };
  });
  return `<svg viewBox="0 0 ${W} ${H}">
    ${items.map((it) => `<line class="e" x1="${cx}" y1="${cy}" x2="${it.x}" y2="${it.y}"/>`).join('')}
    ${items.map((it) => `<g class="r" data-href="#/n/${it.m.id}" data-part="${partOf(it.m)}"><circle cx="${it.x}" cy="${it.y}" r="7" fill="var(--accent)"/>
      <text x="${it.x}" y="${it.y + (it.y > cy ? 22 : -13)}" text-anchor="middle">${esc(it.m.name.length > 10 ? it.m.name.slice(0, 10) + '…' : it.m.name)}</text></g>`).join('')}
    <g class="c"><circle cx="${cx}" cy="${cy}" r="14" fill="var(--accent)"/><text x="${cx}" y="${cy + 32}" text-anchor="middle">${esc(n.name.length > 12 ? n.name.slice(0, 12) + '…' : n.name)}</text></g></svg>`;
}

function nodePage(id) {
  const n = nodeById.get(id);
  if (!n) return notFound();
  const c = chapterById.get(n.chapter);
  const used = new Set([n.id]);
  const pos = c.order.indexOf(n.id);
  const prev = nodeById.get(c.order[pos - 1]), next = nodeById.get(c.order[pos + 1]);
  const rels = neighbors.get(n.id);
  const vids = (n.videos || []).map((b) => [b, KG.videos[b]]).filter(([, v]) => v);
  view.innerHTML = `<div class="wrap" data-part="${partOf(n)}"><div class="node-page">
    <article>
      <div class="node-head">
        <div class="crumbs rise"><a href="#/chapters">${esc(partById.get(c.part).name)}</a><span>/</span><a href="#/c/${c.id}">§${chapterNo(c.id)} ${esc(c.name)}</a></div>
        <h1 class="rise" style="--i:1">${esc(n.name)}</h1>
        <p class="one rise" style="--i:2">${esc(n.oneLiner)}</p>
        <div class="node-actions rise" style="--i:3">${badges(n)}<button class="master-btn ${mastered.has(n.id) ? 'on' : ''}" id="masterBtn">${mastered.has(n.id) ? '已掌握 ✓' : '标记为已掌握'}</button></div>
      </div>
      <div class="essence rise" style="--i:4">${rich(n.essence, used)}</div>
      ${n.steps?.length ? `<section class="block rise" style="--i:5"><h2>怎么做</h2><ol class="steps">${n.steps.map((s) => `<li>${rich(s, used)}</li>`).join('')}</ol></section>` : ''}
      ${n.params?.length ? `<section class="block rise" style="--i:6"><h2>参数速查</h2><table class="spec">${n.params.map((p) => `<tr><td>${rich(p.name, used)}</td><td><span class="val">${esc(p.value)}</span><span class="note">${rich(p.note, used)}</span></td></tr>`).join('')}</table></section>` : ''}
      ${n.pitfalls?.length ? `<section class="block rise" style="--i:7"><h2>踩坑与解法</h2><div class="qa">${n.pitfalls.map((p, i) => `<details ${i < 2 ? 'open' : ''}><summary>${esc(p.q)}</summary><div class="a">${rich(p.a, used)}</div></details>`).join('')}</div></section>` : ''}
      ${n.tips?.length ? `<section class="block rise" style="--i:8"><h2>进阶心得</h2><ul class="tips">${n.tips.map((t) => `<li>${rich(t, used)}</li>`).join('')}</ul></section>` : ''}
    </article>
    <aside class="aside">
      ${rels.length ? `<div class="panel ego"><h4>关联图</h4>${egoGraph(n)}</div>
      <div class="panel"><h4>接着看</h4><div class="rel-list">${rels.map((r) => {
        const m = nodeById.get(r.id);
        return `<a href="#/n/${m.id}" data-node="${m.id}"><span>${esc(m.name)}</span><small>${esc(r.rel)}</small></a>`;
      }).join('')}</div></div>` : ''}
      <div class="pager">${prev ? `<a href="#/n/${prev.id}"><small>本章上一个</small>${esc(prev.name)}</a>` : ''}${next ? `<a class="next" href="#/n/${next.id}"><small>本章下一个</small>${esc(next.name)}</a>` : ''}</div>
      ${vids.length ? `<div class="panel watch"><h4>想看原片</h4>${vids.map(([, v]) => {
        const inner = `${esc(v.title)}<small>${esc(v.creator)} · ${esc(v.date)}</small>`;
        return /^https?:/.test(v.url) ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${inner}</a>` : `<a>${inner}</a>`;
      }).join('')}</div>` : ''}
    </aside></div></div>`;
  document.getElementById('masterBtn').onclick = (e) => {
    toggleMastered(n.id);
    e.target.classList.toggle('on', mastered.has(n.id));
    e.target.textContent = mastered.has(n.id) ? '已掌握 ✓' : '标记为已掌握';
  };
  view.querySelectorAll('.ego g.r').forEach((g) => { g.onclick = () => { location.hash = g.dataset.href; }; });
}

function pathsPage() {
  view.innerHTML = `<div class="wrap"><div class="page-head"><div class="eyebrow">学习路线</div><h1>跟着一条线走</h1><p>点圆点标记掌握，进度只保存在这台电脑的浏览器里。</p></div>
  <div class="paths-page">${KG.paths.map((p, i) => {
    const done = p.steps.filter((s) => mastered.has(s.id)).length;
    return `<div class="line rise" style="--i:${i}"><div class="line-head"><div class="eyebrow" style="color:#fff;opacity:.7">路线 0${i + 1} · ${done}/${p.steps.length}</div><h2>${esc(p.name)}</h2><p>${esc(p.goal)}</p>
      <div class="line-bar"><i style="width:${(done / p.steps.length) * 100}%"></i></div></div>
      <ol class="stations">${p.steps.map((s) => {
        const n = nodeById.get(s.id);
        return `<li class="${mastered.has(s.id) ? 'done' : ''}"><button class="dot" data-toggle="${s.id}" title="标记掌握"></button><a href="#/n/${s.id}">${esc(n.name)}</a><small>${esc(s.why)}</small></li>`;
      }).join('')}</ol></div>`;
  }).join('')}</div></div>`;
  view.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = () => { toggleMastered(b.dataset.toggle); pathsPage(); }; });
}

function modelsPage() {
  const col = (g) => `<div class="models-col" data-part="${g.part}"><h2>${esc(g.name)}<small>${esc(g.en || '')}</small></h2>
    ${KG.landscape.filter((m) => m.group === g.id).map((m, i) => `<a class="model-card rise" style="--i:${i}" href="${m.id ? '#/n/' + m.id : '#/models'}">
      <h3>${esc(m.model)}</h3><div class="role">${esc(m.role)}</div><dl><dt>擅长</dt><dd>${esc(m.strengths)}</dd><dt>短板</dt><dd>${esc(m.limits)}</dd></dl></a>`).join('')}</div>`;
  view.innerHTML = `<div class="wrap"><div class="page-head"><div class="eyebrow">${esc(SITE.landscape.label)}版图</div><h1>${esc(SITE.landscape.title)}</h1><p>${esc(SITE.landscape.desc)}</p></div>
    <div class="models-page" style="grid-template-columns:repeat(${SITE.landscape.groups.length},1fr)">${SITE.landscape.groups.map(col).join('')}</div></div>`;
}

function landscapePart(m) {
  return SITE.landscape.groups.find((g) => g.id === m.group)?.part || KG.parts[0].id;
}

function glossaryPage() {
  const draw = (q = '') => {
    const list = KG.glossary.filter((g) => !q || g.term.toLowerCase().includes(q) || g.plain.includes(q));
    document.getElementById('gloss').innerHTML = list.map((g) => `<div><b>${esc(g.term)}</b><span>${rich(g.plain, new Set(['g:' + g.term]))}</span></div>`).join('');
  };
  view.innerHTML = `<div class="wrap"><div class="page-head"><div class="eyebrow">术语表</div><h1>听不懂的词，先查这里</h1><p>正文里带虚线下划线的词，鼠标停上去也能看到解释。</p></div>
    <div class="gloss-tools"><input id="glossQ" placeholder="筛选术语"></div><div class="gloss" id="gloss"></div></div>`;
  draw();
  document.getElementById('glossQ').oninput = (e) => draw(e.target.value.trim().toLowerCase());
}

function notFound() {
  view.innerHTML = `<div class="wrap"><div class="page-head"><h1>没有这一页</h1><p><a class="more" href="#/">回到首页</a></p></div></div>`;
}

/* ---------- constellation map ---------- */
let layoutCache;
function layout() {
  if (layoutCache) return layoutCache;
  const nodes = KG.nodes.map((n) => ({ n, r: 5 + Math.sqrt(n.weight || 1) * 1.7 }));
  const idx = new Map(nodes.map((d, i) => [d.n.id, i]));
  const chs = KG.chapters;
  // Chapters sit on one ring, parts separated by gaps, so related chapters stay neighbours.
  const slots = chs.length + KG.parts.length * 0.6;
  const anchors = new Map();
  let k = 0, prevPart = null;
  for (const c of chs) {
    if (c.part !== prevPart) { k += 0.6; prevPart = c.part; }
    const a = (k / slots) * Math.PI * 2 - Math.PI / 2;
    anchors.set(c.id, { x: Math.cos(a) * 980, y: Math.sin(a) * 760 });
    k++;
  }
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const d of nodes) { const a = anchors.get(d.n.chapter); d.x = a.x + (rand() - .5) * 80; d.y = a.y + (rand() - .5) * 80; }
  const links = KG.edges.map((e) => [idx.get(e.a), idx.get(e.b)]).filter(([a, b]) => a !== undefined && b !== undefined);
  for (let it = 0; it < 360; it++) {
    const t = 1 - it / 360;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const q = nodes[j];
        const dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy + .01;
        if (d2 > 22500) continue;
        const min = p.r + q.r + 40;
        const f = (d2 < min * min ? 3 : 1) * 900 / d2 * (0.3 + 0.7 * t);
        p.x += dx * f; p.y += dy * f; q.x -= dx * f; q.y -= dy * f;
      }
    }
    for (const [a, b] of links) {
      if (nodes[a].n.chapter !== nodes[b].n.chapter) continue;
      const p = nodes[a], q = nodes[b];
      const dx = q.x - p.x, dy = q.y - p.y;
      const f = .01 * t;
      p.x += dx * f; p.y += dy * f; q.x -= dx * f; q.y -= dy * f;
    }
    for (const d of nodes) { const a = anchors.get(d.n.chapter); d.x += (a.x - d.x) * .05; d.y += (a.y - d.y) * .05; }
  }
  // Chapter labels sit just outside each cluster, pushed away from the ring centre.
  const cent = new Map();
  for (const c of chs) {
    const mine = nodes.filter((d) => d.n.chapter === c.id);
    const mx = mine.reduce((s, d) => s + d.x, 0) / mine.length, my = mine.reduce((s, d) => s + d.y, 0) / mine.length;
    const reach = Math.max(...mine.map((d) => Math.hypot(d.x - mx, d.y - my) + d.r));
    const len = Math.hypot(mx, my) || 1, ux = mx / len, uy = my / len;
    cent.set(c.id, { x: mx + ux * (reach + 30), y: my + uy * (reach + 30), anchor: ux > 0.35 ? 'start' : ux < -0.35 ? 'end' : 'middle' });
  }
  layoutCache = { nodes, links, cent };
  return layoutCache;
}

function mapPage() {
  const { nodes, links, cent } = layout();
  const xs = nodes.map((d) => d.x), ys = nodes.map((d) => d.y);
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  // Extra room on the left keeps the overlay panel off the clusters.
  const box = { x: Math.min(...xs) - 420 - spanX * 0.12, y: Math.min(...ys) - 140, w: spanX * 1.12 + 420 + 420, h: spanY + 280 };
  // Label the heaviest node or two of each chapter at overview zoom; the rest appear when zoomed in.
  const top = new Set(KG.chapters.flatMap((c) => nodes.filter((d) => d.n.chapter === c.id).sort((a, b) => b.r - a.r).slice(0, 3).map((d) => d.n.id)));
  view.innerHTML = `<div class="map-page">
    <svg id="mapSvg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}">
      <g id="mapG">
        ${KG.chapters.map((c) => { const p = cent.get(c.id); return `<text class="m-chapter" data-part="${c.part}" x="${p.x}" y="${p.y}" text-anchor="${p.anchor}" dominant-baseline="middle"><a href="#/c/${c.id}">${esc(c.name)}</a></text>`; }).join('')}
        ${links.map(([a, b], i) => { const p = nodes[a], q = nodes[b]; const cross = p.n.chapter !== q.n.chapter;
          const pull = cross ? .55 : .92, mx = (p.x + q.x) / 2 * pull, my = (p.y + q.y) / 2 * pull;
          return `<path class="m-edge ${cross ? 'x' : ''}" data-e="${i}" d="M${p.x},${p.y} Q${mx},${my} ${q.x},${q.y}"/>`; }).join('')}
        ${nodes.map((d) => `<g class="m-node ${top.has(d.n.id) ? 'big' : ''} ${mastered.has(d.n.id) ? 'mastered' : ''}" data-id="${d.n.id}" data-part="${partOf(d.n)}" data-lv="${esc(d.n.level)}">
          <circle cx="${d.x}" cy="${d.y}" r="${d.r}"/><text x="${d.x}" y="${d.y + d.r}" dy="1.15em" text-anchor="middle">${esc(d.n.name)}</text></g>`).join('')}
      </g></svg>
    <div class="map-ui"><h1>知识星图</h1><p>每颗星是一个知识点，越大说明这方面的经验越多；连线代表它们需要搭配着学。</p>
      <div class="chips" id="partChips">${KG.parts.map((p) => `<button class="chip on" data-part="${p.id}" data-p="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      <div class="chips" id="lvChips">${['入门', '进阶', '高阶'].map((l) => `<button class="chip lv on" data-l="${l}">${l}</button>`).join('')}</div></div>
    <div class="map-legend">${KG.parts.map((p) => `<span data-part="${p.id}">${esc(p.name)}</span>`).join('')}</div>
    <div class="map-hint">拖动平移 · 滚轮缩放 · 点击星星查看</div>
    <div id="mapCard"></div></div>`;

  const svg = document.getElementById('mapSvg');
  const g = document.getElementById('mapG');
  let vb = { ...box };
  const apply = () => {
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    // --k converts screen pixels to SVG units, so labels keep a constant on-screen size.
    const r = svg.getBoundingClientRect();
    svg.style.setProperty('--k', Math.max(vb.w / r.width, vb.h / r.height));
    svg.classList.toggle('zoomed-out', vb.w > box.w * 0.45);
  };
  apply();
  const toSvg = (ev) => { const r = svg.getBoundingClientRect(); return { x: vb.x + (ev.clientX - r.left) / r.width * vb.w, y: vb.y + (ev.clientY - r.top) / r.height * vb.h }; };
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = toSvg(ev), s = Math.exp(ev.deltaY * .0012);
    const w = Math.min(box.w * 1.6, Math.max(box.w * .12, vb.w * s)), f = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * f, y: p.y - (p.y - vb.y) * f, w, h: vb.h * f };
    apply();
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, vb: { ...vb }, moved: false }; svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const dx = (ev.clientX - drag.x) / r.width * vb.w, dy = (ev.clientY - drag.y) / r.height * vb.h;
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 4) { drag.moved = true; svg.classList.add('dragging'); }
    vb.x = drag.vb.x - dx; vb.y = drag.vb.y - dy; apply();
  });
  svg.addEventListener('pointerup', (ev) => {
    svg.classList.remove('dragging');
    const wasDrag = drag?.moved; drag = null;
    if (wasDrag) return;
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const chapterLink = hit?.closest('.m-chapter a');
    if (chapterLink) { location.hash = chapterLink.getAttribute('href'); return; }
    const el = hit?.closest('.m-node');
    if (el) openMapCard(el.dataset.id); else closeMapCard();
  });

  const edgesOf = new Map(nodes.map((d) => [d.n.id, []]));
  links.forEach(([a, b], i) => { edgesOf.get(nodes[a].n.id).push(i); edgesOf.get(nodes[b].n.id).push(i); });
  let pinned = null;
  const focus = (id) => {
    g.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
    svg.classList.toggle('focus', !!id);
    if (!id) return;
    g.querySelector(`.m-node[data-id="${id}"]`).classList.add('hl');
    for (const r of neighbors.get(id)) g.querySelector(`.m-node[data-id="${r.id}"]`)?.classList.add('hl');
    for (const i of edgesOf.get(id)) g.querySelector(`[data-e="${i}"]`).classList.add('hl');
  };
  g.addEventListener('mouseover', (ev) => { const el = ev.target.closest('.m-node'); if (el && !pinned) focus(el.dataset.id); });
  g.addEventListener('mouseout', (ev) => { if (ev.target.closest('.m-node') && !pinned) focus(null); });

  function openMapCard(id) {
    pinned = id; focus(id);
    flyTo(id);
    const n = nodeById.get(id);
    document.getElementById('mapCard').innerHTML = `<div class="map-card" data-part="${partOf(n)}"><button class="close" id="mapClose">×</button>
      <div class="crumbs">§${chapterNo(n.chapter)} ${esc(chapterById.get(n.chapter).name)}</div><h2>${esc(n.name)}</h2>${badges(n)}
      <p class="one" style="margin-top:12px">${esc(n.oneLiner)}</p><p class="ess">${rich(n.essence)}</p>
      <a class="go" href="#/n/${n.id}">展开学习 →</a>
      <div class="rel-list">${neighbors.get(id).map((r) => `<a href="javascript:void 0" data-jump="${r.id}"><span>${esc(nodeById.get(r.id).name)}</span><small>${esc(r.rel)}</small></a>`).join('')}</div></div>`;
    document.getElementById('mapClose').onclick = closeMapCard;
    document.querySelectorAll('[data-jump]').forEach((a) => { a.onclick = () => openMapCard(a.dataset.jump); });
  }
  function closeMapCard() { pinned = null; focus(null); document.getElementById('mapCard').innerHTML = ''; }
  function flyTo(id) {
    const d = nodes.find((x) => x.n.id === id);
    const ids = [id, ...neighbors.get(id).map((r) => r.id)];
    const pts = nodes.filter((x) => ids.includes(x.n.id));
    const r = svg.getBoundingClientRect();
    const reach = Math.max(260, ...pts.map((p) => Math.hypot(p.x - d.x, p.y - d.y))) * 2.4;
    const w = Math.min(box.w, Math.max(reach, box.w * 0.3)), h = w * r.height / r.width;
    // Shift left so the node is centred in the space the info card leaves free.
    const target = { x: d.x - w * 0.38, y: d.y - h / 2, w, h };
    const from = { ...vb }, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 650), e = 1 - Math.pow(1 - k, 3);
      vb = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e };
      apply();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const filters = { parts: new Set(KG.parts.map((p) => p.id)), lv: new Set(['入门', '进阶', '高阶']) };
  const refilter = () => g.querySelectorAll('.m-node').forEach((el) => el.classList.toggle('dim', !filters.parts.has(el.dataset.part) || !filters.lv.has(el.dataset.lv)));
  document.querySelectorAll('#partChips .chip').forEach((b) => { b.onclick = () => { b.classList.toggle('on'); filters.parts[b.classList.contains('on') ? 'add' : 'delete'](b.dataset.p); refilter(); }; });
  document.querySelectorAll('#lvChips .chip').forEach((b) => { b.onclick = () => { b.classList.toggle('on'); filters.lv[b.classList.contains('on') ? 'add' : 'delete'](b.dataset.l); refilter(); }; });
}

/* ---------- search palette ---------- */
const palette = document.getElementById('palette');
const pInput = document.getElementById('paletteInput');
const pList = document.getElementById('paletteList');
const searchIndex = [
  ...KG.intents.map((it) => ({ group: '目标', t: it.want, d: it.answer, href: `#/n/${it.nodes[0]}`, k: '我想', part: partOf(nodeById.get(it.nodes[0])), hay: (it.want + it.answer).toLowerCase() })),
  ...KG.nodes.map((n) => ({ group: '知识点', t: n.name, d: n.oneLiner, href: `#/n/${n.id}`, k: KIND[n.kind] || n.kind, part: partOf(n), name: n.name.toLowerCase(), hay: (n.name + n.oneLiner + n.essence).toLowerCase() })),
  ...KG.chapters.map((c) => ({ group: '章节', t: c.name, d: c.hook, href: `#/c/${c.id}`, k: '§' + chapterNo(c.id), part: c.part, name: c.name.toLowerCase(), hay: (c.name + c.hook).toLowerCase() })),
  ...KG.glossary.map((g) => ({ group: '术语', t: g.term, d: g.plain, href: '#/glossary', k: '术语', part: KG.parts.at(-1).id, name: g.term.toLowerCase(), hay: (g.term + g.plain).toLowerCase() })),
];
let pItems = [], pSel = 0;
function searchScore(item, q) {
  if (!q) return item.group === '目标' ? 1 : 0;
  if (item.name === q) return 100;
  if (item.name?.startsWith(q)) return 60;
  if (item.name?.includes(q)) return 40;
  if (item.t.toLowerCase().includes(q)) return 30;
  const words = q.split(/\s+/).filter(Boolean);
  const hits = words.filter((w) => item.hay.includes(w)).length;
  if (hits === words.length) return 10 + hits;
  const chars = [...q.replace(/\s/g, '')];
  return chars.length > 1 && chars.filter((ch) => item.hay.includes(ch)).length / chars.length > 0.8 ? 2 : 0;
}
function drawPalette() {
  const q = pInput.value.trim().toLowerCase();
  pItems = searchIndex.map((it) => ({ it, s: searchScore(it, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 14).map((x) => x.it);
  pSel = 0;
  let last = '';
  pList.innerHTML = pItems.map((it, i) => {
    const head = it.group !== last ? `<div class="p-group">${it.group}</div>` : '';
    last = it.group;
    return `${head}<div class="p-item ${i === 0 ? 'sel' : ''}" data-i="${i}" data-part="${it.part}"><span class="k">${esc(it.k)}</span><span class="t">${esc(it.t)}</span><span class="d">${esc(it.d)}</span></div>`;
  }).join('') || '<div class="p-group">没有找到，换个说法试试</div>';
}
function openPalette() { palette.hidden = false; pInput.value = ''; drawPalette(); pInput.focus(); }
function closePalette() { palette.hidden = true; }
function choose(i) { const it = pItems[i]; if (!it) return; closePalette(); location.hash = it.href; }
pInput.addEventListener('input', drawPalette);
pInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    pSel = (pSel + (e.key === 'ArrowDown' ? 1 : -1) + pItems.length) % pItems.length;
    pList.querySelectorAll('.p-item').forEach((el) => el.classList.toggle('sel', +el.dataset.i === pSel));
    pList.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') choose(pSel);
});
pList.addEventListener('click', (e) => { const el = e.target.closest('.p-item'); if (el) choose(+el.dataset.i); });
palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); }
  if (e.key === 'Escape') closePalette();
  if (e.key === '/' && palette.hidden && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); openPalette(); }
});
document.getElementById('openSearch').onclick = openPalette;
document.addEventListener('click', (e) => { if (e.target.closest('[data-open-search]')) openPalette(); });

/* ---------- hover tooltips for terms and cross references ---------- */
const glossByTerm = new Map(KG.glossary.map((g) => [g.term, g.plain]));
document.addEventListener('mouseover', (e) => {
  const term = e.target.closest('.term');
  const ref = e.target.closest('[data-node]');
  let html = '';
  if (term) html = `<b>${esc(term.dataset.term)}</b>${esc(glossByTerm.get(term.dataset.term))}`;
  else if (ref && !ref.closest('.m-node')) { const n = nodeById.get(ref.dataset.node); if (n) html = `<b>${esc(n.name)}</b>${esc(n.oneLiner)}`; }
  if (!html) return;
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = (term || ref).getBoundingClientRect();
  tooltip.style.left = Math.min(window.innerWidth - 320, Math.max(8, r.left)) + 'px';
  tooltip.style.top = (r.bottom + 8) + 'px';
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('.term, [data-node]')) tooltip.hidden = true; });

/* ---------- router ---------- */
function route() {
  tooltip.hidden = true;
  const [, page, arg] = location.hash.split('/');
  const pages = { '': home, map: mapPage, chapters: chaptersPage, c: () => chapterPage(arg), n: () => nodePage(decodeURIComponent(arg || '')), paths: pathsPage, models: modelsPage, glossary: glossaryPage };
  (pages[page || ''] || notFound)();
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === page || (page === 'c' && a.dataset.nav === 'chapters')));
  if (page !== 'map') window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
updatePill();
route();
