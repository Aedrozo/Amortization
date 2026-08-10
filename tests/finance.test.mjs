/**
 * Engine tests. Run with: npm test  (or: node --test tests/)
 *
 * Expected values are taken from closed-form finance formulas and from
 * published figures for well-known loan scenarios, so a regression in the
 * schedule builder fails loudly instead of quietly shifting a payoff date.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../assets/js/finance.js');

const approx = (actual, expected, tol = 0.01, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg} expected ${expected}, got ${actual} (tol ${tol})`);

/* ------------------------------------------------------------------ */
/* Payment math                                                        */
/* ------------------------------------------------------------------ */

test('payment: canonical 30-year loan', () => {
  // $300,000 @ 6.5% / 360 months -> $1,896.20
  approx(F.payment(300000, 6.5, 360), 1896.20, 0.01);
});

test('payment: 15-year loan', () => {
  // $300,000 @ 5.5% / 180 months -> $2,451.25
  approx(F.payment(300000, 5.5, 180), 2451.25, 0.02);
});

test('payment: zero-interest loan is straight-line', () => {
  approx(F.payment(120000, 0, 360), 333.33, 0.01);
});

test('payment: guards on nonsense input', () => {
  assert.equal(F.payment(0, 6, 360), 0);
  assert.equal(F.payment(100000, 6, 0), 0);
  assert.equal(F.payment(-5, 6, 360), 0);
});

test('balanceAfter matches a full schedule walk', () => {
  const s = F.buildSchedule({ principal: 400000, annualRate: 7, termMonths: 360 });
  approx(F.balanceAfter(400000, 7, 360, 60), s.rows[59].balance, 1.0,
    'closed-form balance vs schedule at month 60');
  approx(F.balanceAfter(400000, 7, 360, 360), 0, 1.0, 'balance at maturity');
});

test('rateFromPayment inverts payment()', () => {
  const pmt = F.payment(250000, 6.125, 360);
  approx(F.rateFromPayment(250000, pmt, 360), 6.125, 0.01);
});

test('monthsToPayoff detects an impossible payment', () => {
  // Payment below the first month's interest can never retire the loan.
  assert.equal(F.monthsToPayoff(300000, 6, 100), Infinity);
  assert.equal(F.monthsToPayoff(300000, 0, 1000), 300);
});

/* ------------------------------------------------------------------ */
/* Schedule integrity — the properties that must ALWAYS hold           */
/* ------------------------------------------------------------------ */

test('schedule: terminates exactly on term and lands on zero', () => {
  const s = F.buildSchedule({ principal: 300000, annualRate: 6.5, termMonths: 360 });
  assert.equal(s.error, null);
  assert.equal(s.months, 360, 'pays off in exactly the stated term');
  assert.equal(s.rows.length, 360);
  assert.equal(s.rows[359].balance, 0, 'final balance is exactly zero, not a penny of drift');
});

test('schedule: principal repaid equals the amount borrowed', () => {
  const s = F.buildSchedule({ principal: 437500, annualRate: 5.875, termMonths: 360 });
  approx(s.totalPrincipal, 437500, 0.01, 'sum of principal');
  approx(s.totalPaid, s.totalPrincipal + s.totalInterest, 0.01, 'total paid identity');
});

test('schedule: every row is internally consistent', () => {
  const s = F.buildSchedule({ principal: 250000, annualRate: 7.25, termMonths: 360 });
  for (const r of s.rows) {
    approx(r.principal + r.interest, r.payment, 0.011, `row ${r.n} P+I = payment`);
    approx(r.startBalance - r.principal - r.extra, r.balance, 0.011, `row ${r.n} balance roll-forward`);
    assert.ok(r.balance >= 0, `row ${r.n} balance never goes negative`);
    assert.ok(r.interest >= 0, `row ${r.n} interest never negative`);
  }
});

test('schedule: total interest for a known loan', () => {
  // $200,000 @ 6% / 360 -> payment 1199.10, total interest ~$231,676
  const s = F.buildSchedule({ principal: 200000, annualRate: 6, termMonths: 360 });
  approx(s.basePayment, 1199.10, 0.01);
  approx(s.totalInterest, 231676.38, 25);
});

