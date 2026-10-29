// Bilibili source: calls the web APIs directly with the cookie that `BBDown login` stores, so the
// listing, stats and comments run under the same account that downloads the videos.
//
// Source specs (topic.sources[]):
//   { type: 'bilibili-follow-tag', mid: '<your uid>', tag: '<follow group id>' }   a follow group (needs that account's login)
//   { type: 'bilibili-up', mids: ['<uid>', ...] }                                  specific creators
//   { type: 'bilibili-fav', mediaId: '<favorite folder id>' }                       a favorites folder, grouped by creator
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sleep } from '../context.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const RETRY_CODES = new Set([-352, -412, -509, -799, -999]);
const GONE_CODES = new Set([-404, 62002, 62012, 62004]);

export function bbdownPath() {
  if (process.env.BBDOWN_PATH) return process.env.BBDOWN_PATH;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(cmd, ['BBDown'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {
    throw new Error('BBDown not found: install it (dotnet tool install --global BBDown) or set BBDOWN_PATH');
  }
}

// BBDown keeps the login cookie in BBDown.data next to its executable.
function loginCookie() {
  if (process.env.BILI_COOKIE) return process.env.BILI_COOKIE;
  const file = path.join(path.dirname(bbdownPath()), 'BBDown.data');
  if (!fs.existsSync(file)) throw new Error(`not logged in: run "node forge.mjs login" (expected ${file})`);
  return fs.readFileSync(file, 'utf8').trim();
}

let cookie, nav_;
async function getCookie() {
  if (cookie) return cookie;
  cookie = loginCookie().replace(/;\s*$/, '');
  // Space and comment APIs answer -352 without a device fingerprint cookie; a QR login does not carry one.
  if (!/(^|;\s*)buvid3=/.test(cookie)) {
    const spi = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA } })).json();
    cookie += `; buvid3=${spi.data.b_3}; buvid4=${encodeURIComponent(spi.data.b_4)}`;
  }
  const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': UA, Cookie: cookie } })).json();
  // Logged-out requests still succeed but comment pages shrink to 3 entries, so stop instead of silently degrading.
  if (!nav.data?.isLogin) throw new Error('Bilibili login expired or missing: run "node forge.mjs login"');
  nav_ = nav;
  return cookie;
}

async function rawGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: await getCookie() },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { code: -999, message: `HTTP ${res.status}: ${text.slice(0, 120)}` }; }
}

// GET with backoff on rate limiting; returns the JSON body (code 0 or a terminal error code).
async function api(url, label = url) {
  for (let i = 0; ; i++) {
    const j = await rawGet(typeof url === 'function' ? await url() : url);
    if (j.code === 0 || GONE_CODES.has(j.code) || !RETRY_CODES.has(j.code) || i >= 5) return j;
    console.error(`${label}: code ${j.code} ${j.message}, retry ${i + 1}`);
    await sleep(5000 * (i + 1));
  }
}

const ok = (j, label) => {
  if (j.code !== 0) throw new Error(`${label}: ${j.code} ${j.message}`);
  return j.data;
};

// WBI signing for the space and comment APIs.
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let mixinKey;
async function signedUrl(base, params) {
  if (!mixinKey) {
    await getCookie();
    const name = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0];
    const raw = name(nav_.data.wbi_img.img_url) + name(nav_.data.wbi_img.sub_url);
    mixinKey = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  }
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${base}?${query}&w_rid=${wRid}`;
}

const creatorOf = (mid, name, sign = '') => ({ id: String(mid), name, sign, url: `https://space.bilibili.com/${mid}` });

async function uploads(mid) {
  const ids = [];
  for (let pn = 1; ; pn++) {
    const data = ok(await api(() => signedUrl('https://api.bilibili.com/x/space/wbi/arc/search', {
      mid, ps: 50, pn, order: 'pubdate', platform: 'web', web_location: 1550101,
      dm_img_list: '[]', dm_img_str: 'V2ViR0wgMS4w', dm_cover_img_str: 'QU5HTEUgKEludGVsKQ', dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    }), `uploads ${mid} p${pn}`), `uploads ${mid}`);
    const list = data.list.vlist;
    ids.push(...list.map((v) => v.bvid));
    if (ids.length >= data.page.count || list.length === 0) return ids;
    await sleep(1200);
  }
}

