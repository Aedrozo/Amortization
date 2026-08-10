/**
 * Browser tests — drives the real page in Chromium.
 *
 * Requires a static server on :8080 (npm start) and Playwright installed.
 * Run with: npm run test:ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8080/index.html';
// This environment ships Chromium at a fixed path; the npm-pinned Playwright
// build number won't match, so point it at the binary that is actually here.
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let browser, page;
const consoleErrors = [];
const pageErrors = [];

test.before(async () => {
  browser = await chromium.launch({ executablePath: EXECUTABLE });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
});

test.after(async () => { if (browser) await browser.close(); });

const text = sel => page.textContent(sel).then(t => (t || '').trim());
const money = s => Number(String(s).replace(/[^0-9.\-]/g, ''));

/* ------------------------------------------------------------------ */

test('page loads with no JavaScript errors', () => {
  assert.deepEqual(pageErrors, [], 'uncaught page errors');
  assert.deepEqual(consoleErrors, [], 'console errors');
});

test('headline payment matches the engine exactly', async () => {
  // Defaults: $360,000 @ 6.5% / 30yr = $2,275.44 P&I, + $450 tax + $150 insurance.
  const v = money(await text('#totalMonthly'));
  assert.equal(v, 2875.44, 'total monthly payment');
});

test('payment breakdown sums to the headline figure', async () => {
  const rows = await page.$$eval('#paymentBreakdown .breakdown-row',
    els => els.map(e => ({
      label: e.querySelector('.breakdown-label')?.textContent.trim(),
      value: e.querySelector('.breakdown-value')?.textContent.trim(),
      total: e.classList.contains('is-total')
    })));
  const parts = rows.filter(r => !r.total);
  const total = rows.find(r => r.total);
  const sum = parts.reduce((a, r) => a + money(r.value), 0);
  assert.ok(Math.abs(sum - money(total.value)) < 0.02,
    `parts (${sum}) should sum to total (${money(total.value)})`);
  assert.ok(parts.some(r => /Principal/.test(r.label)));
});

test('loan summary reports the right payoff and interest', async () => {
  const stats = await page.$$eval('#loanStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    value: e.querySelector('.stat-value').textContent.trim()
  })));
  const payoff = stats.find(s => /Payoff date/i.test(s.label));
  assert.ok(payoff, 'payoff stat present');
  assert.match(payoff.value, /^[A-Z][a-z]{2} \d{4}$/, 'payoff is a real month/year');
  const interest = stats.find(s => /Total interest/i.test(s.label));
  // $360k @ 6.5% over 30 years costs roughly $459k in interest.
  assert.ok(money(interest.value) > 450000 && money(interest.value) < 470000,
    `total interest ${interest.value}`);
});

