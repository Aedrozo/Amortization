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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Plus Jakarta Sans, named directly in the brand SVG. Earlier passes guessed at
// the face by measuring widths (Poppins, then Montserrat); this is the real one.
const FONTS = 'node_modules/@fontsource/plus-jakarta-sans/files';

function loadFont(weight) {
  const buf = readFileSync(resolve(root, `${FONTS}/plus-jakarta-sans-latin-${weight}-normal.woff`));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

const bold = loadFont(700);
const extra = loadFont(800);
const medium = loadFont(500);

/**
 * Lay out a string glyph by glyph so letter-spacing and kerning are explicit.
 *
 * charToGlyph rather than stringToGlyphs: the latter runs the font's GSUB
 * features, and opentype.js cannot handle Plus Jakarta Sans's ccmp lookup
 * ("lookupType: 6 - substFormat: 2 is not yet supported"). Plain Latin needs no
 * substitution, and kerning is applied by hand below, so the direct cmap
 * lookup loses nothing.
 */
function layout(font, text, fontSize, letterSpacing) {
  const glyphs = Array.from(text).map((ch) => font.charToGlyph(ch));
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
function setText(font, text, { capHeight, fontSize: sizeOverride, tracking = 0, width, x, centreOn, baseline }) {
  const probe = layout(font, text, 100, 0).getBoundingBox();
  const fontSize = sizeOverride !== undefined
    ? sizeOverride
    : (100 * capHeight) / (probe.y2 - probe.y1);

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

/** Advance width without going through stringToGlyphs, for the same reason. */
function advanceWidth(font, text, fontSize) {
  const glyphs = Array.from(text).map((ch) => font.charToGlyph(ch));
  let w = 0;
  glyphs.forEach((g, i) => {
    if (i > 0) w += (font.getKerningValue(glyphs[i - 1], g) || 0) / font.unitsPerEm * fontSize;
    w += (g.advanceWidth / font.unitsPerEm) * fontSize;
  });
  return w;
}

const report = [];
function note(name, run) {
  report.push(`${name.padEnd(24)} width ${run.width.toFixed(1).padStart(7)}   ` +
    `cap ${run.cap.toFixed(1).padStart(5)}   x ${run.left.toFixed(0).padStart(4)}..${run.right.toFixed(0)}`);
}

/* ==================================================================
 * Brand lockup, transcribed from the supplied gem-neo-collab-light.svg.
 *
 * That file's geometry, type sizes, tracking and colours are reproduced
 * exactly in its own 760 x 150 space. Two departures, both deliberate:
 *
 *  - Its wordmarks are <text>, which renders in whatever font the viewer has.
 *    They are outlined here so the lockup is identical everywhere.
 *  - Its NEO half is <image href="neo-logo-navy.png">, a bitmap that was not
 *    included. That half is drawn as vectors instead, from the high-resolution
 *    NEO logo, scaled into the same 200 x 91 box the file reserves for it.
 * ================================================================== */
const INK = '#0B2A38';        // brand navy
const CYAN_MARK = '#38C1F0';  // diamond
const CYAN_TEXT = '#1FA9DC';  // strapline and the cross

const gemTitle = setText(extra, 'GEM HOME TEAM',
  { fontSize: 36, tracking: 1.8, x: 112, baseline: 84 });
const gemSub = setText(bold, 'MORTGAGE LENDING',
  { fontSize: 14, tracking: 3.92, x: 112, baseline: 108 });

note('GEM HOME TEAM', gemTitle);
note('MORTGAGE LENDING', gemSub);

// House: roof 8..88 spanning wider than the 17.5..78.5 walls, rounded base.
const house = 'M8 78 L48 48 L88 78 Z ' +
  'M17.5 78 H78.5 V111 A7 7 0 0 1 71.5 118 H24.5 A7 7 0 0 1 17.5 111 Z';
const diamond = 'M48 82.4 L58.6 93 L48 103.6 L37.4 93 Z';

/* ---- NEO half -----------------------------------------------------------
 * Re-measured from the high-resolution NEO logo. Its hexagon is 772 x 627,
 * i.e. distinctly wider than tall (1.23); an earlier pass read it off the small
 * combined lockup and made it nearly square, which is what looked wrong.
 *
 * That file also settles the alignment: "HOME LOANS" is centred on "NEO"
 * (centres 1402 against 1400), and "powered by Better" is centred on the whole
 * lockup (967 against 964) — neither is flush right.
 *
 * Built at hexagon height 146, then scaled into the 200 x 91 box the brand SVG
 * reserves for this half.
 * ---------------------------------------------------------------------- */
const HEX_W = 180, HEX_H = 146;
const NEO_W = 441;

const neoTitle = setText(extra, 'NEO',
  { capHeight: 59.4, width: 238, x: 203, baseline: 83 });
const neoSub = setText(bold, 'HOME LOANS', {
  capHeight: 15, width: 232,
  centreOn: (neoTitle.left + neoTitle.right) / 2, baseline: 113
});

const poweredSize = 34;
const poweredPath = layout(medium, 'powered by ', poweredSize, 0);
const poweredAdvance = advanceWidth(medium, 'powered by ', poweredSize);
const betterPath = layout(extra, 'Better', poweredSize, 0);
betterPath.commands.forEach((c) => {
  for (const k of ['x', 'x1', 'x2']) if (c[k] !== undefined) c[k] += poweredAdvance;
});
poweredPath.extend(betterPath);

const POWERED_WIDTH = 383;
const pb = poweredPath.getBoundingBox();
const poweredScale = POWERED_WIDTH / (pb.x2 - pb.x1);
poweredPath.commands.forEach((c) => {
  for (const [px, py] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']]) {
    if (c[px] !== undefined) {
      c[px] = (c[px] - pb.x1) * poweredScale + (NEO_W - POWERED_WIDTH) / 2;
      c[py] = c[py] * poweredScale + 192;
    }
  }
});

note('NEO', neoTitle);
note('HOME LOANS', neoSub);
const pbFinal = poweredPath.getBoundingBox();
note('powered by Better', {
  width: pbFinal.x2 - pbFinal.x1, cap: pbFinal.y2 - pbFinal.y1,
  left: pbFinal.x1, right: pbFinal.x2
});

// Corner radius ~8% of the width. A larger radius cut the left and right points
// right back, which made the counterform look as though it filled the shape.
const hex = roundedPolygon([
  [HEX_W * 0.19, 0], [HEX_W * 0.81, 0],
  [HEX_W, HEX_H / 2],
  [HEX_W * 0.81, HEX_H], [HEX_W * 0.19, HEX_H],
  [0, HEX_H / 2]
], HEX_W * 0.08);

// Counterform: 58% of the hexagon's width, 49% of its height, wedges meeting
// at the centre.
const bx1 = HEX_W * 0.18, bx2 = HEX_W * 0.775;
const by1 = HEX_H * 0.235, by2 = HEX_H * 0.735;
const bcx = HEX_W / 2, bcy = HEX_H / 2;
// The wedges' corners are softened in the artwork rather than razor sharp, and
// the apexes meeting at the centre are slightly blunted with them.
const BR = HEX_W * 0.035;
const butterfly = [
  roundedPolygon([[bx1, by1], [bcx, bcy], [bx1, by2]], BR),
  roundedPolygon([[bx2, by1], [bx2, by2], [bcx, bcy]], BR)
].join(' ');

// The brand SVG reserves x=536, y=30, 200 x 91 for the NEO artwork.
const NEO_BOX = { x: 536, y: 30, w: 200, h: 91 };
const NEO_SCALE = NEO_BOX.w / NEO_W;

/*
 * Centre the cross in the gap between the two halves, rather than at the fixed
 * x=500 the brand SVG uses. The Gem half's ink ends at the wordmark's right
 * edge, so the true midpoint sits left of 500 and the cross was reading as
 * off-centre. Vertically it is centred on the union of both halves.
 */
const HOUSE = { left: 8, right: 88, top: 48, bottom: 118 };
const gemRight = Math.max(gemTitle.right, gemSub.right, HOUSE.right);
const crossX = (gemRight + NEO_BOX.x) / 2;
const crossY = (Math.min(HOUSE.top, NEO_BOX.y) + Math.max(HOUSE.bottom, NEO_BOX.y + NEO_BOX.h)) / 2;
const CROSS = 7;  // half-arm

report.push(`cross                    centred at ${crossX.toFixed(1)}, ${crossY.toFixed(1)} ` +
  `(gap ${gemRight.toFixed(0)}..${NEO_BOX.x})`);

/**
 * Prefer real artwork over the reconstruction.
 *
 * Drop the genuine file in as assets/img/neo-logo-navy.<svg|png> — the name the
 * brand SVG already references — and it is inlined as a data URI in place of
 * the trace.
 *
 * Two wrinkles handled here:
 *
 *  - An SVG that is merely a wrapper around an external bitmap is skipped.
 *    neo-logo-navy.svg is 318 bytes of <image href="neo-logo-navy.png">; inlined
 *    as a data URI that relative reference cannot resolve and the mark vanishes.
 *    Only self-contained SVGs are used.
 *  - Bitmaps are downscaled to 1000px wide before inlining, five times the
 *    200px box the lockup displays them in. The supplied 1956px original is
 *    136 KB; the resample is 37 KB for no visible difference.
 */
async function realArtwork(base) {
  const svg = resolve(root, `assets/img/${base}.svg`);
  if (existsSync(svg)) {
    const text = readFileSync(svg, 'utf8');
    const wrapsExternalBitmap = /<image[^>]+(?:xlink:)?href="(?!data:)/i.test(text);
    if (!wrapsExternalBitmap) {
      return `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
    }
    console.log(`note: ${base}.svg only wraps an external bitmap — using the PNG instead`);
  }

  const png = resolve(root, `assets/img/${base}.png`);
  if (!existsSync(png)) return null;

  let bytes = readFileSync(png);
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(bytes).metadata();
    if (meta.width > 1000) {
      bytes = await sharp(bytes).resize({ width: 1000 })
        .png({ compressionLevel: 9, palette: true }).toBuffer();
    }
  } catch {
    // sharp unavailable — inline the original rather than failing the build.
  }
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const neoNavy = await realArtwork('neo-logo-navy');
const neoWhite = await realArtwork('neo-logo-white');

function neoHalf(vectorGroup) {
  if (!neoNavy) return vectorGroup;
  const img = (href, cls) =>
    `<image class="${cls}" x="${NEO_BOX.x}" y="${NEO_BOX.y}" width="${NEO_BOX.w}" height="${NEO_BOX.h}" ` +
    `preserveAspectRatio="xMidYMid meet" href="${href}"/>`;
  const kb = (u) => Math.round((u.length * 3) / 4 / 1024);
  report.push(`NEO half                 real artwork inlined, ${kb(neoNavy)} KB` +
    (neoWhite ? ' + a reversed variant' : ' (reversed for dark mode by filter)'));
  // Without a supplied reversed variant, the navy mark is monochrome on
  // transparency, so it can be flipped to white for dark backgrounds in CSS.
  return neoWhite
    ? `${img(neoNavy, 'neo-art-light')}\n      ${img(neoWhite, 'neo-art-dark')}`
    : img(neoNavy, 'neo-art');
}

const lockupSymbol = `    <symbol id="mark-lockup" viewBox="0 0 760 150">
      <path fill="currentColor" d="${house}"/>
      <path fill="${CYAN_MARK}" d="${diamond}"/>
      <path fill="currentColor" d="${gemTitle.d}"/>
      <path fill="${CYAN_TEXT}" d="${gemSub.d}"/>
      <g stroke="${CYAN_TEXT}" stroke-width="2.8" stroke-linecap="round">
        <line x1="${(crossX - CROSS).toFixed(2)}" y1="${(crossY - CROSS).toFixed(2)}" x2="${(crossX + CROSS).toFixed(2)}" y2="${(crossY + CROSS).toFixed(2)}"/>
        <line x1="${(crossX + CROSS).toFixed(2)}" y1="${(crossY - CROSS).toFixed(2)}" x2="${(crossX - CROSS).toFixed(2)}" y2="${(crossY + CROSS).toFixed(2)}"/>
      </g>
      ${neoHalf(`<g transform="translate(${NEO_BOX.x} ${NEO_BOX.y}) scale(${NEO_SCALE.toFixed(5)})">
        <path fill="currentColor" d="${hex}"/>
        <path style="fill:var(--brand-knockout)" d="${butterfly}"/>
        <path fill="currentColor" d="${neoTitle.d}"/>
        <path fill="currentColor" d="${neoSub.d}"/>
        <path fill="currentColor" d="${poweredPath.toPathData(2)}"/>
      </g>`)}
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
const boxes = { lockup: '0 0 760 150', eho: '0 0 94 73' };
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
