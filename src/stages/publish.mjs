// publish: push the built site to a public GitHub repo and serve it with GitHub Pages (needs `gh` logged in).
// The repo holds only the site files. A subset of the serif font covering every character on the site
// is embedded when a font file and fontTools are available. Options: --repo <name> --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FILES = ['index.html', 'app.js', 'style.css', 'data.js'];
const FONT_CANDIDATES = [
  process.env.FORGE_SERIF_FONT,
  'C:/Windows/Fonts/NotoSerifSC-VF.ttf',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/System/Library/Fonts/Supplemental/Songti.ttc',
].filter(Boolean);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();

export default async function publish({ topic, ws, args }) {
  const repo = args.repo || topic.site.repo;
  if (!repo) throw new Error('set topic.site.repo or pass --repo <name>');
  if (!fs.existsSync(path.join(ws.site, 'data.js'))) throw new Error('site not built: run the build stage first');
  const out = path.join(ws.dir, '.publish', repo);
  // Authenticate with the gh login so no credential-manager prompt can block the push.
  const git = (...a) => run('git', ['-C', out, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...a]);
  const owner = run('gh', ['api', 'user', '--jq', '.login']);
  const slug = `${owner}/${repo}`;
  let exists = true;
  try { run('gh', ['repo', 'view', slug, '--json', 'name'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { exists = false; }

  if (!fs.existsSync(path.join(out, '.git'))) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (exists) run('gh', ['repo', 'clone', slug, out]);
    else run('git', ['init', '-b', 'main', out]);
  }
  for (const f of FILES) fs.copyFileSync(path.join(ws.site, f), path.join(out, f));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  embedFont(out);
  if (args['dry-run']) { console.log(`dry run: staged in ${out}`); return; }

  if (!exists) run('gh', ['repo', 'create', slug, '--public', '--description', `${topic.site.title} · ${topic.site.subtitle}`]);
  if (!git('remote')) git('remote', 'add', 'origin', `https://github.com/${slug}.git`);
  git('add', '-A');
  if (git('status', '--porcelain')) git('commit', '-m', `Update site ${new Date().toISOString().slice(0, 10)}`);
  git('push', '-u', 'origin', 'main');
  try {
    run('gh', ['api', `repos/${slug}/pages`, '--jq', '.html_url'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    run('gh', ['api', '-X', 'POST', `repos/${slug}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/']);
  }
  console.log(`https://${owner.toLowerCase()}.github.io/${repo}/  (first deploy takes a minute or two)`);
}

function embedFont(out) {
  const font = FONT_CANDIDATES.find((f) => fs.existsSync(f));
  if (!font) { console.log('no serif font found (set FORGE_SERIF_FONT); visitors will see their system serif'); return; }
  const text = FILES.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('');
  const charsFile = path.join(path.dirname(out), 'chars.txt');
  fs.writeFileSync(charsFile, [...new Set(text)].filter((c) => c.codePointAt(0) > 32).join(''));
  fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
  try {
    run(process.env.FORGE_PYTHON || 'python', ['-m', 'fontTools.subset', font, `--text-file=${charsFile}`, '--flavor=woff2',
      '--layout-features=*', `--output-file=${path.join(out, 'fonts', 'serif.woff2')}`]);
    console.log(`embedded serif subset: ${(fs.statSync(path.join(out, 'fonts', 'serif.woff2')).size / 1024).toFixed(0)} KB`);
  } catch {
    console.log('font subsetting skipped: pip install fonttools brotli to embed the serif font');
  }
}