test('charts render real SVG with resolved colours', async () => {
  for (const sel of ['#donutChart', '#balanceChart', '#splitChart']) {
    const svgCount = await page.$$eval(sel + ' svg', els => els.length);
    assert.equal(svgCount, 1, `${sel} has exactly one svg`);
  }
  // path.chart-line is the stroked series; the gradient area fills carry stroke="none".
  const paths = await page.$$eval('#balanceChart svg path.chart-line',
    els => els.map(e => e.getAttribute('stroke')));
  assert.ok(paths.length >= 2, 'balance chart draws its series');
  // A var() reference in a presentation attribute renders as nothing — guard it.
  assert.ok(paths.every(p => !/var\(/.test(p)),
    'no unresolved CSS variables in SVG attributes: ' + paths.join(', '));
  assert.ok(paths.every(p => /^(#|rgb|hsl)/i.test(p)), 'strokes are concrete colours');
});

test('the donut draws one arc per non-zero payment component', async () => {
  const segs = await page.$$eval('#donutChart .donut-seg', els => els.length);
  assert.equal(segs, 3, 'P&I, tax and insurance');
});

test('amortization schedule renders and totals reconcile', async () => {
  const rowCount = await page.$$eval('#scheduleWrap tbody tr', els => els.length);
  assert.equal(rowCount, 31, '30-year loan starting mid-year spans 31 calendar years');

  const footCells = await page.$$eval('#scheduleWrap tfoot td', els => els.map(e => e.textContent.trim()));
  assert.ok(Math.abs(money(footCells[2]) - 360000) < 2, 'principal total is the loan amount');
  assert.equal(money(footCells[footCells.length - 1]), 0, 'ends at a zero balance');
});

test('switching the schedule to monthly shows every payment', async () => {
  await page.click('[data-schedview="monthly"]');
  await page.waitForTimeout(150);
  const rowCount = await page.$$eval('#scheduleWrap tbody tr', els => els.length);
  assert.equal(rowCount, 360, 'exactly 360 payments');
  const first = await page.$$eval('#scheduleWrap tbody tr:first-child td',
    els => els.map(e => e.textContent.trim()));
  assert.equal(money(first[2]), 2275.44, 'first payment');
  assert.equal(money(first[4]), 1950.00, 'first month interest = 360000 * 6.5% / 12');
  await page.click('[data-schedview="annual"]');
});

/* ------------------------------------------------------------------ */
/* Extra payments                                                      */
/* ------------------------------------------------------------------ */

test('extra payments tab shows real savings', async () => {
  await page.click('#tab-extra');
  await page.waitForTimeout(300);
  const stats = await page.$$eval('#savingsStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    value: e.querySelector('.stat-value').textContent.trim()
  })));
  const saved = stats.find(s => /Interest saved/i.test(s.label));
  assert.ok(money(saved.value) > 100000, `$200/mo extra should save six figures, got ${saved.value}`);
  const time = stats.find(s => /Time saved/i.test(s.label));
  assert.match(time.value, /yr|year/, 'time saved is expressed in years');
});

test('the what-if ladder is present and ordered', async () => {
  const rows = await page.$$eval('#sensitivityWrap tbody tr',
    els => els.map(e => Array.from(e.querySelectorAll('td')).map(td => td.textContent.trim())));
  assert.equal(rows.length, 6);
  const savings = rows.map(r => money(r[5]));
  for (let i = 1; i < savings.length; i++) {
    assert.ok(savings[i] >= savings[i - 1], 'interest saved increases down the ladder');
  }
});

test('goal seek returns an actionable extra payment', async () => {
  await page.fill('#goalYears', '20');
  await page.click('#btnGoalSeek');
  await page.waitForTimeout(400);
  const t = await text('#goalResult');
  assert.match(t, /free and clear in 20 years/i);
  assert.ok(/\$[\d,]+\.\d\d/.test(t), 'quotes a dollar amount');
});

test('adding a lump sum changes the payoff', async () => {
  const before = await text('#savingsStats .stat .stat-value');
  await page.click('#btnAddOneTime');
  await page.waitForTimeout(400);
  const rows = await page.$$eval('#oneTimeList .onetime-item', els => els.length);
  assert.equal(rows, 1, 'lump sum row added');
  const after = await text('#savingsStats .stat .stat-value');
  assert.notEqual(before, after, 'payoff date moves when a lump sum is applied');
  // Clean up so later assertions see the default scenario.
  await page.click('[data-ot="remove"]');
  await page.waitForTimeout(300);
});

/* ------------------------------------------------------------------ */
/* Side-by-side                                                        */
/* ------------------------------------------------------------------ */

test('side-by-side seeds a payment above the minimum', async () => {
  await page.click('#tab-side');
  await page.waitForTimeout(350);
  const heads = await page.$$eval('#sideHeads .compare-head',
    els => els.map(e => ({
      title: e.querySelector('.ch-title').textContent.trim(),
      value: e.querySelector('.ch-value').textContent.trim(),
      sub: e.querySelector('.ch-sub').textContent.trim()
    })));
  assert.equal(heads.length, 2, 'two columns');
  assert.match(heads[0].title, /Minimum/i);
  assert.equal(money(heads[0].value), 2275.44, 'left column is the true minimum payment');
  assert.ok(money(heads[1].value) > money(heads[0].value), 'right column is higher');
  assert.match(heads[0].sub, /Paid off/);
});

test('paired table puts both loans on one row', async () => {
  const headers = await page.$$eval('#sideTableWrap thead th',
    els => els.map(e => e.textContent.trim()));
  assert.ok(headers.includes('Minimum payment'), 'left group header');
  assert.ok(headers.includes('Your payment'), 'right group header');

  const row = await page.$$eval('#sideTableWrap tbody tr:first-child td',
    els => els.map(e => e.textContent.trim()));
  // Year | min payment | min interest | min balance | your payment | your interest | your balance | delta
  assert.equal(row.length, 8, 'eight columns per row');
  assert.ok(money(row[3]) > money(row[6]), 'your balance is lower than the minimum-payment balance');
});

test('a custom payment flows through to the savings', async () => {
  await page.fill('#sidePayment', '3000');
  await page.waitForTimeout(400);
  const stats = await page.$$eval('#sideStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    value: e.querySelector('.stat-value').textContent.trim()
  })));
  const extra = stats.find(s => /Extra per month/i.test(s.label));
  assert.equal(money(extra.value), 3000 - 2275.44, 'extra is payment minus the minimum');
  const saved = stats.find(s => /Interest saved/i.test(s.label));
  assert.ok(money(saved.value) > 200000, `should save a lot, got ${saved.value}`);
});