test('schedule: interest falls and principal rises monotonically', () => {
  const s = F.buildSchedule({ principal: 300000, annualRate: 6.5, termMonths: 360 });
  for (let i = 1; i < s.rows.length - 1; i++) {
    assert.ok(s.rows[i].interest <= s.rows[i - 1].interest + 0.02, `interest declines at ${i}`);
    assert.ok(s.rows[i].principal >= s.rows[i - 1].principal - 0.02, `principal grows at ${i}`);
  }
});

test('schedule: zero-rate loan amortizes straight-line', () => {
  const s = F.buildSchedule({ principal: 60000, annualRate: 0, termMonths: 120 });
  assert.equal(s.months, 120);
  approx(s.totalInterest, 0, 0.01);
  assert.equal(s.rows[119].balance, 0);
});

test('schedule: rejects negative amortization instead of faking a payoff', () => {
  const s = F.buildSchedule({
    principal: 500000, annualRate: 8, termMonths: 360, paymentOverride: 200
  });
  assert.equal(s.error, 'negative-amortization');
  assert.equal(s.rows.length, 0);
});

test('schedule: dates advance correctly across a year boundary', () => {
  const s = F.buildSchedule({
    principal: 100000, annualRate: 5, termMonths: 360,
    start: { year: 2026, month: 10 } // Nov 2026
  });
  assert.equal(s.rows[0].date, 'Nov 2026');
  assert.equal(s.rows[1].date, 'Dec 2026');
  assert.equal(s.rows[2].date, 'Jan 2027');
  assert.equal(F.formatMonth(s.payoff), 'Oct 2056');
});

/* ------------------------------------------------------------------ */
/* Extra payments                                                      */
/* ------------------------------------------------------------------ */

test('extra monthly: shortens term and cuts interest', () => {
  const base = { principal: 300000, annualRate: 6.5, termMonths: 360 };
  const c = F.comparePrepayment(base, { monthly: 200 });
  assert.ok(c.accelerated.months < c.base.months, 'pays off sooner');
  assert.ok(c.interestSaved > 0, 'saves interest');
  approx(c.accelerated.totalPrincipal, 300000, 0.01, 'still repays exactly the principal');
  assert.equal(c.accelerated.rows[c.accelerated.rows.length - 1].balance, 0);
  // $200/mo extra on this loan retires it in roughly 24 years.
  assert.ok(c.monthsSaved > 60 && c.monthsSaved < 100, `monthsSaved=${c.monthsSaved}`);
});

test('extra payment never overshoots the balance', () => {
  const s = F.buildSchedule({
    principal: 300000, annualRate: 6.5, termMonths: 360, extras: { monthly: 5000 }
  });
  const last = s.rows[s.rows.length - 1];
  assert.equal(last.balance, 0);
  approx(s.totalPrincipal, 300000, 0.01, 'huge extras still repay exactly the principal');
  for (const r of s.rows) assert.ok(r.balance >= 0);
});

test('biweekly equals one extra payment per year', () => {
  const base = { principal: 300000, annualRate: 6.5, termMonths: 360 };
  const bi = F.buildSchedule({ ...base, extras: { biweekly: true } });
  const equiv = F.buildSchedule({ ...base, extras: { monthly: F.payment(300000, 6.5, 360) / 12 } });
  assert.equal(bi.months, equiv.months, 'biweekly model matches the 13th-payment equivalent');
  // Accelerated biweekly classically takes a 30-year loan to about 25 years.
  assert.ok(bi.months >= 290 && bi.months <= 310, `biweekly months=${bi.months}`);
});

test('annual lump lands only in the selected calendar month', () => {
  const s = F.buildSchedule({
    principal: 300000, annualRate: 6, termMonths: 360,
    start: { year: 2026, month: 0 },          // Jan 2026
    extras: { annual: 3000, annualMonth: 6 }  // June
  });
  assert.equal(s.rows[0].extra, 0, 'January gets nothing');
  approx(s.rows[5].extra, 3000, 0.01, 'June gets the lump');
  assert.equal(s.rows[6].extra, 0, 'July gets nothing');
  approx(s.rows[17].extra, 3000, 0.01, 'next June repeats');
});

test('one-time payments apply on their exact month', () => {
  const s = F.buildSchedule({
    principal: 300000, annualRate: 6, termMonths: 360,
    start: { year: 2026, month: 0 },
    extras: { oneTime: [{ amount: 25000, year: 2028, month: 3 }] } // Apr 2028
  });
  const hit = s.rows.find(r => r.date === 'Apr 2028');
  approx(hit.extra, 25000, 0.01);
  assert.equal(s.rows.filter(r => r.extra > 0).length, 1, 'exactly one extra payment');
});

