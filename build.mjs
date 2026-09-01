/**
 * build.mjs — produces a single self-contained HTML file.
 *
 * Inlines the stylesheet, all three scripts and the favicon into one file that
 * can be dropped into a CMS block, emailed, opened from a USB stick, or served
 * from anywhere. No network requests of any kind remain.
 *
 *   node build.mjs            -> dist/index.html
 *   node build.mjs out.html   -> out.html
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const outPath = resolve(root, process.argv[2] || 'dist/index.html');

let html = read('index.html');

const css = read('assets/css/styles.css');
const scripts = ['assets/js/finance.js', 'assets/js/charts.js', 'assets/js/app.js'];

// Team headshots ride along as data URIs: the probe-by-fetch that works on
// the multi-file site cannot reach separate files from a single-file page.
const teamPhotos = {};
for (const id of ['anthony', 'megan']) {
  for (const ext of ['jpg', 'png', 'webp']) {
    try {
      const buf = readFileSync(resolve(root, `assets/img/team/${id}.${ext}`));
      teamPhotos[id] = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,` + buf.toString('base64');
      break;
    } catch { /* try next extension */ }
  }
}
const favicon = read('assets/img/favicon.svg');

/**
 * A closing </script> anywhere inside inlined JS would end the block early.
 * None of our sources contain one, but escaping is free insurance against a
 * future edit silently producing a broken build.
 */
const guard = (js) => js.replace(/<\/script/gi, '<\\/script');

/**
 * Always inline via a replacer FUNCTION, never a replacement string.
 *
 * String.replace treats $&, $`, $' and $1 as substitution patterns in the
 * replacement text. Our sources contain the sequence $' (a dollar sign inside
 * a quoted string, e.g. '$' + amount), which would silently splice the rest of
 * the document back in. A function replacer disables that interpretation.
 */
const inline = (haystack, pattern, replacement) => haystack.replace(pattern, () => replacement);

// --- stylesheet ---------------------------------------------------------
html = inline(html,
  /<link rel="stylesheet" href="assets\/css\/styles\.css">/,
  '<style>\n' + css + '\n</style>'
);

// --- favicon as a data URI ----------------------------------------------
html = inline(html,
  /<link rel="icon"[^>]*>/,
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,' +
    Buffer.from(favicon, 'utf8').toString('base64') + '">'
);

// --- scripts -------------------------------------------------------------
for (const src of scripts) {
  const tag = new RegExp('<script src="' + src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"></script>');
  if (!tag.test(html)) throw new Error('Could not find script tag for ' + src);
  let block = '<script>\n' + guard(read(src)) + '\n</script>';
  if (src === 'assets/js/app.js' && Object.keys(teamPhotos).length) {
    block = '<script>window.__TEAM_PHOTOS = ' + JSON.stringify(teamPhotos) + ';</script>\n' + block;
  }
  html = inline(html, tag, block);
}

// --- verify nothing external survived -------------------------------------
// Tag-level checks rather than block stripping: the inlined JS legitimately
// mentions "assets/js/app.js" in prose, so only real markup patterns count.
const mustNotContain = [
  ['<script src=', 'an un-inlined script tag'],
  ['<link rel="stylesheet"', 'an un-inlined stylesheet'],
  ['href="assets/', 'a relative asset link'],
  ['src="assets/', 'a relative asset source'],
  ['fonts.googleapis.com', 'a webfont request'],
  ['fonts.gstatic.com', 'a webfont request']
];
for (const [needle, why] of mustNotContain) {
  if (html.includes(needle)) throw new Error(`Build left ${why} behind: ${needle}`);
}

// Every script and style must now be inline.
const externalScripts = (html.match(/<script\b[^>]*\ssrc=/gi) || []).length;
if (externalScripts) throw new Error(`${externalScripts} external script tag(s) remain`);

/*
 * --fragment emits the page without its document scaffolding, for hosts that
 * supply their own <!doctype>/<html>/<head>/<body> wrapper (Claude Artifacts,
 * and most CMS "custom HTML" blocks). The <title> is kept at the top so the
 * host can still hoist it.
 */
if (process.argv.includes('--fragment')) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [, 'Mortgage Calculator'])[1];
  const styles = [...html.matchAll(/<style[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error('Could not isolate the document body');
  // Scripts already live at the end of <body>, so they come along with it.
  html = `<title>${title}</title>\n${styles}\n${bodyMatch[1]}`;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`Built ${outPath} — ${kb} KB, fully self-contained.`);
