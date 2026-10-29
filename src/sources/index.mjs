import bilibili from './bilibili.mjs';
import youtube from './youtube.mjs';
import local from './local.mjs';

const ALL = [bilibili, youtube, local];

export function sourceFor(type) {
  const s = ALL.find((x) => x.types.includes(type));
  if (!s) throw new Error(`unknown source type "${type}"; known: ${ALL.flatMap((x) => x.types).join(', ')}`);
  return s;
}
