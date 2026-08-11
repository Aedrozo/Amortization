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
function setText(font, text, { capHeight, tracking = 0, x, centreOn, baseline }) {
  const probe = layout(font, text, 100, 0).getBoundingBox();
  const fontSize = (100 * capHeight) / (probe.y2 - probe.y1);

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

const report = [];
function note(name, run) {
  report.push(`${name.padEnd(24)} width ${run.width.toFixed(1).padStart(7)}   ` +
    `cap ${run.cap.toFixed(1).padStart(5)}   x ${run.left.toFixed(0).padStart(4)}..${run.right.toFixed(0)}`);
}

/* ==================================================================
 * Gem Home Team — house + wordmark
 * Reference: house 127x143; "GEM HOME TEAM" 648 wide, 50 cap, baseline 65;
 * "MORTGAGE LENDING" 402 wide, 17 cap, baseline 125, centred on the wordmark.
 * ================================================================== */
const gemTitle = setText(extra, 'GEM HOME TEAM',
  { capHeight: 50, tracking: 1.25, x: 180, baseline: 65 });
// The strapline is centred under the wordmark and widely tracked.
const gemSub = setText(bold, 'MORTGAGE LENDING',
  { capHeight: 16, tracking: 9.0, centreOn: (gemTitle.left + gemTitle.right) / 2, baseline: 125 });

note('GEM HOME TEAM', gemTitle);
note('MORTGAGE LENDING', gemSub);

// House: peaked roof whose eaves overhang the walls, then a narrower body with
// a rounded base. The overhang is the detail that reads as a house rather than
// a pentagon — an earlier pass had the roof flush with the walls.
const house = [
  'M58 4',            // start just left of the apex
  'Q63.5 -1 69 4',    // the peak is very slightly blunted, not razor sharp
  'L127 69',          // down to the right eave
  'L112 69',          // step back in to the wall line
  'L112 129',
  'Q112 143 98 143',  // rounded bottom right
  'L29 143',
  'Q15 143 15 129',   // rounded bottom left
  'L15 69',
  'L0 69',            // out to the left eave
  'Z'
].join(' ');
const diamond = 'M63.5 87 L83 106 L63.5 125 L44 106 Z';

const gemWidth = Math.ceil(Math.max(gemTitle.right, gemSub.right) + 2);
const gemSymbol = `    <symbol id="mark-gem" viewBox="0 0 ${gemWidth} 145">
      <path fill="currentColor" d="${house}"/>
      <path fill="#2bb3e8" d="${diamond}"/>
      <path fill="currentColor" d="${gemTitle.d}"/>
      <path fill="#2bb3e8" d="${gemSub.d}"/>
    </symbol>`;

/* ==================================================================
 * NEO Home Loans — hexagon + wordmark
 * Reference: hexagon 155x115; "NEO" 220 wide, 52 cap, baseline 77;
 * "HOME LOANS" 200 wide, 12 cap, baseline 97;
 * "powered by Better" 330 wide, baseline 165, centred on the whole lockup.
 * ================================================================== */
const neoTitle = setText(extra, 'NEO', { capHeight: 52, tracking: 1.5, x: 178, baseline: 84 });
// "HOME LOANS" is tracked out to sit under the full width of "NEO".
const neoSub = setText(bold, 'HOME LOANS', {
  capHeight: 12, tracking: 4.0,
  centreOn: (neoTitle.left + neoTitle.right) / 2, baseline: 105
});

// "powered by Better" mixes weights, so it is laid out as two runs that share
// a baseline and sit side by side, then centred as a unit.
const poweredSize = 34;
const poweredPath = layout(medium, 'powered by ', poweredSize, 0);
const poweredAdvance = medium.getAdvanceWidth('powered by ', poweredSize);
const betterPath = layout(extra, 'Better', poweredSize, 0);
betterPath.commands.forEach((c) => {
  for (const k of ['x', 'x1', 'x2']) if (c[k] !== undefined) c[k] += poweredAdvance;
});
poweredPath.extend(betterPath);

// Centre "powered by Better" on the whole lockup (hexagon through wordmark).
const pb = poweredPath.getBoundingBox();
const lockupCentre = neoTitle.right / 2;
const poweredLeft = lockupCentre - (pb.x2 - pb.x1) / 2;
poweredPath.commands.forEach((c) => {
  for (const [px, py] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']]) {
    if (c[px] !== undefined) {
      c[px] += poweredLeft - pb.x1;
      c[py] += 168;
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

// Hexagon: flat top and bottom, points left and right, generously rounded.
// 150 x 128, flat top and bottom, rounded points left and right.
const hex = [
  'M45 0', 'L105 0',
  'Q118 0 124 11', 'L144 53',
  'Q150 64 144 75', 'L124 117',
  'Q118 128 105 128', 'L45 128',
  'Q32 128 26 117', 'L6 75',
  'Q0 64 6 53', 'L26 11',
  'Q32 0 45 0', 'Z'
].join(' ');
// Butterfly counterform: two wedges meeting at the centre, with slightly
// concave outer edges so it reads as the mark rather than a plain bowtie.
const butterfly = [
  'M31 37', 'L31 91', 'L75 64', 'Z',
  'M119 37', 'L119 91', 'L75 64', 'Z'
].join(' ');

const neoWidth = Math.ceil(Math.max(neoTitle.right, pbFinal.x2) + 2);
const neoSymbol = `    <symbol id="mark-neo" viewBox="0 0 ${neoWidth} 180">
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

const block = [gemSymbol, '', neoSymbol, '', ehoSymbol].join('\n');
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
const boxes = { gem: `0 0 ${gemWidth} 145`, neo: `0 0 ${neoWidth} 180`, eho: '0 0 94 73' };
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