test('a payment below the minimum is caught, not silently accepted', async () => {
  await page.fill('#sidePayment', '900');
  await page.waitForTimeout(400);
  const hint = await text('#sideHint');
  assert.match(hint, /below the required payment/i);
  await page.fill('#sidePayment', '2,500');
  await page.waitForTimeout(300);
});

test('quick-add buttons set the payment relative to the minimum', async () => {
  await page.click('[data-sidequick="500"]');
  await page.waitForTimeout(400);
  const v = money(await page.inputValue('#sidePayment'));
  assert.equal(v, Math.round(2275.44 + 500));
});

/* ------------------------------------------------------------------ */
/* Refinance                                                           */
/* ------------------------------------------------------------------ */

test('refinance produces a verdict and a break-even', async () => {
  await page.click('#tab-refi');
  await page.waitForTimeout(400);
  const verdict = await text('#refiVerdict .verdict-title');
  assert.ok(verdict.length > 0, 'verdict rendered');

  const stats = await page.$$eval('#refiStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    value: e.querySelector('.stat-value').textContent.trim(),
    sub: e.querySelector('.stat-sub')?.textContent.trim() || ''
  })));
  const savings = stats.find(s => /Monthly savings/i.test(s.label));
  assert.ok(savings && money(savings.value) > 0, 'dropping 7.25% to 5.75% saves money');
  const be = stats.find(s => /Break-even on interest/i.test(s.label));
  assert.ok(be, 'interest break-even is the headline measure');
  assert.match(be.value, /yr|mo/, 'break-even expressed as a duration');
  assert.match(be.sub, /Interest saved covers/i);
  const payBe = stats.find(s => /Payment-based break-even/i.test(s.label));
  assert.ok(payBe, 'the payment-based figure is still shown, clearly labelled');
});

test('break-even is driven by interest saved, not the payment drop', async () => {
  const read = async () => {
    const stats = await page.$$eval('#refiStats .stat', els => els.map(e => ({
      label: e.querySelector('.stat-label').textContent.trim(),
      value: e.querySelector('.stat-value').textContent.trim()
    })));
    return {
      interest: stats.find(s => /Break-even on interest/i.test(s.label)).value,
      payment: stats.find(s => /Payment-based break-even/i.test(s.label)).value
    };
  };

  // A long term reset at a barely-better rate: the payment falls, but almost
  // none of the drop is interest. The two measures must disagree.
  await page.fill('#curRemaining', '20');
  await page.fill('#curRate', '6');
  await page.fill('#newRate', '5.9');
  await page.fill('#closingCosts', '9,000');
  await page.selectOption('#newTerm', '360');
  await page.waitForTimeout(500);

  const r = await read();
  assert.equal(r.interest, 'Never',
    'stretching the term must not be counted as interest savings');
  assert.notEqual(r.payment, 'Never',
    'the payment-based figure still reports a break-even, which is exactly the trap');

  const verdict = await text('#refiVerdict .verdict-title');
  assert.match(verdict, /never repays the cost/i);

  // A genuine rate drop should pay for itself.
  await page.fill('#curRate', '7.25');
  await page.fill('#newRate', '5.75');
  await page.fill('#curRemaining', '27');
  await page.fill('#closingCosts', '6,000');
  await page.waitForTimeout(500);
  const good = await read();
  assert.notEqual(good.interest, 'Never', 'a real rate drop does repay its cost');
});

test('the refinance chart plots interest saved against the cost line', async () => {
  const legend = await text('#refiLegend');
  assert.match(legend, /Interest saved so far/i);
  assert.match(legend, /Cost to refinance/i);
  const note = (await text('#refiBreakEvenNote')).replace(/\s+/g, ' ');
  assert.match(note, /principal in every payment is not a cost/i);
  assert.match(note, /comes back to you as equity/i);
  const lines = await page.$$eval('#refiChart svg path.chart-line', els => els.length);
  assert.equal(lines, 2, 'interest-saved curve plus the flat cost line');
});