test('extra payments respect their start month', () => {
  const s = F.buildSchedule({
    principal: 300000, annualRate: 6, termMonths: 360,
    extras: { monthly: 500, startMonth: 13 }
  });
  assert.equal(s.rows[11].extra, 0, 'month 12 has no extra');
  approx(s.rows[12].extra, 500, 0.01, 'month 13 starts');
});

test('round-up lifts the payment to the next increment', () => {
  const s = F.buildSchedule({
    principal: 300000, annualRate: 6.5, termMonths: 360, extras: { roundUpTo: 100 }
  });
  // Payment is 1896.20 -> rounds to 1900.00, so extra is 3.80.
  approx(s.rows[0].payment + s.rows[0].extra, 1900, 0.01);
  assert.ok(s.months < 360);
});

test('goal seek finds the extra needed to hit a target term', () => {
  const base = { principal: 300000, annualRate: 6.5, termMonths: 360 };
  const g = F.extraNeededForTerm(base, 180); // pay off in 15 years
  assert.ok(g.achievable);
  assert.ok(g.schedule.months <= 180, `achieved ${g.schedule.months} months`);
  // One dollar less must miss the target — proves the solve is tight.
  const under = F.buildSchedule({ ...base, extras: { monthly: g.extra - 1 } });
  assert.ok(under.months > 180, 'solution is minimal');
});

test('goal seek returns zero extra when the target is already met', () => {
  const g = F.extraNeededForTerm({ principal: 300000, annualRate: 6.5, termMonths: 360 }, 480);
  assert.equal(g.extra, 0);
});

test('sensitivity ladder is monotonic', () => {
  const rows = F.sensitivity({ principal: 350000, annualRate: 6.75, termMonths: 360 },
    [50, 100, 250, 500, 1000]);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].monthsSaved >= rows[i - 1].monthsSaved, 'more extra saves more time');
    assert.ok(rows[i].interestSaved >= rows[i - 1].interestSaved, 'more extra saves more interest');
  }
});

/* ------------------------------------------------------------------ */
/* PMI, escrow, equity                                                 */
/* ------------------------------------------------------------------ */

test('PMI drops off at the 78% LTV threshold', () => {
  const s = F.buildSchedule({
    principal: 380000, annualRate: 6.5, termMonths: 360,
    propertyValue: 400000,
    pmi: { enabled: true, ratePct: 0.5, cancelLtv: 78 }
  });
  approx(s.rows[0].pmi, 158.33, 0.02, 'monthly PMI = 0.5% of loan / 12');
  const end = s.pmiEndMonth;
  assert.ok(end > 0 && end < 360, `PMI ends at month ${end}`);
  assert.ok(s.rows[end - 1].pmi > 0, 'charged in its final month');
  assert.equal(s.rows[end].pmi, 0, 'zero the month after');
  // Balance at cancellation is at or below 78% of the original value.
  assert.ok(s.rows[end - 1].balance <= 400000 * 0.78 + 1,
    `balance at cutoff ${s.rows[end - 1].balance}`);
});

test('extra payments cancel PMI earlier and cut its total cost', () => {
  const base = {
    principal: 380000, annualRate: 6.5, termMonths: 360, propertyValue: 400000,
    pmi: { enabled: true, ratePct: 0.5, cancelLtv: 78 }
  };
  const plain = F.buildSchedule(base);
  const fast = F.buildSchedule({ ...base, extras: { monthly: 400 } });
  assert.ok(fast.pmiEndMonth < plain.pmiEndMonth, 'PMI ends sooner');
  assert.ok(fast.totalPmi < plain.totalPmi, 'less PMI paid overall');
});

test('no PMI when disabled or when equity is already 22%', () => {
  const off = F.buildSchedule({
    principal: 300000, annualRate: 6, termMonths: 360, propertyValue: 400000,
    pmi: { enabled: true, ratePct: 0.5, cancelLtv: 78 }
  });
  assert.equal(off.totalPmi, 0, '75% LTV never triggers PMI');
});

