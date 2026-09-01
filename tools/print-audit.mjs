/**
 * print-audit.mjs — renders every tool tab to PDF and grades the output.
 *
 *   node tools/print-audit.mjs            (needs the site on :8080)
 *
 * Reports, per tab: page count, and any page whose ink coverage is under
 * threshold (a "mostly blank" page a client would notice). Exits non-zero
 * on findings so it can gate a release. PDFs are left in the out dir for
 * eyeballing.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import sharp from 'sharp';

const BASE = process.env.BASE_URL || 'http://localhost:8080/index.html';
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.env.PRINT_AUDIT_DIR || 'dist/print-audit';
const BLANK_PCT = 3.5;   // pages with less ink than this are flagged
const MAX_PAGES = 8;     // more than this for one tool is flagged as sprawl

const TABS = [
  ['#tab-payment', 'payment'],
  ['#tab-extra', 'extra'],
  ['#tab-side', 'side'],
  ['#tab-refi', 'refinance'],
  ['#tab-buyrent', 'buyvsrent'],
  ['#tab-wait', 'buynowvswait'],
  ['#tab-strategy', 'strategies'],
  ['#tab-compare', 'compare']
];

mkdirSync(OUT, { recursive: true });

async function inkCoverage(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 235) ink++;
  return (ink / data.length) * 100;
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const findings = [];
const summary = [];

for (const [tab, name] of TABS) {
  await page.click(tab);
  await page.waitForTimeout(500);
  const pdf = `${OUT}/${name}.pdf`;
  await page.pdf({ path: pdf, format: 'Letter', printBackground: true });

  // Rasterize at a low DPI — plenty for coverage measurement.
  const prefix = `${OUT}/${name}-p`;
  execFileSync('pdftoppm', ['-png', '-r', '50', pdf, prefix]);
  const pages = readdirSync(OUT)
    .filter((f) => f.startsWith(`${name}-p`) && f.endsWith('.png')).sort();

  const coverages = [];
  for (const f of pages) {
    coverages.push(await inkCoverage(`${OUT}/${f}`));
    rmSync(`${OUT}/${f}`);
  }
  coverages.forEach((c, i) => {
    if (c < BLANK_PCT) findings.push(`${name}: page ${i + 1}/${coverages.length} is mostly blank (${c.toFixed(1)}% ink)`);
  });
  if (coverages.length > MAX_PAGES) findings.push(`${name}: ${coverages.length} pages — too spread out`);
  summary.push(`${name.padEnd(14)} ${String(coverages.length).padStart(2)} pages   ink/page: ` +
    coverages.map((c) => c.toFixed(0).padStart(2) + '%').join(' '));
}

await browser.close();

console.log('='.repeat(72));
console.log('PRINT AUDIT');
console.log('='.repeat(72));
summary.forEach((s) => console.log('  ' + s));
console.log('-'.repeat(72));
if (errors.length) findings.push(...errors.map((e) => 'JS error: ' + e));
if (findings.length) {
  findings.forEach((f) => console.log('  FINDING: ' + f));
  console.log(`${findings.length} finding(s)`);
  process.exit(1);
}
console.log('CLEAN');
