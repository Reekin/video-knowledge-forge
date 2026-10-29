// YouTube source through yt-dlp (must be on PATH, or set YTDLP_PATH). Videos are understood from
// their URL directly, so nothing is downloaded.
//
// Source specs (topic.sources[]):
//   { type: 'youtube', urls: ['https://www.youtube.com/@channel', 'https://www.youtube.com/playlist?list=...'] }
// Channel URLs list the channel's uploads; playlists are grouped by the channel of each video.
import { execFile } from 'node:child_process';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, ['--no-warnings', '--ignore-no-formats-error', ...args], { maxBuffer: 256 << 20, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(`yt-dlp: ${(stderr || err.message).slice(-400)}`)) : resolve(JSON.parse(stdout))));
  });
}

const isChannel = (u) => /youtube\.com\/(@|channel\/|c\/|user\/)/.test(u) && !/[?&]list=/.test(u);
const creatorOf = (id, name) => ({ id, name, sign: '', url: `https://www.youtube.com/channel/${id}` });

async function* groups(spec) {
  for (const url of spec.urls) {
    const list = await ytdlp(['--flat-playlist', '-J', isChannel(url) ? `${url.replace(/\/+$/, '')}/videos` : url]);
    const byChannel = new Map();
    for (const e of list.entries || []) {
      const id = e.channel_id || list.channel_id;
      if (!id) continue;
      if (!byChannel.has(id)) byChannel.set(id, { creator: creatorOf(id, e.channel || list.channel || id), list: [] });
      byChannel.get(id).list.push(e.id);
    }
    for (const { creator, list: ids } of byChannel.values()) yield { creator, ids: async () => ids };
  }
}

async function detail(id) {
  let d;
  try { d = await ytdlp(['-J', '--skip-download', `https://www.youtube.com/watch?v=${id}`]); } catch (e) {
    console.error(`skip ${id}: ${e.message.slice(0, 160)}`);
    return null;
  }
  const ymd = d.upload_date || '19700101';
  return {
    id: d.id, url: d.webpage_url, title: d.title, desc: d.description || '',
    pubdate: Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 1000,
    duration: d.duration || 0, pages: 1,
    stat: { view: d.view_count, like: d.like_count, reply: d.comment_count },
  };
}

async function comments(meta, { pages = 5, threadLimit = 40 } = {}) {
  const top = pages * 20;
  const d = await ytdlp(['-J', '--skip-download', '--write-comments', '--extractor-args',
    `youtube:comment_sort=top;max_comments=${top * 4},${top},${threadLimit},${threadLimit}`, meta.url]);
  const one = (c) => ({ user: c.author, isCreator: !!c.author_is_uploader, like: c.like_count || 0, text: c.text || '', pictures: 0, replies: [] });
  const roots = new Map();
  const all = d.comments || [];
  for (const c of all) if (c.parent === 'root') roots.set(c.id, { ...one(c), pinned: !!c.is_pinned });
  for (const c of all) if (c.parent !== 'root' && roots.has(c.parent)) roots.get(c.parent).replies.push(one(c));
  const list = [...roots.values()];
  const strip = ({ pinned, ...c }) => c;
  return { total: d.comment_count, pinned: list.filter((c) => c.pinned).map(strip), hot: list.filter((c) => !c.pinned).map(strip) };
}

export default {
  types: ['youtube'],
  rateWeights: { like: 0.6, reply: 0.4 },
  groups,
  detail,
  comments,
  understandArgs: (meta) => ['--youtube-url', meta.url],
};