test('escrow rolls into the total payment and the lifetime cost', () => {
  const s = F.buildSchedule({
    principal: 300000, annualRate: 6, termMonths: 360,
    escrow: { taxAnnual: 6000, insuranceAnnual: 1800, hoaMonthly: 75, otherMonthly: 25 }
  });
  const r = s.rows[0];
  approx(r.tax, 500, 0.01);
  approx(r.insurance, 150, 0.01);
  approx(r.escrow, 750, 0.01);
  approx(r.totalPayment, r.payment + 750, 0.01);
  approx(s.totalEscrow, 750 * 360, 1);
  approx(s.totalOutOfPocket, s.totalPaid + s.totalEscrow, 0.5);
});

test('equity tracks appreciation', () => {
  const s = F.buildSchedule({
    principal: 320000, annualRate: 6, termMonths: 360,
    propertyValue: 400000, appreciationPct: 3
  });
  const yr10 = s.rows[119];
  assert.ok(yr10.homeValue > 400000 * 1.3, 'home appreciates');
  approx(yr10.equity, yr10.homeValue - yr10.balance, 0.02);
});

/* ------------------------------------------------------------------ */
/* Refinance                                                           */
/* ------------------------------------------------------------------ */

test('refinance: simple break-even is costs / monthly savings', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 7.5, currentRemainingMonths: 300,
    newRate: 6.0, newTermMonths: 300,
    closingCosts: 6000, pointsPct: 0, rollIntoLoan: false
  });
  assert.ok(r.monthlySavings > 0);
  assert.equal(r.simpleBreakEvenMonths, Math.ceil(6000 / r.monthlySavings));
  assert.ok(r.lifetimeInterestSaved > 0, 'saves interest at the same term');
});

test('refinance: rolling costs in raises the loan and pays nothing at closing', () => {
  const common = {
    currentBalance: 300000, currentRate: 7.5, currentRemainingMonths: 300,
    newRate: 6.0, newTermMonths: 300, closingCosts: 6000, pointsPct: 0
  };
  const out = F.analyzeRefinance({ ...common, rollIntoLoan: false });
  const rolled = F.analyzeRefinance({ ...common, rollIntoLoan: true });
  assert.equal(out.newPrincipal, 300000);
  assert.equal(rolled.newPrincipal, 306000);
  assert.equal(rolled.cashAtClosing, 0);
  assert.equal(out.cashAtClosing, 6000);
  assert.ok(rolled.newPayment > out.newPayment, 'rolled-in costs cost more monthly');
});

test('refinance: points are priced off the final loan amount', () => {
  const r = F.analyzeRefinance({
    currentBalance: 400000, currentRate: 7, currentRemainingMonths: 360,
    newRate: 6, newTermMonths: 360,
    closingCosts: 3000, pointsPct: 1, rollIntoLoan: true
  });
  // L = (400000 + 3000) / (1 - 0.01)
  approx(r.newPrincipal, 403000 / 0.99, 0.02);
  approx(r.pointsCost, r.newPrincipal * 0.01, 0.02);
  approx(r.totalCosts, 3000 + r.pointsCost, 0.02);
});

test('refinance: cash-out increases the balance and is not counted as a cost', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 6.5, currentRemainingMonths: 360,
    newRate: 6.5, newTermMonths: 360,
    closingCosts: 0, cashOut: 50000, rollIntoLoan: false
  });
  assert.equal(r.newPrincipal, 350000);
  assert.ok(r.monthlySavings < 0, 'borrowing more raises the payment');
  // At month 1 the cash in hand roughly offsets the larger balance.
  approx(r.series[0].advantage, 0, 400);
});

test('refinance: true break-even penalizes a term reset', () => {
  // 5 years into a 30-year loan, refinancing back to a fresh 30-year term.
  const r = F.analyzeRefinance({
    currentBalance: 280000, currentRate: 6.75, currentRemainingMonths: 300,
    newRate: 6.0, newTermMonths: 360,
    closingCosts: 5000, rollIntoLoan: false
  });
  assert.ok(r.monthlySavings > 0, 'payment drops');
  assert.ok(r.termChangeMonths > 0, 'term gets longer');
  assert.ok(r.trueBreakEvenMonths > r.simpleBreakEvenMonths,
    `true break-even (${r.trueBreakEvenMonths}) should trail the simple one (${r.simpleBreakEvenMonths})`);
});

test('refinance: no savings means no break-even', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 5.0, currentRemainingMonths: 300,
    newRate: 7.5, newTermMonths: 300, closingCosts: 5000
  });
  assert.ok(r.monthlySavings < 0);
  assert.equal(r.simpleBreakEvenMonths, Infinity);
});

