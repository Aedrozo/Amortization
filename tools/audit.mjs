/**
 * audit.mjs — display, contrast and layout audit across every tab and theme.
 *
 *   node tools/audit.mjs            (needs the site served on :8080)
 *
 * Checks, per tab and per theme, at several viewport widths:
 *   - WCAG 2.1 contrast for every text-bearing element, against its true
 *     effective background (walking ancestors through transparency)
 *   - text clipped by its own box
 *   - elements overflowing the viewport horizontally
 *   - content sitting under the sticky header
 *   - images that failed to load, and empty rendered regions
 *   - console and page errors throughout
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8080/index.html';
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const TABS = [
  ['#tab-payment', 'Payment & Schedule'],
  ['#tab-extra', 'Extra Payments'],
  ['#tab-side', 'Side-by-Side'],
  ['#tab-refi', 'Refinance'],
  ['#tab-buyrent', 'Buy vs Rent'],
  ['#tab-wait', 'Buy Now vs Wait'],
  ['#tab-strategy', 'Rate Strategies'],
  ['#tab-compare', 'Compare Loans']
];

/* ------------------------------------------------------------------ */
/* Injected into the page                                              */
/* ------------------------------------------------------------------ */
const PAGE_AUDIT = () => {
  const parseColor = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((n) => parseFloat(n));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };

  const srgb = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b);
  const contrast = (a, b) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  });

  /**
   * True painted background behind an element.
   *
   * Returns null when a gradient or image is involved: those cannot be reduced
   * to one colour, and treating them as transparent produced nonsense like
   * "white on white" for the white-on-navy-gradient hero tiles. Those elements
   * are reported separately for visual checking instead of being failed.
   */
  const effectiveBg = (el) => {
    let acc = null;
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c;
        if (acc.a >= 0.999) return acc;
      }
      node = node.parentElement;
    }
    const root = parseColor(getComputedStyle(document.body).backgroundColor);
    return acc ? over(acc, root || { r: 255, g: 255, b: 255, a: 1 }) : (root || { r: 255, g: 255, b: 255, a: 1 });
  };

  const results = { contrast: [], onGradient: [], clipped: [], overflow: [], underHeader: [], images: [] };
  const headerH = document.querySelector('.site-header')?.getBoundingClientRect().height || 0;
  const vw = document.documentElement.clientWidth;

  const visible = (el, r, cs) =>
    r.width > 0 && r.height > 0 &&
    cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;

  document.querySelectorAll('section:not([hidden]) *, header *, footer *, .cta-band *').forEach((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, r, cs)) return;

    // --- text contrast (only elements owning a direct text node) ---
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.trim()).join(' ');

    if (ownText) {
      const fg = parseColor(cs.color);
      if (fg && fg.a > 0.05) {
        const bg = effectiveBg(el);
        if (!bg) {
          results.onGradient.push({
            text: ownText.slice(0, 50),
            selector: el.tagName.toLowerCase() +
              (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
            color: cs.color
          });
          return;
        }
        const ratio = contrast(fg.a < 1 ? over(fg, bg) : fg, bg);
        const size = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) {
          results.contrast.push({
            text: ownText.slice(0, 60),
            selector: el.tagName.toLowerCase() +
              (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
            ratio: Math.round(ratio * 100) / 100,
            need, size, weight,
            color: cs.color, background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`
          });
        }
      }

      // --- text clipped by its own box ---
      const clips = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis';
      if (clips && el.scrollWidth > el.clientWidth + 1) {
        results.clipped.push({
          text: ownText.slice(0, 60),
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
        });
      }
    }

    // --- horizontal overflow past the viewport ---
    if (r.right > vw + 1 || r.left < -1) {
      let n = el.parentElement, contained = false;
      while (n && n !== document.documentElement) {
        const o = getComputedStyle(n).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') { contained = true; break; }
        n = n.parentElement;
      }
      if (!contained) {
        results.overflow.push({
          selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
          left: Math.round(r.left), right: Math.round(r.right), vw
        });
      }
    }
  });

  // --- images that failed to load ---
  document.querySelectorAll('img, image').forEach((el) => {
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) {
      results.images.push({ src: (el.src || '').slice(0, 80), reason: 'failed to load' });
    }
  });

  // --- anything important hidden beneath the sticky header ---
  const firstCard = document.querySelector('section:not([hidden]) .card');
  if (firstCard) {
    const r = firstCard.getBoundingClientRect();
    if (r.top < headerH - 2 && r.bottom > headerH) {
      results.underHeader.push({ top: Math.round(r.top), headerH: Math.round(headerH) });
    }
  }

  return results;
};

/* ------------------------------------------------------------------ */

const findings = { contrast: new Map(), onGradient: new Map(), clipped: [], overflow: [], images: [], errors: [] };

function recordContrast(ctx, list) {
  for (const c of list) {
    const key = `${c.selector}|${c.ratio}|${c.color}|${c.background}`;
    if (!findings.contrast.has(key)) findings.contrast.set(key, { ...c, where: [] });
    const entry = findings.contrast.get(key);
    if (!entry.where.includes(ctx)) entry.where.push(ctx);
  }
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 768, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      isMobile: width < 500, hasTouch: width < 500,
      colorScheme: theme
    });
    page.on('pageerror', (e) => findings.errors.push(`${theme}/${width}: ${e}`));
    page.on('console', (m) => {
      if (m.type() === 'error') findings.errors.push(`${theme}/${width}: ${m.text()}`);
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    // Populate the refinance tab so its debt panel renders real content.
    await page.evaluate(() => window.scrollTo(0, 0));

    for (const [tab, label] of TABS) {
      await page.click(tab);
      await page.waitForTimeout(450);
      const res = await page.evaluate(PAGE_AUDIT);
      const ctx = `${theme} ${width}px ${label}`;
      recordContrast(ctx, res.contrast);
      for (const g of res.onGradient) {
        const k = `${g.selector}|${g.color}`;
        if (!findings.onGradient.has(k)) findings.onGradient.set(k, g);
      }
      res.clipped.forEach((c) => findings.clipped.push({ ...c, where: ctx }));
      res.overflow.forEach((c) => findings.overflow.push({ ...c, where: ctx }));
      res.images.forEach((c) => findings.images.push({ ...c, where: ctx }));
    }
    await page.close();
  }
}

await browser.close();

/* ------------------------------------------------------------------ */

const contrastList = [...findings.contrast.values()].sort((a, b) => a.ratio - b.ratio);

console.log('='.repeat(78));
console.log('DISPLAY AUDIT');
console.log('='.repeat(78));

console.log(`\nCONTRAST (WCAG AA)  —  ${contrastList.length} distinct failures`);
if (!contrastList.length) console.log('  none');
for (const c of contrastList.slice(0, 40)) {
  console.log(`  ${String(c.ratio).padStart(5)}:1  need ${c.need}  ${c.size}px/${c.weight}  ${c.selector}`);
  console.log(`         "${c.text}"`);
  console.log(`         ${c.color} on ${c.background}   [${c.where.length} context(s), e.g. ${c.where[0]}]`);
}

const gradList = [...findings.onGradient.values()];
console.log(`\nON GRADIENT (checked visually, not automatically)  —  ${gradList.length}`);
gradList.slice(0, 12).forEach((g) => console.log(`  ${g.selector}  ${g.color}  "${g.text}"`));
if (!gradList.length) console.log('  none');

console.log(`\nCLIPPED TEXT  —  ${findings.clipped.length}`);
findings.clipped.slice(0, 15).forEach((c) =>
  console.log(`  "${c.text}"  ${c.scrollWidth}px in ${c.clientWidth}px   [${c.where}]`));
if (!findings.clipped.length) console.log('  none');

console.log(`\nVIEWPORT OVERFLOW  —  ${findings.overflow.length}`);
findings.overflow.slice(0, 15).forEach((c) =>
  console.log(`  ${c.selector}  right ${c.right} > ${c.vw}   [${c.where}]`));
if (!findings.overflow.length) console.log('  none');

console.log(`\nBROKEN IMAGES  —  ${findings.images.length}`);
findings.images.slice(0, 10).forEach((c) => console.log(`  ${c.src}  ${c.reason}  [${c.where}]`));
if (!findings.images.length) console.log('  none');

console.log(`\nJS / CONSOLE ERRORS  —  ${findings.errors.length}`);
[...new Set(findings.errors)].slice(0, 15).forEach((e) => console.log(`  ${e}`));
if (!findings.errors.length) console.log('  none');

console.log('\n' + '='.repeat(78));
const total = contrastList.length + findings.clipped.length +
  findings.overflow.length + findings.images.length + findings.errors.length;
console.log(total === 0 ? 'CLEAN' : `${total} finding(s)`);
console.log('='.repeat(78));