test('refinance comparison table lines up both loans', async () => {
  const rows = await page.$$eval('#refiCompareWrap tbody tr',
    els => els.map(e => Array.from(e.querySelectorAll('td')).map(td => td.textContent.trim())));
  assert.ok(rows.length >= 7, 'all comparison rows present');
  const payRow = rows.find(r => /Monthly principal/i.test(r[0]));
  assert.ok(money(payRow[2]) < money(payRow[1]), 'new payment is lower');
});

test('the keep-your-old-payment scenario is computed', async () => {
  const t = await text('#keepSameResult');
  assert.match(t, /Paid off/i);
  assert.ok(!/applies when the refinance lowers/.test(t), 'scenario is active, not the placeholder');
});

test('switching to original-terms mode derives the balance', async () => {
  await page.click('[data-curmode="original"]');
  await page.waitForTimeout(400);
  const note = await text('#derivedLoanNote');
  assert.match(note, /balance is about/i);
  assert.ok(/\$[\d,]+/.test(note), 'quotes a derived balance');
  await page.click('[data-curmode="balance"]');
  await page.waitForTimeout(300);
});

test('a bad refinance is called out rather than dressed up', async () => {
  await page.fill('#newRate', '9');
  await page.waitForTimeout(400);
  const title = await text('#refiVerdict .verdict-title');
  assert.match(title, /costs you money/i);
  const cls = await page.getAttribute('#refiVerdict .verdict', 'class');
  assert.match(cls, /is-bad/);
  await page.fill('#newRate', '5.75');
  await page.waitForTimeout(300);
});

test('buydown break-even is computed', async () => {
  const t = await text('#buydownResult');
  assert.match(t, /Break-even/i);
  assert.match(t, /Cost of the points/i);
});

/* ------------------------------------------------------------------ */
/* Compare + chrome                                                    */
/* ------------------------------------------------------------------ */

test('compare tab renders three scenarios', async () => {
  await page.click('#tab-compare');
  await page.waitForTimeout(400);
  const cards = await page.$$eval('#scenarioInputs .scenario-card', els => els.length);
  assert.equal(cards, 3);
  const cols = await page.$$eval('#compareTableWrap thead th', els => els.length);
  assert.equal(cols, 4, 'label column plus three scenarios');
  const series = await page.$$eval('#compareChart svg path.chart-line', els => els.length);
  assert.ok(series >= 3, 'three balance curves drawn');
});

test('editing a scenario updates the table', async () => {
  await page.fill('#scRate0', '4');
  await page.waitForTimeout(350);
  const rows = await page.$$eval('#compareTableWrap tbody tr',
    els => els.map(e => Array.from(e.querySelectorAll('td')).map(td => td.textContent.trim())));
  const interest = rows.find(r => /Total interest/i.test(r[0]));
  assert.ok(money(interest[1]) < 260000, `4% should cut interest sharply, got ${interest[1]}`);
});

test('dark mode repaints charts with new colours', async () => {
  await page.click('#tab-payment');
  await page.waitForTimeout(300);
  const before = await page.$eval('#balanceChart svg path.chart-line', e => e.getAttribute('stroke'));
  await page.click('#btnTheme');
  await page.waitForTimeout(400);
  const theme = await page.getAttribute('html', 'data-theme');
  assert.equal(theme, 'dark');
  const after = await page.$eval('#balanceChart svg path.chart-line', e => e.getAttribute('stroke'));
  assert.notEqual(before, after, 'chart colours follow the theme');
  assert.ok(!/var\(/.test(after));
  await page.click('#btnTheme');
  await page.waitForTimeout(300);
});

test('share link round-trips the whole scenario', async () => {
  await page.fill('#homePrice', '625000');
  await page.waitForTimeout(400);
  const hash = await page.evaluate(() => location.hash);
  assert.ok(hash.includes('homePrice=625000'), 'state written to the URL');

  const p2 = await browser.newPage();
  await p2.goto(BASE + hash, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  assert.equal(money(await p2.inputValue('#homePrice')), 625000, 'price restored');
  assert.equal(await p2.textContent('#totalMonthly'), await page.textContent('#totalMonthly'),
    'restored scenario computes the same payment');
  await p2.close();
});

test('PMI switches itself on below 20% down and reports a drop-off date', async () => {
  await page.fill('#homePrice', '450,000');
  await page.waitForTimeout(200);
  await page.fill('#downPaymentPct', '5');
  await page.waitForTimeout(500);
  const checked = await page.getAttribute('#pmiEnabled', 'aria-checked');
  assert.equal(checked, 'true', 'PMI turns on automatically at 95% LTV');

  const stats = await page.$$eval('#loanStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    sub: e.querySelector('.stat-sub')?.textContent.trim() || ''
  })));
  const pmi = stats.find(s => /Mortgage insurance/i.test(s.label));
  assert.ok(pmi, 'PMI appears in the summary');
  assert.match(pmi.sub, /Drops off [A-Z][a-z]{2} \d{4}/, 'quotes a cancellation date');

  const milestones = await text('#milestones');
  assert.match(milestones, /Mortgage insurance drops off/);
});