async function creatorCard(mid) {
  const data = ok(await api(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`), `card ${mid}`);
  return creatorOf(mid, data.card.name, data.card.sign);
}

// Yields { creator, ids } groups for one source spec.
async function* groups(spec) {
  if (spec.type === 'bilibili-follow-tag') {
    for (let pn = 1; ; pn++) {
      const list = ok(await api(`https://api.bilibili.com/x/relation/tag?mid=${spec.mid}&tagid=${spec.tag}&pn=${pn}&ps=50`), 'follow tag');
      for (const u of list) yield { creator: creatorOf(u.mid, u.uname, u.sign), ids: () => uploads(u.mid) };
      if (list.length < 50) return;
    }
  }
  if (spec.type === 'bilibili-up') {
    for (const mid of spec.mids) {
      const creator = await creatorCard(mid);
      yield { creator, ids: () => uploads(mid) };
    }
  }
  if (spec.type === 'bilibili-fav') {
    const byUpper = new Map();
    for (let pn = 1; ; pn++) {
      const data = ok(await api(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${spec.mediaId}&pn=${pn}&ps=20&platform=web`), 'favorites');
      for (const m of data.medias || []) {
        if (m.type !== 2) continue; // videos only
        const key = String(m.upper.mid);
        if (!byUpper.has(key)) byUpper.set(key, { creator: creatorOf(m.upper.mid, m.upper.name), list: [] });
        byUpper.get(key).list.push(m.bvid);
      }
      if (!data.has_more) break;
      await sleep(600);
    }
    for (const { creator, list } of byUpper.values()) yield { creator, ids: async () => list };
  }
}

async function detail(bvid) {
  const j = await api(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, bvid);
  if (j.code !== 0) return null;
  const d = j.data;
  return {
    id: d.bvid, url: `https://www.bilibili.com/video/${d.bvid}`, title: d.title, desc: d.desc,
    pubdate: d.pubdate, duration: d.duration, pages: d.videos, aid: d.aid,
    stat: { view: d.stat.view, like: d.stat.like, coin: d.stat.coin, favorite: d.stat.favorite,
      reply: d.stat.reply, share: d.stat.share, danmaku: d.stat.danmaku },
  };
}

const slim = (r, creatorId) => ({
  user: r.member?.uname, isCreator: String(r.mid) === String(creatorId), like: r.like, text: r.content?.message || '',
  pictures: r.content?.pictures?.length || 0, replies: (r.replies || []).map((c) => slim(c, creatorId)),
});

// Pinned comments plus up to `pages` pages of hot comments, with full reply threads (capped).
async function comments(meta, { pages = 5, threadLimit = 40 } = {}) {
  const aid = meta.aid ?? (await detail(meta.id)).aid;
  const roots = new Map();
  let pinned = [], offset = '';
  for (let pn = 0; pn < pages; pn++) {
    const j = await api(() => signedUrl('https://api.bilibili.com/x/v2/reply/wbi/main',
      { oid: aid, type: 1, mode: 3, plat: 1, web_location: 1315875, pagination_str: JSON.stringify({ offset }) }), `comments ${meta.id}`);
    if (j.code !== 0) { console.error(`  ${meta.id}: comments ${j.code} ${j.message}`); break; }
    if (pn === 0) pinned = [...new Map([j.data.top?.upper, ...(j.data.top_replies || [])].filter(Boolean).map((r) => [r.rpid, r])).values()];
    for (const r of j.data.replies || []) roots.set(r.rpid, r);
    offset = j.data.cursor?.pagination_reply?.next_offset;
    if (!offset || j.data.cursor?.is_end) break;
    await sleep(400);
  }
  for (const r of [...pinned, ...roots.values()].filter((x) => x.rcount > (x.replies?.length || 0))) {
    const subs = [];
    for (let pn = 1; subs.length < Math.min(r.rcount, threadLimit); pn++) {
      const j = await api(`https://api.bilibili.com/x/v2/reply/reply?oid=${aid}&type=1&root=${r.rpid}&ps=20&pn=${pn}`, `thread ${r.rpid}`);
      const got = j.data?.replies || [];
      subs.push(...got);
      if (got.length < 20) break;
    }
    if (subs.length) r.replies = subs;
    await sleep(300);
  }
  const pinnedIds = new Set(pinned.map((r) => r.rpid));
  return {
    total: meta.stat.reply,
    pinned: pinned.map((r) => slim(r, meta.creatorId)),
    hot: [...roots.values()].filter((r) => !pinnedIds.has(r.rpid)).map((r) => slim(r, meta.creatorId)),
  };
}

export default {
  types: ['bilibili-follow-tag', 'bilibili-up', 'bilibili-fav'],
  throttleMs: 400,
  // Weighted interaction rates used by ranking; favorites and coins are the strongest "worth keeping" signals.
  rateWeights: { favorite: 0.4, coin: 0.25, like: 0.2, reply: 0.15 },
  groups,
  detail,
  comments,
  understandArgs: (meta, page) => ['--bili-url', meta.id, '--page', String(page)],
  // QR login in the terminal; the cookie lands in BBDown.data, which this source and the downloader share.
  login: () => ({ cmd: bbdownPath(), args: ['login'] }),
  checkLogin: async () => { await getCookie(); return `logged in as ${nav_.data.uname}`; },
};