test('refinance: keeping the old payment shortens the new loan', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 7.5, currentRemainingMonths: 300,
    newRate: 6.0, newTermMonths: 360, closingCosts: 4000
  });
  assert.ok(r.keepSameSchedule, 'scenario is produced');
  assert.ok(r.keepSameMonthsSaved > 0, 'pays off earlier than the new 30-year term');
  assert.ok(r.keepSameInterestSaved > 0);
});

test('refinance: invested savings compound over the stated horizon', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 7.5, currentRemainingMonths: 300,
    newRate: 6.0, newTermMonths: 300, closingCosts: 5000,
    investmentReturnPct: 7, yearsInHome: 10
  });
  assert.ok(r.savingsInvestedValue > r.monthlySavings * 120,
    'compounding beats stuffing it in a drawer');
});

/* ------------------------------------------------------------------ */
/* Buydown + reconstruction                                            */
/* ------------------------------------------------------------------ */

test('buydown break-even', () => {
  const b = F.analyzeBuydown({
    principal: 400000, termMonths: 360, baseRate: 6.5, buydownRate: 6.0, pointsPct: 1
  });
  approx(b.cost, 4000, 0.01);
  assert.ok(b.monthlySavings > 0);
  assert.equal(b.breakEvenMonths, Math.ceil(4000 / b.monthlySavings));
});

test('reconstructing a live loan from origination facts', () => {
  const live = F.currentLoanFromOrigination(
    400000, 6.5, 360, { year: 2020, month: 5 }, { year: 2026, month: 5 });
  assert.equal(live.elapsedMonths, 72);
  assert.equal(live.remainingMonths, 288);
  approx(live.payment, F.payment(400000, 6.5, 360), 0.01);
  approx(live.balance, F.balanceAfter(400000, 6.5, 360, 72), 0.01);
  assert.ok(live.balance < 400000 && live.balance > 350000);
});

/* ------------------------------------------------------------------ */
/* Fuzz — no input should ever produce a broken schedule               */
/* ------------------------------------------------------------------ */

test('fuzz: schedules stay valid across a wide input space', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 250; i++) {
    const principal = Math.round(20000 + rnd() * 1500000);
    const rate = Math.round(rnd() * 1200) / 100;      // 0% - 12%
    const term = [120, 180, 240, 300, 360, 480][Math.floor(rnd() * 6)];
    const extra = Math.floor(rnd() * 4) === 0 ? Math.round(rnd() * 2000) : 0;
    const s = F.buildSchedule({
      principal, annualRate: rate, termMonths: term,
      propertyValue: principal * (1 + rnd()),
      extras: extra ? { monthly: extra } : null,
      pmi: { enabled: rnd() > 0.5, ratePct: 0.55, cancelLtv: 78 }
    });
    const label = `P=${principal} r=${rate} n=${term} extra=${extra}`;
    assert.equal(s.error, null, `no error for ${label}`);
    assert.ok(s.months > 0 && s.months <= term, `term respected for ${label}`);
    assert.equal(s.rows[s.rows.length - 1].balance, 0, `ends at zero for ${label}`);
    approx(s.totalPrincipal, principal, 0.02, `principal identity for ${label}`);
    assert.ok(s.totalInterest >= 0, `interest non-negative for ${label}`);
  }
});

/* ------------------------------------------------------------------ */
/* APR — Regulation Z                                                  */
/* ------------------------------------------------------------------ */

test('APR equals the note rate when there are no finance charges', () => {
  approx(F.apr(300000, 0, 6.5, 360), 6.5, 0.001);
});

test('APR exceeds the note rate once costs are included', () => {
  // $200,000 @ 6.00% for 360 months with $4,000 in prepaid finance charges.
  // Amount financed $196,000 against a $1,199.10 payment -> about 6.20%.
  const a = F.apr(200000, 4000, 6, 360);
  assert.ok(a > 6 && a < 6.4, `APR ${a}`);
  approx(a, 6.196, 0.02);
});

test('APR rises with the size of the finance charge', () => {
  const low = F.apr(400000, 2000, 6.5, 360);
  const high = F.apr(400000, 12000, 6.5, 360);
  assert.ok(high > low, 'more cost of credit means a higher APR');
  assert.ok(low > 6.5, 'any finance charge lifts the APR above the note rate');
});