/* ------------------------------------------------------------------ */
/* Disclosures                                                         */
/* ------------------------------------------------------------------ */

test('required lending disclosures are present in the footer', async () => {
  const d = (await text('.disclaimer')).replace(/\s+/g, ' ');
  assert.match(d, /not an offer or a commitment to lend/i);
  assert.match(d, /subject to credit approval/i);
  assert.match(d, /Interest rate is not APR/i);
  assert.match(d, /Regulation Z/i);
  assert.match(d, /Equal Housing Lender/i);
  assert.match(d, /Equal Credit Opportunity Act/i);
  assert.match(d, /Loan Estimate/i);
  const eho = await text('.eho');
  assert.match(eho, /Equal Housing Opportunity/i);
});

test('an unconfigured build warns that NMLS identifiers are missing', async () => {
  const t = await text('#licensing');
  assert.match(t, /Set your NMLS identifiers/i,
    'a build with no NMLS IDs must say so rather than ship silently');
  const link = await page.getAttribute('#licensing a', 'href');
  assert.match(link, /nmlsconsumeraccess\.org/, 'links to NMLS Consumer Access');
});

test('APR is disclosed once finance charges are entered', async () => {
  await page.click('#tab-payment');
  await page.waitForTimeout(300);
  const labels = () => page.$$eval('#loanStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    value: e.querySelector('.stat-value').textContent.trim()
  })));

  assert.ok(!(await labels()).some(s => /APR/i.test(s.label)),
    'no APR claimed when no cost of credit is known');

  await page.evaluate(() => { document.querySelector('details').open = true; });
  await page.fill('#loanCosts', '7200');
  await page.waitForTimeout(450);

  const apr = (await labels()).find(s => /APR/i.test(s.label));
  assert.ok(apr, 'APR appears once finance charges exist');
  const rate = Number(await page.inputValue('#interestRate'));
  const aprNum = Number(apr.value.replace('%', ''));
  assert.ok(aprNum > rate, `APR ${aprNum}% must exceed the ${rate}% note rate`);
  assert.ok(aprNum < rate + 1, 'and stay in a plausible range');
  await page.fill('#loanCosts', '0');
  await page.waitForTimeout(350);
});

test('the refinance tab discloses an APR for the new loan', async () => {
  await page.click('#tab-refi');
  await page.waitForTimeout(500);
  const stats = await page.$$eval('#refiStats .stat', els => els.map(e => ({
    label: e.querySelector('.stat-label').textContent.trim(),
    value: e.querySelector('.stat-value').textContent.trim()
  })));
  const apr = stats.find(s => /APR/i.test(s.label));
  assert.ok(apr, 'APR shown alongside the new payment');
  assert.ok(Number(apr.value.replace('%', '')) > Number(await page.inputValue('#newRate')),
    'APR exceeds the note rate once closing costs are counted');
  await page.click('#tab-payment');
  await page.waitForTimeout(300);
});

test('no tab overflows horizontally at any viewport width', async () => {
  // A stray horizontal scrollbar is the classic mobile regression; check the
  // real thing rather than trusting the media queries.
  const widths = [320, 360, 390, 414, 600, 768, 1024, 1280];
  const tabs = ['#tab-payment', '#tab-extra', '#tab-side', '#tab-refi', '#tab-compare'];
  const failures = [];
  for (const w of widths) {
    const p2 = await browser.newPage({ viewport: { width: w, height: 844 }, isMobile: w < 500, hasTouch: w < 500 });
    await p2.goto(BASE, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(300);
    for (const t of tabs) {
      await p2.click(t);
      await p2.waitForTimeout(250);
      const m = await p2.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth
      }));
      if (m.sw > m.cw + 1) failures.push(`${w}px ${t}: ${m.sw} > ${m.cw}`);
    }
    await p2.close();
  }
  assert.deepEqual(failures, [], 'viewports with horizontal overflow');
});

test('no errors accumulated across the whole session', () => {
  assert.deepEqual(pageErrors, [], 'uncaught page errors during interaction');
  assert.deepEqual(consoleErrors, [], 'console errors during interaction');
});
