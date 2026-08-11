/**
 * build-logo.mjs — regenerates the brand marks as pure vector outlines.
 *
 * Why outlines rather than <text>: an SVG <text> element renders in whatever
 * font the viewer happens to have. Inter is not installed on most machines, so
 * the wordmark fell back to a different typeface and came out mis-set. Glyphs
 * converted to <path> data look identical everywhere, with no webfont request.
 *
 * Geometry is taken from the supplied lockup artwork. Coordinates below are in
 * that artwork's own pixel space, with each mark's origin at its top-left, so
 * the numbers can be checked directly against the reference.
 *
 *   node tools/build-logo.mjs
 *
 * Rewrites the block between LOGO:START / LOGO:END in index.html.
 */
import opentype from 'opentype.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Montserrat: at the artwork's cap height it reproduces the wordmark's natural
// width almost exactly (632 against 648 measured), where Poppins came out 68
// units narrow and needed heavy tracking to compensate — which is what made the
// lockup read as mis-set.
const FONTS = 'node_modules/@fontsource/montserrat/files';

function loadFont(weight) {
  const buf = readFileSync(resolve(root, `${FONTS}/montserrat-latin-${weight}-normal.woff`));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

const bold = loadFont(700);
const extra = loadFont(800);
const medium = loadFont(500);

/** Lay out a string glyph by glyph so letter-spacing and kerning are explicit. */
function layout(font, text, fontSize, letterSpacing) {
  const glyphs = font.stringToGlyphs(text);
  const path = new opentype.Path();
  let x = 0;
  glyphs.forEach((g, i) => {
    if (i > 0) {
      const kern = font.getKerningValue(glyphs[i - 1], g) || 0;
      x += (kern / font.unitsPerEm) * fontSize + letterSpacing;
    }
    path.extend(g.getPath(x, 0, fontSize));
    x += (g.advanceWidth / font.unitsPerEm) * fontSize;
  });
  return path;
}

/**
 * Set a string at a given cap height and tracking, then place it.
 *
 * Size comes from the measured cap height of the actual outline, not from font
 * metrics, so the drawn letters are the height asked for. Tracking is given
 * directly rather than solved from a target width — forcing a width is what
 * made "NEO" come out spread across the lockup.
 *
 * Position: `x` is the left edge of the ink, or pass `centreOn` to centre the
 * ink on that coordinate instead.
 */
function setText(font, text, { capHeight, tracking = 0, width, x, centreOn, baseline }) {
  const probe = layout(font, text, 100, 0).getBoundingBox();
  const fontSize = (100 * capHeight) / (probe.y2 - probe.y1);

  // When a measured target width is supplied, solve the tracking for it.
  if (width !== undefined) {
    const natural = layout(font, text, fontSize, 0).getBoundingBox();
    tracking = (width - (natural.x2 - natural.x1)) / Math.max(1, text.length - 1);
  }

  const path = layout(font, text, fontSize, tracking);
  const box = path.getBoundingBox();
  const inkWidth = box.x2 - box.x1;
  const left = centreOn !== undefined ? centreOn - inkWidth / 2 : x;

  path.commands.forEach((c) => {
    for (const [px, py] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']]) {
      if (c[px] !== undefined) { c[px] += left - box.x1; c[py] += baseline; }
    }
  });
  const finalBox = path.getBoundingBox();
  return {
    d: path.toPathData(2),
    width: finalBox.x2 - finalBox.x1,
    cap: finalBox.y2 - finalBox.y1,
    left: finalBox.x1,
    right: finalBox.x2
  };
}

/**
 * Rounded polygon: walk the vertices, cut back `r` along each adjacent edge and
 * round the corner with a quadratic through the vertex.
 *
 * Hand-written curves kept swallowing the straight runs and turning the NEO
 * hexagon into a squircle; deriving the corners from the vertices keeps the
 * flats flat and every corner identical.
 */
function roundedPolygon(points, r) {
  const n = points.length;
  const parts = [];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const f = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;

  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    // Never cut back more than half an edge, or adjacent corners would overlap.
    const inR = Math.min(r, dist(prev, cur) / 2);
    const outR = Math.min(r, dist(cur, next) / 2);
    const start = lerp(cur, prev, inR / dist(prev, cur));
    const end = lerp(cur, next, outR / dist(cur, next));
    parts.push(`${i === 0 ? 'M' : 'L'}${f(start)}`, `Q${f(cur)} ${f(end)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

const report = [];
function note(name, run) {
  report.push(`${name.padEnd(24)} width ${run.width.toFixed(1).padStart(7)}   ` +
    `cap ${run.cap.toFixed(1).padStart(5)}   x ${run.left.toFixed(0).padStart(4)}..${run.right.toFixed(0)}`);
}

/* ==================================================================
 * Combined horizontal badge — the supplied lockup.
 *
 * Reads left to right inside a rounded pill: cyan diamond, "GEM HOME TEAM",
 * a divider rule, then the NEO hexagon with its wordmark and strapline.
 * Coordinates are the artwork's own 640 x 100 pixel space.
 * ================================================================== */
const gemTitle = setText(extra, 'GEM HOME TEAM',
  { capHeight: 20, width: 280, x: 88, baseline: 60 });

const neoTitle = setText(extra, 'NEO', { capHeight: 21, width: 88, x: 490, baseline: 53 });
const neoSub = setText(bold, 'HOME LOANS', {
  capHeight: 6, width: 85,
  centreOn: (neoTitle.left + neoTitle.right) / 2, baseline: 64
});

// "powered by Better" mixes weights, so it is laid out as two runs sharing a
// baseline, then scaled to the measured width and centred under the NEO block.
const poweredSize = 34;
const poweredPath = layout(medium, 'powered by ', poweredSize, 0);
const poweredAdvance = medium.getAdvanceWidth('powered by ', poweredSize);
const betterPath = layout(extra, 'Better', poweredSize, 0);
betterPath.commands.forEach((c) => {
  for (const k of ['x', 'x1', 'x2']) if (c[k] !== undefined) c[k] += poweredAdvance;
});
poweredPath.extend(betterPath);

const POWERED_WIDTH = 150;
const pb = poweredPath.getBoundingBox();
const poweredScale = POWERED_WIDTH / (pb.x2 - pb.x1);
const poweredLeft = 428;
poweredPath.commands.forEach((c) => {
  for (const [px, py] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']]) {
    if (c[px] !== undefined) {
      c[px] = (c[px] - pb.x1) * poweredScale + poweredLeft;
      c[py] = c[py] * poweredScale + 93;
    }
  }
});

note('GEM HOME TEAM', gemTitle);
note('NEO', neoTitle);
note('HOME LOANS', neoSub);
const pbFinal = poweredPath.getBoundingBox();
note('powered by Better', {
  width: pbFinal.x2 - pbFinal.x1, cap: pbFinal.y2 - pbFinal.y1,
  left: pbFinal.x1, right: pbFinal.x2
});

// Cyan diamond, 44 across, vertically centred in the pill.
const diamond = 'M52 28 L74 50 L52 72 L30 50 Z';

// NEO hexagon, 65 x 53 at (415, 22) — the same 1.23 proportion as the
// standalone mark, with corners rounded from the vertices.
const HX = 415, HY = 22, HW = 65, HH = 53;
const hex = roundedPolygon([
  [HX + HW * 0.19, HY], [HX + HW * 0.81, HY],
  [HX + HW, HY + HH / 2],
  [HX + HW * 0.81, HY + HH], [HX + HW * 0.19, HY + HH],
  [HX, HY + HH / 2]
], 7);

// Butterfly counterform: wedges with vertical outer edges meeting at the centre.
const bw = { x1: HX + HW * 0.184, x2: HX + HW * 0.816, y1: HY + HH * 0.24, y2: HY + HH * 0.76 };
const cx = HX + HW / 2, cy = HY + HH / 2;
const butterfly = [
  `M${bw.x1.toFixed(2)} ${bw.y1.toFixed(2)}`, `L${bw.x1.toFixed(2)} ${bw.y2.toFixed(2)}`,
  `L${cx.toFixed(2)} ${cy.toFixed(2)}`, 'Z',
  `M${bw.x2.toFixed(2)} ${bw.y1.toFixed(2)}`, `L${bw.x2.toFixed(2)} ${bw.y2.toFixed(2)}`,
  `L${cx.toFixed(2)} ${cy.toFixed(2)}`, 'Z'
].join(' ');

const lockupSymbol = `    <symbol id="mark-lockup" viewBox="0 0 640 100">
      <rect x="1.25" y="1.25" width="637.5" height="97.5" rx="48.75"
            fill="none" stroke="var(--brand-rule)" stroke-width="2.5"/>
      <path fill="#2bb3e8" d="${diamond}"/>
      <path fill="currentColor" d="${gemTitle.d}"/>
      <line x1="392" y1="30" x2="392" y2="70" stroke="var(--brand-rule)" stroke-width="1.5"/>
      <path fill="currentColor" d="${hex}"/>
      <path style="fill:var(--brand-knockout)" d="${butterfly}"/>
      <path fill="currentColor" d="${neoTitle.d}"/>
      <path fill="currentColor" d="${neoSub.d}"/>
      <path fill="currentColor" d="${poweredPath.toPathData(2)}"/>
    </symbol>`;

/* ==================================================================
 * Equal Housing Lender
 * ================================================================== */
const ehoTop = setText(extra, 'EQUAL HOUSING', { capHeight: 9, tracking: 0.4, centreOn: 47, baseline: 57 });
const ehoBottom = setText(extra, 'LENDER', { capHeight: 9, tracking: 0.4, centreOn: 47, baseline: 69 });

const ehoSymbol = `    <symbol id="mark-eho" viewBox="0 0 94 73">
      <path fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="round"
            d="M47 5 L78 28 M47 5 L16 28 M23 25 L23 45 L71 45 L71 25"/>
      <rect x="35" y="29" width="24" height="4.4" fill="currentColor"/>
      <rect x="35" y="37" width="24" height="4.4" fill="currentColor"/>
      <path fill="currentColor" d="${ehoTop.d}"/>
      <path fill="currentColor" d="${ehoBottom.d}"/>
    </symbol>`;

/* ------------------------------------------------------------------ */

const block = [lockupSymbol, '', ehoSymbol].join('\n');
const indexPath = resolve(root, 'index.html');
let html = readFileSync(indexPath, 'utf8');

const START = '<!-- LOGO:START -->';
const END = '<!-- LOGO:END -->';
const pattern = new RegExp(`(${START})[\\s\\S]*?(\\s*${END})`);
if (!pattern.test(html)) {
  throw new Error('Could not find the LOGO:START / LOGO:END markers in index.html');
}
html = html.replace(pattern, () => `${START}\n${block}\n    ${END}`);

// The outer <svg> that references each symbol must carry the same viewBox, or
// the mark is scaled to the wrong box. Keep them in step automatically.
const boxes = { lockup: '0 0 640 100', eho: '0 0 94 73' };
for (const [mark, box] of Object.entries(boxes)) {
  const re = new RegExp(`(<svg[^>]*data-mark="${mark}"[^>]*viewBox=")[^"]*(")`, 'g');
  const before = html;
  html = html.replace(re, `$1${box}$2`);
  if (html === before && !new RegExp(`data-mark="${mark}"`).test(html)) {
    console.warn(`warning: no <svg data-mark="${mark}"> found to update`);
  }
  report.push(`viewBox ${mark.padEnd(17)} ${box}`);
}

writeFileSync(indexPath, html, 'utf8');

console.log(report.join('\n'));
console.log('\nRewrote the brand marks in index.html as outlined paths.');