test('APR is defined by discounting payments back to the amount financed', () => {
  // Independent check against the Reg Z definition rather than the helper.
  const loan = 350000, charges = 7500, rate = 6.25, n = 360;
  const pmt = F.payment(loan, rate, n);
  const a = F.apr(loan, charges, rate, n);
  const i = a / 100 / 12;
  let pv = 0;
  for (let k = 1; k <= n; k++) pv += pmt / Math.pow(1 + i, k);
  approx(pv, loan - charges, 25, 'present value of payments = amount financed');
});

test('APR guards against nonsense input', () => {
  assert.equal(F.apr(0, 1000, 6, 360), 0);
  assert.equal(F.apr(100000, 0, 6, 0), 0);
  assert.equal(F.apr(100000, 200000, 6, 360), 0, 'charges exceeding the loan');
});

test('refinance analysis reports an APR above the new note rate', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 7.5, currentRemainingMonths: 300,
    newRate: 6.0, newTermMonths: 360, closingCosts: 6000, pointsPct: 1
  });
  assert.ok(r.newApr > 6.0, `APR ${r.newApr} should exceed the 6.0% note rate`);
  assert.ok(r.newApr < 7.0, 'but stay in a sane range');
});

/* ------------------------------------------------------------------ */
/* Interest-based break-even — the honest measure of a refinance       */
/* ------------------------------------------------------------------ */

const REFI = {
  currentBalance: 320000, currentRate: 7.25, currentRemainingMonths: 324,
  newRate: 5.75, newTermMonths: 360, closingCosts: 6000, yearsInHome: 7
};

test('interest break-even is where cumulative interest saved covers the cost', () => {
  const r = F.analyzeRefinance(REFI);
  const m = r.interestBreakEvenMonths;
  assert.ok(m > 0, 'a break-even month exists');
  assert.ok(r.series[m - 1].interestSaved >= r.totalCosts,
    'cost is covered at the break-even month');
  assert.ok(r.series[m - 2].interestSaved < r.totalCosts,
    'and was NOT covered the month before — the crossover is exact');
});

test('interest saved is current-loan interest minus new-loan interest', () => {
  const r = F.analyzeRefinance(REFI);
  for (const m of [1, 12, 60, 120]) {
    const row = r.series[m - 1];
    approx(row.interestSaved, row.currentInterest - row.newInterest, 0.02,
      `month ${m} interest saved`);
  }
});

test('cumulative interest matches an independent walk of each schedule', () => {
  const r = F.analyzeRefinance(REFI);
  let cur = 0, nw = 0;
  for (let i = 0; i < 60; i++) {
    cur += r.currentSchedule.rows[i].interest;
    nw += r.newSchedule.rows[i].interest;
  }
  approx(r.series[59].currentInterest, cur, 0.05);
  approx(r.series[59].newInterest, nw, 0.05);
});

test('interest saved only counts interest, never principal', () => {
  // Same rate, same term, zero cost: payments and balances are identical, so
  // there is no interest saved even though a great deal of principal moves.
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 6, currentRemainingMonths: 360,
    newRate: 6, newTermMonths: 360, closingCosts: 0
  });
  approx(r.series[119].interestSaved, 0, 1, 'no rate change means no interest saved');
});

test('interest break-even is stricter than the payment-savings break-even', () => {
  // Extending 27 years back out to 30 lowers the payment partly by paying less
  // principal. The payment-based figure rewards that; the interest-based one
  // must not.
  const r = F.analyzeRefinance(REFI);
  assert.ok(r.monthlySavings > 0, 'payment drops');
  assert.ok(r.interestBreakEvenMonths >= r.simpleBreakEvenMonths,
    `interest break-even (${r.interestBreakEvenMonths}) should not beat the payment-based ` +
    `figure (${r.simpleBreakEvenMonths})`);
});

test('a term extension at a barely-better rate never repays its cost in interest', () => {
  const r = F.analyzeRefinance({
    currentBalance: 280000, currentRate: 6.0, currentRemainingMonths: 240,
    newRate: 5.9, newTermMonths: 360, closingCosts: 9000
  });
  assert.ok(r.monthlySavings > 0, 'the payment still goes down');
  assert.equal(r.interestBreakEvenMonths, null,
    'but stretching the term means interest never comes out ahead');
});

test('cash-out is not disguised as interest savings', () => {
  const r = F.analyzeRefinance({
    currentBalance: 300000, currentRate: 6.5, currentRemainingMonths: 360,
    newRate: 6.5, newTermMonths: 360, closingCosts: 4000, cashOut: 60000
  });
  assert.ok(r.series[59].interestSaved < 0, 'borrowing more costs more interest');
  assert.equal(r.interestBreakEvenMonths, null, 'no interest break-even');
});

test('first-month interest saving is reported', () => {
  const r = F.analyzeRefinance(REFI);
  const expected = r.currentSchedule.rows[0].interest - r.newSchedule.rows[0].interest;
  approx(r.monthlyInterestSavedFirstMonth, expected, 0.02);
  assert.ok(r.monthlyInterestSavedFirstMonth > 0, 'a lower rate saves interest immediately');
});

test('interest saved at the horizon matches the series', () => {
  const r = F.analyzeRefinance(REFI);
  approx(r.interestSavedAtHorizon, r.series[7 * 12 - 1].interestSaved, 0.02);
});

/* ------------------------------------------------------------------ */
/* Debt consolidation                                                  */
/* ------------------------------------------------------------------ */

const DEBTS = [
  { creditor: 'Visa', balance: 14000, payment: 420, rate: 24.99 },
  { creditor: 'Auto loan', balance: 22000, payment: 540, rate: 8.5 },
  { creditor: 'Student loan', balance: 31000, payment: 330, rate: 6.8 }
];
const CONSOL = {
  currentBalance: 320000, currentRate: 7.25, currentRemainingMonths: 324,
  newRate: 6.25, newTermMonths: 360, closingCosts: 6000, debts: DEBTS
};

test('debt summary totals balances, payments and blended rate', () => {
  const d = F.summarizeDebts(DEBTS);
  assert.equal(d.count, 3);
  assert.equal(d.totalBalance, 67000);
  assert.equal(d.totalMonthly, 1290);
  // Balance-weighted: (14000*24.99 + 22000*8.5 + 31000*6.8) / 67000
  approx(d.blendedRate, (14000 * 24.99 + 22000 * 8.5 + 31000 * 6.8) / 67000, 0.01);
  assert.ok(d.blendedRate > 11 && d.blendedRate < 12, `blended ${d.blendedRate}`);
});

test('debt summary computes payoff time and interest per creditor', () => {
  const d = F.summarizeDebts(DEBTS);
  const visa = d.rows.find(r => r.creditor === 'Visa');
  assert.equal(visa.months, F.monthsToPayoff(14000, 24.99, 420));
  approx(visa.totalInterest, 420 * visa.months - 14000, 0.01);
  assert.ok(visa.totalInterest > 0);
  for (const r of d.rows) assert.ok(r.months > 0 && isFinite(r.months));
});

test('a payment that cannot cover the interest is flagged, not faked', () => {
  const d = F.summarizeDebts([{ creditor: 'Maxed card', balance: 20000, payment: 200, rate: 26 }]);
  // $20,000 at 26% accrues about $433 a month — a $200 payment never wins.
  assert.equal(d.rows[0].neverPaysOff, true);
  assert.equal(d.rows[0].months, Infinity);
  assert.equal(d.anyNeverPaysOff, true);
  assert.equal(d.totalInterest, Infinity, 'unbounded interest is not silently summed');
});

test('zero-rate debts amortize straight-line', () => {
  const d = F.summarizeDebts([{ creditor: '0% promo', balance: 6000, payment: 500, rate: 0 }]);
  assert.equal(d.rows[0].months, 12);
  approx(d.rows[0].totalInterest, 0, 0.01);
});

test('summarizeDebts ignores empty rows', () => {
  const d = F.summarizeDebts([null, { balance: 0, payment: 0 }, { creditor: 'Real', balance: 5000, payment: 200, rate: 10 }]);
  assert.equal(d.count, 1);
  assert.equal(d.totalBalance, 5000);
});

test('consolidating adds the debt balances to the new loan', () => {
  const r = F.analyzeConsolidation(CONSOL);
  assert.equal(r.newPrincipalRefiOnly, 320000);
  assert.equal(r.newPrincipalConsolidated, 320000 + 67000);
});

test('monthly savings is what the borrower stops paying out', () => {
  const r = F.analyzeConsolidation(CONSOL);
  const mortgageToday = r.withoutConsolidation.currentPayment;
  approx(r.monthlyToday, mortgageToday + 1290, 0.01, 'today = mortgage + debt service');
  approx(r.monthlyConsolidated, r.withConsolidation.newPayment, 0.01,
    'after consolidating there is only the mortgage');
  approx(r.monthlySavingsConsolidated, r.monthlyToday - r.monthlyConsolidated, 0.01);
  assert.ok(r.monthlySavingsConsolidated > 1000,
    `should be a large monthly saving, got ${r.monthlySavingsConsolidated}`);
});

test('the include-vs-exclude difference is isolated', () => {
  const r = F.analyzeConsolidation(CONSOL);
  // Refinancing alone saves something; consolidating on top saves more.
  assert.ok(r.monthlySavingsRefiOnly > 0, 'the refinance alone helps');
  assert.ok(r.monthlySavingsConsolidated > r.monthlySavingsRefiOnly,
    'including the debts saves more each month');
  approx(r.monthlySavingsFromConsolidating,
    r.monthlySavingsConsolidated - r.monthlySavingsRefiOnly, 0.01,
    'the incremental benefit of consolidating is isolated correctly');
  approx(r.monthlySavingsFromConsolidating, r.monthlyRefiOnly - r.monthlyConsolidated, 0.01);
});

test('the lifetime interest cost of consolidating is surfaced', () => {
  const r = F.analyzeConsolidation(CONSOL);
  // Stretching short consumer debt over 30 years costs more interest even at a
  // much lower rate. The tool must not hide that behind the monthly saving.
  assert.ok(r.interestOnConsolidatedDebt > 0);
  assert.ok(r.interestIfDebtsKept > 0);
  assert.ok(r.lifetimeInterestDelta > 0,
    'consolidating 5-year debt into a 30-year loan costs more interest overall');
  approx(r.lifetimeInterestDelta,
    r.interestOnConsolidatedDebt - r.interestIfDebtsKept, 0.02);
});

test('interest added equals the difference between the two mortgages', () => {
  const r = F.analyzeConsolidation(CONSOL);
  approx(r.interestOnConsolidatedDebt,
    r.withConsolidation.newTotalInterest - r.withoutConsolidation.newTotalInterest, 0.02);
});

test('a short term can make consolidating cheaper on interest too', () => {
  // Expensive revolving debt rolled into a 15-year loan at 6.25%.
  const r = F.analyzeConsolidation({
    ...CONSOL, newTermMonths: 180,
    debts: [{ creditor: 'Cards', balance: 40000, payment: 900, rate: 27 }]
  });
  assert.ok(r.monthlySavingsConsolidated > 0, 'still saves monthly');
  assert.ok(r.lifetimeInterestDelta < 0,
    'and at 27% versus 6.25% over 15 years it saves interest as well');
});

test('blended rate exposes the true cost of carrying the debt', () => {
  const r = F.analyzeConsolidation(CONSOL);
  assert.ok(r.blendedRateBefore > r.withoutConsolidation.currentSchedule.annualRate,
    'high-rate consumer debt drags the blended rate above the mortgage rate');
  assert.ok(r.blendedRateBefore > r.newRate,
    'and above the new mortgage rate, which is the point of consolidating');
});

test('no debts means consolidation changes nothing', () => {
  const r = F.analyzeConsolidation({ ...CONSOL, debts: [] });
  assert.equal(r.debts.totalBalance, 0);
  assert.equal(r.newPrincipalConsolidated, r.newPrincipalRefiOnly);
  approx(r.monthlySavingsFromConsolidating, 0, 0.01);
  approx(r.monthlySavingsConsolidated, r.monthlySavingsRefiOnly, 0.01);
});

test('consolidation respects rolling closing costs into the loan', () => {
  const r = F.analyzeConsolidation({ ...CONSOL, rollIntoLoan: true });
  assert.equal(r.newPrincipalConsolidated, 320000 + 67000 + 6000);
  assert.equal(r.withConsolidation.cashAtClosing, 0);
});

test('consolidation combines with cash-out without double counting', () => {
  const r = F.analyzeConsolidation({ ...CONSOL, cashOut: 25000 });
  assert.equal(r.newPrincipalConsolidated, 320000 + 67000 + 25000);
  assert.equal(r.newPrincipalRefiOnly, 320000 + 25000);
});
