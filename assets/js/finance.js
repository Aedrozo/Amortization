/*!
 * finance.js — Mortgage amortization, prepayment and refinance engine.
 *
 * Pure functions, no DOM, no dependencies. Usable in the browser (window.Finance)
 * and in Node (module.exports) so the same code that runs the UI is unit-tested.
 *
 * Money convention: all internal arithmetic is done in whole cents using integer
 * math wherever a rounding boundary exists, then surfaced as dollars. This keeps
 * the schedule free of the floating-point drift that makes a lot of online
 * calculators end on a $0.03 balance.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Finance = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_MONTHS = 1200; // 100 years — runaway guard for pathological inputs.

  /* ------------------------------------------------------------------ *
   * Money helpers
   * ------------------------------------------------------------------ */

  /** Round a dollar amount to cents, away from zero on the .005 boundary. */
  function round2(x) {
    if (!isFinite(x)) return 0;
    return Math.round((x + Number.EPSILON) * 100) / 100;
  }

  /** Dollars -> integer cents. */
  function cents(x) {
    return Math.round((x + Number.EPSILON) * 100);
  }

  /** Integer cents -> dollars. */
  function dollars(c) {
    return c / 100;
  }

  function clampNum(x, lo, hi) {
    x = Number(x);
    if (!isFinite(x)) x = lo;
    return Math.min(hi, Math.max(lo, x));
  }

  function num(x, fallback) {
    var n = typeof x === 'string' ? Number(String(x).replace(/[^0-9.\-]/g, '')) : Number(x);
    return isFinite(n) ? n : (fallback || 0);
  }

  /* ------------------------------------------------------------------ *
   * Date helpers — schedules are keyed to a month index, not a Date object,
   * so daylight-saving and timezone shifts can never move a payment.
   * ------------------------------------------------------------------ */

  /** Add `n` months to {year, month} where month is 0-11. */
  function addMonths(start, n) {
    var total = start.year * 12 + start.month + n;
    return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
  }

  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatMonth(ym) {
    return MONTH_NAMES[ym.month] + ' ' + ym.year;
  }

  function todayYM() {
    var d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  }

  /* ------------------------------------------------------------------ *
   * Core payment math
   * ------------------------------------------------------------------ */

  function monthlyRate(annualRatePct) {
    return num(annualRatePct) / 100 / 12;
  }

  /**
   * Standard fully-amortizing payment.
   *   pmt = P * r / (1 - (1+r)^-n)
   * Zero-rate loans fall back to straight-line principal.
   */
  function payment(principal, annualRatePct, termMonths) {
    principal = num(principal);
    termMonths = Math.round(num(termMonths));
    if (principal <= 0 || termMonths <= 0) return 0;
    var r = monthlyRate(annualRatePct);
    if (Math.abs(r) < 1e-12) return round2(principal / termMonths);
    var factor = Math.pow(1 + r, termMonths);
    return round2((principal * r * factor) / (factor - 1));
  }

  /**
   * Remaining balance after `k` payments of a level-payment loan.
   * Used to reconstruct a current loan from its origination terms.
   */
  function balanceAfter(principal, annualRatePct, termMonths, k) {
    principal = num(principal);
    k = clampNum(k, 0, termMonths);
    var r = monthlyRate(annualRatePct);
    var pmt = payment(principal, annualRatePct, termMonths);
    if (Math.abs(r) < 1e-12) return Math.max(0, round2(principal - pmt * k));
    var f = Math.pow(1 + r, k);
    return Math.max(0, round2(principal * f - pmt * ((f - 1) / r)));
  }

  /**
   * Number of months to retire `principal` at a given payment.
   * Returns Infinity when the payment can never cover the accruing interest.
   */
  function monthsToPayoff(principal, annualRatePct, pmt) {
    principal = num(principal);
    pmt = num(pmt);
    if (principal <= 0) return 0;
    var r = monthlyRate(annualRatePct);
    if (Math.abs(r) < 1e-12) return pmt > 0 ? Math.ceil(principal / pmt) : Infinity;
    if (pmt <= principal * r) return Infinity;
    return Math.ceil(-Math.log(1 - (principal * r) / pmt) / Math.log(1 + r));
  }

  /**
   * The rate that makes `pmt` amortize `principal` over `termMonths`.
   * Bisection — robust for every input range a mortgage can produce, unlike
   * Newton's method which can diverge on near-zero rates.
   */
  function rateFromPayment(principal, pmt, termMonths) {
    principal = num(principal); pmt = num(pmt); termMonths = Math.round(num(termMonths));
    if (principal <= 0 || termMonths <= 0 || pmt <= 0) return 0;
    if (pmt * termMonths <= principal) return 0;
    var lo = 0, hi = 100;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (payment(principal, mid, termMonths) > pmt) hi = mid; else lo = mid;
    }
    return round4((lo + hi) / 2);
  }

  function round4(x) { return Math.round(x * 10000) / 10000; }

  /**
   * Annual Percentage Rate.
   *
   * Regulation Z (12 CFR 1026.22) defines the APR as the rate that discounts the
   * stream of payments back to the "amount financed" — the loan amount less the
   * prepaid finance charges (points, origination, and other lender fees retained
   * as a cost of credit). Third-party charges that are not finance charges
   * (appraisal, title, recording) should be excluded by the caller.
   *
   * Returns the nominal annual rate as a percentage, so it is directly
   * comparable to the note rate the borrower typed in.
   */
  function apr(loanAmount, financeCharges, annualRatePct, termMonths) {
    loanAmount = Math.max(0, num(loanAmount));
    financeCharges = Math.max(0, num(financeCharges));
    termMonths = Math.round(num(termMonths));
    if (loanAmount <= 0 || termMonths <= 0) return 0;
    var pmt = payment(loanAmount, annualRatePct, termMonths);
    var amountFinanced = loanAmount - financeCharges;
    if (amountFinanced <= 0) return 0;
    // With no finance charges the APR collapses to the note rate.
    if (financeCharges === 0) return round4(num(annualRatePct));
    return rateFromPayment(amountFinanced, pmt, termMonths);
  }

  /* ------------------------------------------------------------------ *
   * Extra-payment plan
   * ------------------------------------------------------------------ */

  /**
   * Normalizes the many ways a borrower can prepay into a single
   * "extra dollars applied in month i" lookup.
   *
   * extras = {
   *   monthly:      number,                 // every month
   *   startMonth:   number,                 // 1-based month extra payments begin
   *   annual:       number,                 // once a year
   *   annualMonth:  1-12,                   // calendar month the annual hit lands
   *   biweekly:     boolean,                // accelerated biweekly equivalent
   *   roundUpTo:    number,                 // round total P&I+extra up to a multiple
   *   oneTime:      [{ amount, year, month }]
   * }
   */
  function extraForMonth(extras, index, ym, basePayment) {
    if (!extras) return 0;
    var e = 0;
    var startMonth = Math.max(1, Math.round(num(extras.startMonth, 1)) || 1);

    if (index >= startMonth) {
      e += Math.max(0, num(extras.monthly));

      // Accelerated biweekly: 26 half-payments a year equals 13 monthly
      // payments, i.e. one extra payment per year. Servicers hold the halves
      // and apply them as they accumulate, so spreading 1/12 of a payment
      // across each month is the standard (and slightly conservative) model.
      if (extras.biweekly) e += basePayment / 12;

      var annual = Math.max(0, num(extras.annual));
      if (annual > 0) {
        var target = clampNum(Math.round(num(extras.annualMonth, 12)), 1, 12) - 1;
        if (ym.month === target) e += annual;
      }
    }

    var one = extras.oneTime;
    if (Array.isArray(one)) {
      for (var i = 0; i < one.length; i++) {
        var o = one[i];
        if (!o) continue;
        var amt = Math.max(0, num(o.amount));
        if (amt <= 0) continue;
        if (Number(o.year) === ym.year && Number(o.month) === ym.month) e += amt;
      }
    }
    return e;
  }

  /* ------------------------------------------------------------------ *
   * PMI
   * ------------------------------------------------------------------ */

  /**
   * Monthly mortgage insurance. Premiums are quoted against the ORIGINAL loan
   * amount and are removed once the loan-to-value on the ORIGINAL value hits
   * the cancellation threshold (78% automatic under the Homeowners Protection
   * Act, 80% on borrower request).
   */
  function pmiMonthly(cfg) {
    if (!cfg || !cfg.enabled) return 0;
    if (num(cfg.monthlyAmount) > 0) return round2(num(cfg.monthlyAmount));
    return round2((num(cfg.loanAmount) * (num(cfg.ratePct) / 100)) / 12);
  }

  /* ------------------------------------------------------------------ *
   * Schedule builder — the heart of everything
   * ------------------------------------------------------------------ */

  /**
   * Build a month-by-month amortization schedule.
   *
   * opts = {
   *   principal, annualRate, termMonths,
   *   start: {year, month},           // first payment
   *   paymentOverride,                // force a payment (used by "keep my old payment")
   *   extras,                         // see extraForMonth
   *   propertyValue,                  // for LTV / equity / PMI cancellation
   *   appreciationPct,                // annual home appreciation, for equity tracking
   *   pmi: { enabled, ratePct, monthlyAmount, cancelLtv },
   *   escrow: { taxAnnual, insuranceAnnual, hoaMonthly, otherMonthly, inflationPct }
   * }
   */
  function buildSchedule(opts) {
    opts = opts || {};
    var principal = Math.max(0, num(opts.principal));
    var termMonths = Math.max(0, Math.round(num(opts.termMonths)));
    var rate = num(opts.annualRate);
    var r = monthlyRate(rate);
    var start = opts.start || todayYM();
    var extras = opts.extras || null;
    var escrow = opts.escrow || {};
    var pmiCfg = opts.pmi || {};
    var propertyValue = num(opts.propertyValue) || principal;
    var apprMonthly = Math.pow(1 + num(opts.appreciationPct) / 100, 1 / 12) - 1;

    var basePayment = num(opts.paymentOverride) > 0
      ? round2(num(opts.paymentOverride))
      : payment(principal, rate, termMonths);

    var result = {
      rows: [],
      years: [],
      basePayment: basePayment,
      scheduledPayment: payment(principal, rate, termMonths),
      principal: principal,
      annualRate: rate,
      termMonths: termMonths,
      start: start,
      error: null,
      totalInterest: 0,
      totalPrincipal: 0,
      totalExtra: 0,
      totalPmi: 0,
      totalEscrow: 0,
      totalPaid: 0,
      totalOutOfPocket: 0,
      months: 0,
      payoff: start,
      pmiEndMonth: null,
      pmiEndDate: null,
      firstMonthInterest: 0,
      interestSharePct: 0
    };

    if (principal <= 0 || termMonths <= 0) {
      result.error = principal <= 0 ? 'no-principal' : 'no-term';
      return result;
    }

    // A payment that never covers the first month's interest can only ever
    // grow the balance. Refuse to produce a fake schedule.
    var firstInterest = round2(principal * r);
    result.firstMonthInterest = firstInterest;
    var firstExtra = extraForMonth(extras, 1, start, basePayment);
    if (basePayment + firstExtra <= firstInterest + 0.005 && r > 0) {
      result.error = 'negative-amortization';
      return result;
    }

    var balC = cents(principal);          // balance, in cents
    var cumInterestC = 0, cumPrincipalC = 0, cumExtraC = 0, cumPmiC = 0, cumEscrowC = 0;
    var basePayC = cents(basePayment);
    var pmiBase = pmiMonthly({
      enabled: pmiCfg.enabled,
      ratePct: pmiCfg.ratePct,
      monthlyAmount: pmiCfg.monthlyAmount,
      loanAmount: principal
    });
    var cancelLtv = clampNum(num(pmiCfg.cancelLtv, 78), 0, 100);
    var homeValue = propertyValue;
    var inflation = num(escrow.inflationPct) / 100;

    var i = 0;
    while (balC > 0 && i < MAX_MONTHS) {
      i++;
      var ym = addMonths(start, i - 1);
      var yearOffset = Math.floor((i - 1) / 12);
      var startBalC = balC;

      // --- Interest -------------------------------------------------
      var interestC = Math.round(startBalC * r);
      if (interestC < 0) interestC = 0;

      // --- Scheduled principal --------------------------------------
      var payC = basePayC;
      var principalC = payC - interestC;

      // Final payment: never collect more principal than is owed.
      if (principalC >= startBalC) {
        principalC = startBalC;
        payC = principalC + interestC;
      } else if (i >= termMonths && (startBalC - principalC) < payC) {
        // Because the level payment is rounded to whole cents, a loan drifts a
        // few dollars off zero by maturity. Servicers absorb that residual into
        // the final scheduled payment rather than billing a stray $1.45 in
        // month 361 — match that so a 30-year loan is exactly 360 payments.
        principalC = startBalC;
        payC = principalC + interestC;
      }
      if (principalC < 0) principalC = 0; // shouldn't happen after the guard above

      var remainingAfterScheduled = startBalC - principalC;

      // --- Extra principal ------------------------------------------
      var extraC = cents(extraForMonth(extras, i, ym, basePayment));

      // Round-up: lift the total principal+interest outlay to the next
      // multiple of `roundUpTo`.
      var roundUpTo = extras ? num(extras.roundUpTo) : 0;
      if (roundUpTo > 0) {
        var stepC = cents(roundUpTo);
        var currentC = payC + extraC;
        var targetC = Math.ceil(currentC / stepC) * stepC;
        if (targetC > currentC) extraC += targetC - currentC;
      }

      if (extraC > remainingAfterScheduled) extraC = remainingAfterScheduled;
      if (extraC < 0) extraC = 0;

      balC = remainingAfterScheduled - extraC;

      // --- Home value / equity / LTV --------------------------------
      if (i > 1) homeValue = homeValue * (1 + apprMonthly);
      var balanceDollars = dollars(balC);
      var ltvOriginal = propertyValue > 0 ? (balanceDollars / propertyValue) * 100 : 0;
      var ltvCurrent = homeValue > 0 ? (balanceDollars / homeValue) * 100 : 0;

      // --- PMI --------------------------------------------------------
      // Cancellation tests against the original property value, per HPA.
      var pmiC = 0;
      if (pmiBase > 0 && result.pmiEndMonth === null) {
        var ltvAtStart = propertyValue > 0 ? (dollars(startBalC) / propertyValue) * 100 : 0;
        if (ltvAtStart > cancelLtv) {
          pmiC = cents(pmiBase);
        } else {
          result.pmiEndMonth = i - 1;
          result.pmiEndDate = addMonths(start, Math.max(0, i - 2));
        }
      }

      // --- Escrow & other monthly costs -------------------------------
      var infFactor = Math.pow(1 + inflation, yearOffset);
      var taxC = Math.round(cents(num(escrow.taxAnnual) / 12) * infFactor);
      var insC = Math.round(cents(num(escrow.insuranceAnnual) / 12) * infFactor);
      var hoaC = Math.round(cents(num(escrow.hoaMonthly)) * infFactor);
      var otherC = Math.round(cents(num(escrow.otherMonthly)) * infFactor);
      var escrowC = taxC + insC + hoaC + otherC;

      cumInterestC += interestC;
      cumPrincipalC += principalC + extraC;
      cumExtraC += extraC;
      cumPmiC += pmiC;
      cumEscrowC += escrowC;

      result.rows.push({
        n: i,
        ym: ym,
        date: formatMonth(ym),
        year: ym.year,
        startBalance: dollars(startBalC),
        payment: dollars(payC),
        principal: dollars(principalC),
        interest: dollars(interestC),
        extra: dollars(extraC),
        pmi: dollars(pmiC),
        tax: dollars(taxC),
        insurance: dollars(insC),
        hoa: dollars(hoaC),
        other: dollars(otherC),
        escrow: dollars(escrowC),
        totalPayment: dollars(payC + extraC + pmiC + escrowC),
        cumInterest: dollars(cumInterestC),
        cumPrincipal: dollars(cumPrincipalC),
        balance: balanceDollars,
        homeValue: homeValue,
        equity: homeValue - balanceDollars,
        ltv: ltvOriginal,
        ltvCurrent: ltvCurrent
      });
    }

    if (result.pmiEndMonth === null && pmiBase > 0) {
      result.pmiEndMonth = i;
      result.pmiEndDate = addMonths(start, Math.max(0, i - 1));
    }

    result.months = i;
    result.payoff = addMonths(start, Math.max(0, i - 1));
    result.totalInterest = dollars(cumInterestC);
    result.totalPrincipal = dollars(cumPrincipalC);
    result.totalExtra = dollars(cumExtraC);
    result.totalPmi = dollars(cumPmiC);
    result.totalEscrow = dollars(cumEscrowC);
    result.totalPaid = dollars(cumInterestC + cumPrincipalC);
    result.totalOutOfPocket = dollars(cumInterestC + cumPrincipalC + cumPmiC + cumEscrowC);
    result.interestSharePct = principal > 0 ? (result.totalInterest / principal) * 100 : 0;
    result.years = summarizeByYear(result.rows);
    if (i >= MAX_MONTHS && balC > 0) result.error = 'no-payoff';
    return result;
  }

  /** Collapse a monthly schedule into calendar-year buckets. */
  function summarizeByYear(rows) {
    var out = [], byYear = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var y = byYear[row.year];
      if (!y) {
        y = byYear[row.year] = {
          year: row.year, principal: 0, interest: 0, extra: 0, pmi: 0,
          escrow: 0, payment: 0, totalPayment: 0, balance: 0,
          equity: 0, homeValue: 0, ltv: 0, months: 0, rows: []
        };
        out.push(y);
      }
      y.principal += row.principal;
      y.interest += row.interest;
      y.extra += row.extra;
      y.pmi += row.pmi;
      y.escrow += row.escrow;
      y.payment += row.payment;
      y.totalPayment += row.totalPayment;
      y.balance = row.balance;
      y.equity = row.equity;
      y.homeValue = row.homeValue;
      y.ltv = row.ltv;
      y.months++;
      y.rows.push(row);
    }
    for (var k = 0; k < out.length; k++) {
      var o = out[k];
      o.principal = round2(o.principal); o.interest = round2(o.interest);
      o.extra = round2(o.extra); o.pmi = round2(o.pmi);
      o.escrow = round2(o.escrow); o.payment = round2(o.payment);
      o.totalPayment = round2(o.totalPayment);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Prepayment comparison
   * ------------------------------------------------------------------ */

  /**
   * Baseline vs. accelerated schedule. Returns both schedules plus the
   * savings deltas a borrower actually cares about.
   */
  function comparePrepayment(baseOpts, extras) {
    var base = buildSchedule(Object.assign({}, baseOpts, { extras: null }));
    var accelerated = buildSchedule(Object.assign({}, baseOpts, { extras: extras }));
    var monthsSaved = base.months - accelerated.months;
    return {
      base: base,
      accelerated: accelerated,
      interestSaved: round2(base.totalInterest - accelerated.totalInterest),
      pmiSaved: round2(base.totalPmi - accelerated.totalPmi),
      totalSaved: round2(base.totalOutOfPocket - accelerated.totalOutOfPocket),
      monthsSaved: monthsSaved,
      yearsSaved: Math.floor(monthsSaved / 12),
      remainderMonthsSaved: monthsSaved % 12,
      extraPaid: accelerated.totalExtra,
      // Every $1 of extra principal returns this much in avoided interest.
      returnPerDollar: accelerated.totalExtra > 0
        ? round2((base.totalInterest - accelerated.totalInterest) / accelerated.totalExtra)
        : 0
    };
  }

  /**
   * Goal seek: the flat monthly extra required to retire the loan in
   * `targetMonths`. Bisection on the schedule builder so PMI, one-time
   * payments and every other wrinkle are respected.
   */
  function extraNeededForTerm(baseOpts, targetMonths, seedExtras) {
    targetMonths = Math.max(1, Math.round(num(targetMonths)));
    var probe = function (extraMonthly) {
      var e = Object.assign({}, seedExtras || {}, { monthly: extraMonthly });
      return buildSchedule(Object.assign({}, baseOpts, { extras: e }));
    };
    var zero = probe(0);
    if (zero.error) return { extra: 0, schedule: zero, achievable: false };
    if (zero.months <= targetMonths) return { extra: 0, schedule: zero, achievable: true };

    var lo = 0, hi = Math.max(100, num(baseOpts.principal));
    for (var i = 0; i < 80; i++) {
      var mid = (lo + hi) / 2;
      if (probe(mid).months <= targetMonths) hi = mid; else lo = mid;
    }
    var extra = Math.ceil(hi * 100) / 100;
    return { extra: extra, schedule: probe(extra), achievable: true };
  }

  /** Payoff/interest impact across a ladder of extra-payment amounts. */
  function sensitivity(baseOpts, amounts) {
    var base = buildSchedule(Object.assign({}, baseOpts, { extras: null }));
    return (amounts || []).map(function (amt) {
      var s = buildSchedule(Object.assign({}, baseOpts, { extras: { monthly: amt } }));
      var saved = base.months - s.months;
      return {
        extra: amt,
        months: s.months,
        monthsSaved: saved,
        yearsSaved: Math.floor(saved / 12),
        remMonths: saved % 12,
        payoff: s.payoff,
        totalInterest: s.totalInterest,
        interestSaved: round2(base.totalInterest - s.totalInterest),
        newPayment: round2(base.basePayment + amt)
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * Refinance
   * ------------------------------------------------------------------ */

  /**
   * Full refinance analysis.
   *
   * opts = {
   *   currentBalance, currentRate, currentRemainingMonths,
   *   currentPaymentOverride,           // optional: actual P&I if it differs
   *   newRate, newTermMonths,
   *   closingCosts, pointsPct, rollIntoLoan, cashOut,
   *   start: {year, month},
   *   investmentReturnPct,              // opportunity cost on monthly savings
   *   yearsInHome,                      // horizon for the verdict
   *   extras                            // optional prepay plan applied to the new loan
   * }
   */
  function analyzeRefinance(opts) {
    opts = opts || {};
    var start = opts.start || todayYM();
    var balance = Math.max(0, num(opts.currentBalance));
    var curRate = num(opts.currentRate);
    var curMonths = Math.max(0, Math.round(num(opts.currentRemainingMonths)));
    var newRate = num(opts.newRate);
    var newMonths = Math.max(0, Math.round(num(opts.newTermMonths)));

    var pointsPct = Math.max(0, num(opts.pointsPct));
    var flatCosts = Math.max(0, num(opts.closingCosts));
    var cashOut = Math.max(0, num(opts.cashOut));
    // Consumer debt being paid off at closing. Behaves like cash-out for sizing
    // the new loan, but it discharges a liability instead of landing in pocket.
    var debtPayoff = Math.max(0, num(opts.debtPayoff));
    var rollIn = !!opts.rollIntoLoan;

    // Points are quoted against the new loan amount, which itself depends on
    // whether costs are rolled in — solve the small circular reference directly.
    // L = balance + cashOut + debtPayoff + roll * (flat + points% * L)
    var newPrincipal;
    if (rollIn) {
      var p = pointsPct / 100;
      newPrincipal = (balance + cashOut + debtPayoff + flatCosts) / (1 - p);
    } else {
      newPrincipal = balance + cashOut + debtPayoff;
    }
    newPrincipal = round2(newPrincipal);
    var pointsCost = round2(newPrincipal * (pointsPct / 100));
    var totalCosts = round2(flatCosts + pointsCost);
    var cashAtClosing = rollIn ? 0 : totalCosts;

    var currentSchedule = buildSchedule({
      principal: balance, annualRate: curRate, termMonths: curMonths, start: start,
      paymentOverride: opts.currentPaymentOverride
    });
    var newSchedule = buildSchedule({
      principal: newPrincipal, annualRate: newRate, termMonths: newMonths, start: start,
      extras: opts.extras || null
    });

    var currentPayment = currentSchedule.basePayment;
    var newPayment = newSchedule.basePayment;
    var monthlySavings = round2(currentPayment - newPayment);

    // --- Simple break-even: the number every lender quotes ---------------
    var simpleBreakEven = monthlySavings > 0 ? Math.ceil(totalCosts / monthlySavings) : Infinity;

    // --- True break-even: cumulative cost crossover ---------------------
    // Compares total dollars out the door AND the equity position, so a
    // refinance that lowers the payment by stretching the term doesn't look
    // free. Cost(m) = cash paid through month m + remaining balance.
    var horizon = Math.max(currentSchedule.months, newSchedule.months);
    var crossover = null;
    var interestCrossover = null;
    var series = [];
    var curPaid = 0, newPaid = cashAtClosing;
    var curBal = balance, newBal = newPrincipal;
    var curInterest = 0, newInterest = 0;
    for (var m = 1; m <= horizon; m++) {
      var cRow = currentSchedule.rows[m - 1];
      var nRow = newSchedule.rows[m - 1];
      if (cRow) { curPaid += cRow.payment; curBal = cRow.balance; curInterest += cRow.interest; }
      if (nRow) { newPaid += nRow.payment + nRow.extra; newBal = nRow.balance; newInterest += nRow.interest; }
      var curCost = curPaid + curBal;
      // Cash-out proceeds are money in the borrower's pocket, and a debt paid
      // off at closing discharges a liability of equal size — neither is a cost.
      var newCost = newPaid + newBal - cashOut - debtPayoff;

      // Interest is the only part of a payment the borrower never gets back —
      // principal is equity. Measuring the refinance against interest avoided
      // is the honest read on when it has paid for itself.
      var interestSaved = curInterest - newInterest;

      series.push({
        month: m, ym: addMonths(start, m - 1),
        currentCost: round2(curCost), newCost: round2(newCost),
        currentPaid: round2(curPaid), newPaid: round2(newPaid),
        currentBalance: round2(curBal), newBalance: round2(newBal),
        currentInterest: round2(curInterest), newInterest: round2(newInterest),
        interestSaved: round2(interestSaved),
        costLine: totalCosts,
        advantage: round2(curCost - newCost)
      });
      if (crossover === null && newCost <= curCost) crossover = m;
      if (interestCrossover === null && interestSaved >= totalCosts) interestCrossover = m;
    }

    var yearsInHome = Math.max(0, num(opts.yearsInHome, 7));
    var horizonMonths = Math.min(series.length, Math.round(yearsInHome * 12));
    var atHorizon = horizonMonths > 0 ? series[horizonMonths - 1] : null;

    // --- Opportunity cost: bank the savings instead of spending it -------
    var invRate = num(opts.investmentReturnPct) / 100 / 12;
    var fv = 0;
    var investMonths = Math.min(series.length, Math.round(yearsInHome * 12));
    if (monthlySavings > 0) {
      for (var j = 0; j < investMonths; j++) fv = fv * (1 + invRate) + monthlySavings;
    }

    // --- "Keep paying my old payment" on the new loan --------------------
    var keepSame = null;
    if (monthlySavings > 0 && newPrincipal > 0) {
      keepSame = buildSchedule({
        principal: newPrincipal, annualRate: newRate, termMonths: newMonths, start: start,
        extras: { monthly: monthlySavings }
      });
    }

    var lifetimeInterestSaved = round2(currentSchedule.totalInterest - newSchedule.totalInterest);

    // Reg Z APR on the new loan: the note rate plus the cost of credit.
    var newApr = apr(newPrincipal, totalCosts, newRate, newMonths);

    return {
      currentSchedule: currentSchedule,
      newSchedule: newSchedule,
      keepSameSchedule: keepSame,
      newPrincipal: newPrincipal,
      newApr: newApr,
      pointsCost: pointsCost,
      totalCosts: totalCosts,
      cashAtClosing: cashAtClosing,
      cashOut: cashOut,
      debtPayoff: debtPayoff,
      currentPayment: currentPayment,
      newPayment: newPayment,
      monthlySavings: monthlySavings,
      annualSavings: round2(monthlySavings * 12),
      simpleBreakEvenMonths: simpleBreakEven,
      simpleBreakEvenDate: isFinite(simpleBreakEven) ? addMonths(start, simpleBreakEven - 1) : null,
      trueBreakEvenMonths: crossover,
      trueBreakEvenDate: crossover ? addMonths(start, crossover - 1) : null,

      // Primary measure: the month cumulative interest avoided repays the cost.
      interestBreakEvenMonths: interestCrossover,
      interestBreakEvenDate: interestCrossover ? addMonths(start, interestCrossover - 1) : null,
      interestSavedAtHorizon: (function () {
        var h = Math.min(series.length, Math.round(Math.max(0, num(opts.yearsInHome, 7)) * 12));
        return h > 0 ? series[h - 1].interestSaved : 0;
      })(),
      monthlyInterestSavedFirstMonth: round2(
        (currentSchedule.rows[0] ? currentSchedule.rows[0].interest : 0) -
        (newSchedule.rows[0] ? newSchedule.rows[0].interest : 0)
      ),
      lifetimeInterestSaved: lifetimeInterestSaved,
      currentTotalInterest: currentSchedule.totalInterest,
      newTotalInterest: newSchedule.totalInterest,
      currentTotalPaid: round2(currentSchedule.totalPaid),
      newTotalPaid: round2(newSchedule.totalPaid + cashAtClosing),
      termChangeMonths: newSchedule.months - currentSchedule.months,
      series: series,
      horizonMonths: horizonMonths,
      advantageAtHorizon: atHorizon ? atHorizon.advantage : 0,
      savingsInvestedValue: round2(fv),
      keepSameMonthsSaved: keepSame ? newSchedule.months - keepSame.months : 0,
      keepSameInterestSaved: keepSame ? round2(newSchedule.totalInterest - keepSame.totalInterest) : 0,
      blendedNote: newRate > curRate
        ? 'The new rate is higher than the current rate.'
        : null
    };
  }

  /* ------------------------------------------------------------------ *
   * Debt consolidation
   * ------------------------------------------------------------------ */

  /**
   * Summarize a list of consumer debts.
   *
   * debts = [{ creditor, balance, payment, rate }]
   *
   * `rate` is optional. When it is zero we treat the debt as interest-free and
   * the payoff is simply balance / payment. When the payment does not cover the
   * monthly interest the debt never retires — that is flagged rather than
   * silently turned into a huge number, because minimum credit-card payments
   * genuinely behave this way.
   */
  function summarizeDebts(debts) {
    var rows = [];
    var totalBalance = 0, totalMonthly = 0, totalInterest = 0;
    var weighted = 0, anyNeverPaysOff = false, longestMonths = 0;

    (debts || []).forEach(function (d) {
      if (!d) return;
      var balance = Math.max(0, num(d.balance));
      var pmt = Math.max(0, num(d.payment));
      var rate = Math.max(0, num(d.rate));
      if (balance <= 0 && pmt <= 0) return;

      var months = monthsToPayoff(balance, rate, pmt);
      var neverPaysOff = !isFinite(months);
      var interest = neverPaysOff ? Infinity : round2(pmt * months - balance);
      if (!neverPaysOff && months > longestMonths) longestMonths = months;
      if (neverPaysOff) anyNeverPaysOff = true;

      rows.push({
        creditor: d.creditor || 'Debt',
        balance: balance,
        payment: pmt,
        rate: rate,
        months: months,
        neverPaysOff: neverPaysOff,
        totalInterest: interest,
        // Share of the borrower's monthly debt service this line represents.
        paymentToBalance: balance > 0 ? round4((pmt / balance) * 100) : 0
      });

      totalBalance += balance;
      totalMonthly += pmt;
      if (isFinite(interest)) totalInterest += interest;
      weighted += balance * rate;
    });

    return {
      rows: rows,
      count: rows.length,
      totalBalance: round2(totalBalance),
      totalMonthly: round2(totalMonthly),
      totalInterest: anyNeverPaysOff ? Infinity : round2(totalInterest),
      blendedRate: totalBalance > 0 ? round4(weighted / totalBalance) : 0,
      anyNeverPaysOff: anyNeverPaysOff,
      longestMonths: longestMonths
    };
  }

  /**
   * Compare refinancing with and without folding consumer debt into the loan.
   *
   * Takes every option `analyzeRefinance` accepts plus `debts`. Runs the
   * refinance both ways and reports the monthly cash-flow difference — which is
   * what the borrower feels — alongside the lifetime interest consequence,
   * which usually points the other way and should not be buried.
   */
  function analyzeConsolidation(opts) {
    opts = opts || {};
    var debts = summarizeDebts(opts.debts);

    var without = analyzeRefinance(Object.assign({}, opts, { debtPayoff: 0 }));
    var withC = analyzeRefinance(Object.assign({}, opts, { debtPayoff: debts.totalBalance }));

    var currentMortgage = without.currentPayment;

    // Monthly outlay under each path (mortgage principal & interest plus any
    // consumer debt service that survives).
    var monthlyToday = round2(currentMortgage + debts.totalMonthly);
    var monthlyRefiOnly = round2(without.newPayment + debts.totalMonthly);
    var monthlyConsolidated = round2(withC.newPayment);

    // The extra mortgage interest created purely by carrying the debt balance
    // for the mortgage term.
    var interestOnConsolidatedDebt = round2(withC.newTotalInterest - without.newTotalInterest);

    return {
      debts: debts,
      withoutConsolidation: without,
      withConsolidation: withC,

      monthlyToday: monthlyToday,
      monthlyRefiOnly: monthlyRefiOnly,
      monthlyConsolidated: monthlyConsolidated,

      // Headline: what the borrower stops paying out each month.
      monthlySavingsConsolidated: round2(monthlyToday - monthlyConsolidated),
      monthlySavingsRefiOnly: round2(monthlyToday - monthlyRefiOnly),
      // The slice of the saving that consolidation itself contributes.
      monthlySavingsFromConsolidating: round2(monthlyRefiOnly - monthlyConsolidated),
      annualSavingsConsolidated: round2((monthlyToday - monthlyConsolidated) * 12),

      newPrincipalConsolidated: withC.newPrincipal,
      newPrincipalRefiOnly: without.newPrincipal,

      // Interest side of the ledger.
      interestIfDebtsKept: debts.totalInterest,
      interestOnConsolidatedDebt: interestOnConsolidatedDebt,
      lifetimeInterestDelta: isFinite(debts.totalInterest)
        ? round2(interestOnConsolidatedDebt - debts.totalInterest)
        : -Infinity,
      blendedRateBefore: blendedRate(currentMortgage, without, debts),
      newRate: num(opts.newRate)
    };
  }

  /**
   * Balance-weighted average rate across the mortgage and every consumer debt —
   * the number that shows why a 6% mortgage plus 24% cards is not a 6% problem.
   */
  function blendedRate(currentPayment, refi, debts) {
    var mortgageBalance = refi.currentSchedule.principal;
    var mortgageRate = refi.currentSchedule.annualRate;
    var total = mortgageBalance + debts.totalBalance;
    if (total <= 0) return 0;
    return round4((mortgageBalance * mortgageRate + debts.totalBalance * debts.blendedRate) / total);
  }

  /**
   * Discount-point buydown break-even: months until the payment savings
   * repay the cost of the points.
   */
  function analyzeBuydown(opts) {
    opts = opts || {};
    var principal = Math.max(0, num(opts.principal));
    var term = Math.max(1, Math.round(num(opts.termMonths)));
    var baseRate = num(opts.baseRate);
    var buyRate = num(opts.buydownRate);
    var costPct = Math.max(0, num(opts.pointsPct));
    var cost = round2(principal * costPct / 100);
    var basePmt = payment(principal, baseRate, term);
    var buyPmt = payment(principal, buyRate, term);
    var savings = round2(basePmt - buyPmt);
    var baseSched = buildSchedule({ principal: principal, annualRate: baseRate, termMonths: term });
    var buySched = buildSchedule({ principal: principal, annualRate: buyRate, termMonths: term });
    return {
      cost: cost,
      basePayment: basePmt,
      buydownPayment: buyPmt,
      monthlySavings: savings,
      breakEvenMonths: savings > 0 ? Math.ceil(cost / savings) : Infinity,
      lifetimeSavings: round2(baseSched.totalInterest - buySched.totalInterest - cost)
    };
  }

  /* ------------------------------------------------------------------ *
   * Derivation helpers used by the UI
   * ------------------------------------------------------------------ */

  /**
   * Reconstruct a live loan from its origination facts so the refinance tab
   * can be filled in from a borrower's closing docs instead of a statement.
   */
  function currentLoanFromOrigination(origAmount, rate, termMonths, startYM, asOfYM) {
    var elapsed = (asOfYM.year * 12 + asOfYM.month) - (startYM.year * 12 + startYM.month);
    elapsed = clampNum(elapsed, 0, termMonths);
    return {
      elapsedMonths: elapsed,
      remainingMonths: Math.max(0, termMonths - elapsed),
      balance: balanceAfter(origAmount, rate, termMonths, elapsed),
      payment: payment(origAmount, rate, termMonths)
    };
  }



  /* ------------------------------------------------------------------ *
   * Buy now vs. wait — the MBS Highway "Cost of Waiting" analysis
   * ------------------------------------------------------------------ */

  /**
   * What waiting costs: while a buyer waits, the price appreciates (a bigger
   * loan and down payment), the rate may move, and every month of waiting is
   * a month of appreciation and amortization someone else collects.
   *
   * opts = { price, downPct, rateNow, rateLater, termMonths,
   *          appreciationPct, waitMonths, start }
   */
  function analyzeCostOfWaiting(opts) {
    opts = opts || {};
    var price = num(opts.price);
    if (!(price > 0)) return { error: 'price' };
    var downPct = clampNum(num(opts.downPct), 0, 100);
    var rateNow = clampNum(num(opts.rateNow), 0, 30);
    var rateLater = clampNum(num(opts.rateLater), 0, 30);
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var apprPct = clampNum(num(opts.appreciationPct), -20, 20);
    var waitM = Math.round(clampNum(num(opts.waitMonths) || 12, 1, 120));

    var priceLater = price * Math.pow(1 + apprPct / 100, waitM / 12);
    var downNow = price * downPct / 100;
    var downLater = priceLater * downPct / 100;
    var loanNow = price - downNow;
    var loanLater = priceLater - downLater;
    var pmtNow = loanNow > 0 ? payment(loanNow, rateNow, termM) : 0;
    var pmtLater = loanLater > 0 ? payment(loanLater, rateLater, termM) : 0;

    // Equity the buy-now buyer holds by the end of the wait: the appreciation
    // plus the principal their payments retired.
    var appreciationGain = priceLater - price;
    var balAtWait = loanNow > 0 ? balanceAfter(loanNow, rateNow, termM, waitM) : 0;
    var amortizationGain = loanNow - balAtWait;

    // Month-by-month equity curve for the chart.
    var series = [];
    for (var m = 1; m <= waitM; m++) {
      var v = price * Math.pow(1 + apprPct / 100, m / 12);
      var b = loanNow > 0 ? balanceAfter(loanNow, rateNow, termM, m) : 0;
      series.push({
        m: m,
        homeValue: round2(v),
        equity: round2((v - price) + (loanNow - b) + downNow)
      });
    }

    var start = opts.start || todayYM();
    return {
      priceNow: round2(price), priceLater: round2(priceLater),
      priceIncrease: round2(priceLater - price),
      downNow: round2(downNow), downLater: round2(downLater),
      downIncrease: round2(downLater - downNow),
      loanNow: round2(loanNow), loanLater: round2(loanLater),
      paymentNow: pmtNow, paymentLater: pmtLater,
      paymentIncrease: round2(pmtLater - pmtNow),
      appreciationGain: round2(appreciationGain),
      amortizationGain: round2(amortizationGain),
      equityMissed: round2(appreciationGain + amortizationGain),
      // Payment delta carried across the full term is the long tail of waiting.
      lifetimePaymentCost: round2((pmtLater - pmtNow) * termM),
      waitMonths: waitM,
      buyDate: start,
      laterDate: addMonths(start, waitM),
      series: series
    };
  }

  /**
   * Bid over asking — how long appreciation takes to cover the premium, and
   * what the premium adds to the monthly payment.
   * opts = { askingPrice, bidPrice, appreciationPct, rate, termMonths, downPct }
   */
  function analyzeBidOverAsk(opts) {
    opts = opts || {};
    var ask = num(opts.askingPrice);
    var bid = num(opts.bidPrice);
    if (!(ask > 0) || !(bid > 0)) return { error: 'price' };
    var apprPct = clampNum(num(opts.appreciationPct), -20, 20);
    var rate = clampNum(num(opts.rate), 0, 30);
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var downPct = clampNum(num(opts.downPct), 0, 100);

    var premium = bid - ask;
    // The market value starts at the asking price and appreciates from there.
    var recoupMonth = null;
    var series = [];
    var horizon = 60;
    for (var m = 0; m <= horizon; m++) {
      var v = ask * Math.pow(1 + apprPct / 100, m / 12);
      if (recoupMonth === null && v >= bid) recoupMonth = m;
      series.push({ m: m, homeValue: round2(v) });
    }
    if (premium <= 0) recoupMonth = 0;

    var loanAsk = ask * (1 - downPct / 100);
    var loanBid = bid * (1 - downPct / 100);
    var pmtAsk = loanAsk > 0 ? payment(loanAsk, rate, termM) : 0;
    var pmtBid = loanBid > 0 ? payment(loanBid, rate, termM) : 0;

    return {
      premium: round2(premium),
      premiumCash: round2(premium * downPct / 100),
      premiumFinanced: round2(premium * (1 - downPct / 100)),
      paymentExtra: round2(pmtBid - pmtAsk),
      paymentExtraDaily: round2((pmtBid - pmtAsk) * 12 / 365),
      recoupMonth: recoupMonth,          // null: not within 5 years
      valueIn5: round2(ask * Math.pow(1 + apprPct / 100, 5)),
      equityIn5: round2(ask * Math.pow(1 + apprPct / 100, 5) - bid),
      series: series
    };
  }

  /**
   * How much home the income affords, under standard 28/36-style DTI caps.
   * The front-end cap limits total housing (PITI + HOA); the back-end cap
   * limits housing plus other monthly debts. The binding one wins.
   * opts = { annualIncome, monthlyDebts, downPayment, rate, termMonths,
   *          taxPct, insuranceYr, hoaMonthly, frontPct, backPct }
   */
  function affordability(opts) {
    opts = opts || {};
    var income = num(opts.annualIncome);
    if (!(income > 0)) return { error: 'income' };
    var moIncome = income / 12;
    var debts = Math.max(0, num(opts.monthlyDebts));
    var down = Math.max(0, num(opts.downPayment));
    var rate = clampNum(num(opts.rate), 0, 30);
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var taxPct = clampNum(num(opts.taxPct), 0, 10);
    var insuranceYr = Math.max(0, num(opts.insuranceYr));
    var hoa = Math.max(0, num(opts.hoaMonthly));
    var frontPct = clampNum(num(opts.frontPct) || 28, 5, 60);
    var backPct = clampNum(num(opts.backPct) || 36, 5, 70);

    var housingBudget = Math.min(moIncome * frontPct / 100,
      moIncome * backPct / 100 - debts);
    if (housingBudget <= hoa + insuranceYr / 12) {
      return { error: 'budget', housingBudget: round2(Math.max(0, housingBudget)) };
    }

    // Price -> housing cost is monotonic; bisect the price.
    var housingFor = function (price) {
      var loan = Math.max(0, price - down);
      var pi = loan > 0 ? payment(loan, rate, termM) : 0;
      return pi + price * taxPct / 100 / 12 + insuranceYr / 12 + hoa;
    };
    var lo = 0, hi = Math.max(down + 50000, 100000);
    var guard = 0;
    while (housingFor(hi) < housingBudget && guard++ < 30) hi *= 2;
    for (var i = 0; i < 60; i++) {
      var mid = (lo + hi) / 2;
      if (housingFor(mid) > housingBudget) hi = mid; else lo = mid;
    }
    var price = lo;
    var loan = Math.max(0, price - down);
    var pi = loan > 0 ? payment(loan, rate, termM) : 0;
    return {
      maxPrice: round2(price),
      loanAmount: round2(loan),
      payment: pi,
      housingBudget: round2(housingBudget),
      housing: round2(housingFor(price)),
      frontRatio: round2(housingFor(price) / moIncome * 100),
      backRatio: round2((housingFor(price) + debts) / moIncome * 100)
    };
  }

  /* ------------------------------------------------------------------ *
   * Rate structuring — buydowns, concessions, ARM vs. fixed
   * ------------------------------------------------------------------ */

  /**
   * Temporary buydown (3-2-1, 2-1, 1-0): the borrower pays as if the rate
   * were reduced during the early years; an escrowed subsidy (usually
   * seller-funded) covers the difference. The note itself amortizes at the
   * full rate the whole time, so the subsidy cost is exactly the sum of the
   * payment differences.
   * opts = { loanAmount, rate, termMonths, steps: [3,2,1] | [2,1] | [1] }
   */
  function analyzeTempBuydown(opts) {
    opts = opts || {};
    var loan = num(opts.loanAmount);
    if (!(loan > 0)) return { error: 'loan' };
    var rate = clampNum(num(opts.rate), 0, 30);
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var steps = (opts.steps && opts.steps.length ? opts.steps : [2, 1])
      .map(function (s) { return clampNum(num(s), 0, rate); });

    var fullPmt = payment(loan, rate, termM);
    var years = steps.map(function (reduction, i) {
      var r = Math.max(0, rate - reduction);
      var pmt = payment(loan, r, termM);
      return {
        year: i + 1,
        rate: round4(r),
        reduction: round4(reduction),
        payment: pmt,
        monthlySavings: round2(fullPmt - pmt),
        annualSavings: round2((fullPmt - pmt) * 12)
      };
    });
    var totalCost = round2(years.reduce(function (a, y) { return a + y.annualSavings; }, 0));
    return {
      fullPayment: fullPmt,
      years: years,
      afterYears: steps.length,
      totalCost: totalCost
    };
  }

  /**
   * The same seller credit, three ways: cut the price, buy the rate down
   * permanently, or fund a temporary buydown. Judged over the months the
   * buyer expects to keep the loan — on interest actually paid, consistent
   * with the rest of this calculator.
   * opts = { price, concession, downPct, rate, boughtRate, termMonths,
   *          horizonMonths, tempSteps }
   */
  function analyzeConcessionVsPriceCut(opts) {
    opts = opts || {};
    var price = num(opts.price);
    var concession = num(opts.concession);
    if (!(price > 0) || !(concession > 0)) return { error: 'inputs' };
    var downPct = clampNum(num(opts.downPct), 0, 100);
    var rate = clampNum(num(opts.rate), 0, 30);
    var boughtRate = clampNum(num(opts.boughtRate), 0, rate);
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var horizon = Math.round(clampNum(num(opts.horizonMonths) || 84, 12, termM));

    function interestOver(principal, r, m) {
      if (!(principal > 0)) return 0;
      var pmt = payment(principal, r, termM);
      var paid = Math.min(m, termM) * pmt;
      var bal = balanceAfter(principal, r, termM, Math.min(m, termM));
      return paid - (principal - bal);
    }

    // A: price cut — smaller loan at the full rate.
    var priceA = price - concession;
    var loanA = priceA * (1 - downPct / 100);
    var pmtA = payment(loanA, rate, termM);

    // B: permanent buydown — full price, credit pays points for a lower rate.
    var loanB = price * (1 - downPct / 100);
    var pmtB = payment(loanB, boughtRate, termM);

    // C: temporary 2-1 buydown — full price and rate, credit escrowed to
    // subsidise the first two years. Cost may differ from the concession.
    var temp = analyzeTempBuydown({
      loanAmount: loanB, rate: rate, termMonths: termM,
      steps: opts.tempSteps || [2, 1]
    });

    var horizonYears = horizon / 12;
    var subsidyUsed = 0;
    temp.years.forEach(function (y) {
      var frac = Math.min(1, Math.max(0, horizonYears - (y.year - 1)));
      subsidyUsed += y.annualSavings * frac;
    });

    return {
      concession: round2(concession),
      horizonMonths: horizon,
      priceCut: {
        loanAmount: round2(loanA), payment: pmtA,
        interestAtHorizon: round2(interestOver(loanA, rate, horizon)),
        downPayment: round2(priceA * downPct / 100),
        instantEquity: round2(concession)
      },
      permanent: {
        loanAmount: round2(loanB), payment: pmtB, rate: round4(boughtRate),
        interestAtHorizon: round2(interestOver(loanB, boughtRate, horizon))
      },
      temporary: {
        loanAmount: round2(loanB), fullPayment: temp.fullPayment,
        years: temp.years, totalCost: temp.totalCost,
        interestAtHorizon: round2(interestOver(loanB, rate, horizon)),
        subsidyUsedAtHorizon: round2(subsidyUsed),
        leftoverVsConcession: round2(concession - temp.totalCost)
      },
      basePayment: payment(loanB, rate, termM)
    };
  }

  /**
   * ARM vs. fixed, on the buyer's own rate expectation. The ARM holds its
   * intro rate for the fixed period, then re-amortizes the remaining balance
   * over the remaining term at the expected adjusted rate. Interest paid is
   * the comparison — consistent with the rest of this calculator — plus the
   * crossover month where the ARM's early savings are gone.
   * opts = { loanAmount, termMonths, fixedRate, armRate, armFixedMonths,
   *          armAdjustedRate, horizonMonths }
   */
  function analyzeArmVsFixed(opts) {
    opts = opts || {};
    var loan = num(opts.loanAmount);
    if (!(loan > 0)) return { error: 'loan' };
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var fixedRate = clampNum(num(opts.fixedRate), 0, 30);
    var armRate = clampNum(num(opts.armRate), 0, 30);
    var armFixedM = Math.round(clampNum(num(opts.armFixedMonths) || 60, 12, termM));
    var armAdjRate = clampNum(num(opts.armAdjustedRate), 0, 30);
    var horizon = Math.round(clampNum(num(opts.horizonMonths) || 84, 12, termM));

    var pmtFixed = payment(loan, fixedRate, termM);
    var pmtArm1 = payment(loan, armRate, termM);
    var balAtAdjust = balanceAfter(loan, armRate, termM, armFixedM);
    var pmtArm2 = termM > armFixedM
      ? payment(balAtAdjust, armAdjRate, termM - armFixedM) : 0;

    var mFixed = monthlyRate(fixedRate);
    var mArm1 = monthlyRate(armRate);
    var mArm2 = monthlyRate(armAdjRate);

    var balF = loan, balA = loan;
    var cumIntF = 0, cumIntA = 0;
    var crossoverMonth = null;
    var series = [];
    for (var m = 1; m <= horizon && m <= termM; m++) {
      if (balF > 0.005) {
        var iF = balF * mFixed;
        balF = Math.max(0, balF - (pmtFixed - iF));
        cumIntF += iF;
      }
      if (balA > 0.005) {
        var rA = m <= armFixedM ? mArm1 : mArm2;
        var pA = m <= armFixedM ? pmtArm1 : pmtArm2;
        var iA = balA * rA;
        balA = Math.max(0, balA - (pA - iA));
        cumIntA += iA;
      }
      if (crossoverMonth === null && m > armFixedM && cumIntA >= cumIntF) crossoverMonth = m;
      series.push({ m: m, fixedInterest: round2(cumIntF), armInterest: round2(cumIntA) });
    }

    return {
      paymentFixed: pmtFixed,
      paymentArmIntro: pmtArm1,
      paymentArmAfter: round2(pmtArm2),
      paymentJump: round2(pmtArm2 - pmtArm1),
      armFixedMonths: armFixedM,
      interestFixedAtHorizon: round2(cumIntF),
      interestArmAtHorizon: round2(cumIntA),
      interestSavedAtHorizon: round2(cumIntF - cumIntA),
      balanceFixedAtHorizon: round2(balF),
      balanceArmAtHorizon: round2(balA),
      crossoverMonth: crossoverMonth,
      series: series
    };
  }

  /* ------------------------------------------------------------------ *
   * Buy vs. rent
   * ------------------------------------------------------------------ */

  /**
   * Opportunity-cost comparison of buying a home against renting one —
   * the methodology behind the NYT rent-vs-buy calculator, which most
   * professional tools follow. Both paths start with the same cash (down
   * payment + buying costs): the buyer puts it into the home, the renter
   * invests it. Whichever path is cheaper in a given month invests the
   * difference too. Net wealth each month:
   *
   *   buyer  = home value − selling costs − loan balance + buyer side fund
   *   renter = investment fund + returned security deposit (one month rent)
   *
   * Costs linked to the home’s value (tax, insurance, maintenance) grow
   * with it; HOA dues grow at the rent-growth rate as an inflation proxy;
   * PMI applies under 20% down and cancels at 78% of the original value
   * (Homeowners Protection Act). Mortgage-interest tax deductions are NOT
   * modeled: since the 2018 standard-deduction increase most filers see no
   * benefit, and modeling one would overstate the case for buying.
   *
   * opts = {
   *   price, downPayment, rate, termMonths,
   *   buyClosingPct, sellClosingPct,
   *   taxPct, insuranceYr, hoaMonthly, maintPct, pmiRatePct,
   *   appreciationPct,
   *   rent, rentGrowthPct, rentersInsMo,
   *   investmentReturnPct, horizonMonths, start: {year, month}
   * }
   */
  function analyzeBuyVsRent(opts) {
    opts = opts || {};
    var price = num(opts.price);
    if (!(price > 0)) return { error: 'price' };
    var down = clampNum(num(opts.downPayment), 0, price);
    var rate = clampNum(num(opts.rate), 0, 30);
    var termM = Math.round(clampNum(num(opts.termMonths) || 360, 12, 600));
    var buyClosePct = clampNum(num(opts.buyClosingPct), 0, 20);
    var sellClosePct = clampNum(num(opts.sellClosingPct), 0, 20);
    var taxPct = clampNum(num(opts.taxPct), 0, 10);
    var insuranceYr = Math.max(0, num(opts.insuranceYr));
    var hoaMonthly = Math.max(0, num(opts.hoaMonthly));
    var maintPct = clampNum(num(opts.maintPct), 0, 10);
    var pmiRatePct = clampNum(num(opts.pmiRatePct), 0, 5);
    var apprPct = clampNum(num(opts.appreciationPct), -20, 20);
    var rent0 = Math.max(0, num(opts.rent));
    var rentGrowthPct = clampNum(num(opts.rentGrowthPct), -10, 20);
    var rentersInsMo = Math.max(0, num(opts.rentersInsMo));
    var investPct = clampNum(num(opts.investmentReturnPct), -20, 30);
    var horizon = Math.round(clampNum(num(opts.horizonMonths) || 84, 1, MAX_MONTHS));
    var months = Math.min(MAX_MONTHS, Math.max(360, horizon));

    var loan = round2(price - down);
    var pmt = loan > 0 ? payment(loan, rate, termM) : 0;
    if (loan > 0 && !(pmt > 0)) return { error: 'inputs' };

    var buyClose = round2(price * buyClosePct / 100);
    var initialCash = round2(down + buyClose);
    var mAppr = Math.pow(1 + apprPct / 100, 1 / 12) - 1;
    var mInv = Math.pow(1 + investPct / 100, 1 / 12) - 1;
    var mRate = monthlyRate(rate);
    var mRentGrow = Math.pow(1 + rentGrowthPct / 100, 1 / 12);
    // PMI: flat premium on the original loan, auto-cancelled at 78% LTV of
    // the original value, matching the servicer behaviour in buildSchedule.
    var pmiMo = (pmiRatePct > 0 && loan > 0 && down / price < 0.2)
      ? round2(loan * pmiRatePct / 100 / 12) : 0;
    var pmiStopBal = price * 0.78;

    /** One full simulation for a given starting rent. */
    function run(startRent, keepSeries) {
      var deposit = startRent; // security deposit: parked, returned at exit
      var homeValue = price, balance = loan, rent = startRent;
      var renterFund = Math.max(0, initialCash - deposit);
      var buyerFund = 0;
      var series = keepSeries ? [] : null;
      var breakEvenMonth = null;
      var cumOwn = 0, cumRent = 0;
      var atH = null;

      for (var m = 1; m <= months; m++) {
        homeValue *= 1 + mAppr;

        var interest = 0, principalPart = 0, pi = 0;
        if (balance > 0.005) {
          interest = balance * mRate;
          principalPart = Math.min(Math.max(pmt - interest, 0), balance);
          pi = interest + principalPart;
        }

        var pmiNow = (pmiMo > 0 && balance > pmiStopBal) ? pmiMo : 0;
        var scale = homeValue / price;
        var ownCost = pi +
          (homeValue * taxPct / 100) / 12 +
          (insuranceYr * scale) / 12 +
          hoaMonthly * Math.pow(mRentGrow, m - 1) +
          (homeValue * maintPct / 100) / 12 +
          pmiNow;
        var rentCost = rent + rentersInsMo;

        renterFund *= 1 + mInv;
        buyerFund *= 1 + mInv;
        var diff = ownCost - rentCost;
        if (diff > 0) renterFund += diff; else buyerFund += -diff;

        balance -= principalPart;
        if (balance < 0.005) balance = 0;
        cumOwn += ownCost;
        cumRent += rentCost;

        var buyerNet = homeValue * (1 - sellClosePct / 100) - balance + buyerFund;
        var renterNet = renterFund + deposit;
        if (breakEvenMonth === null && buyerNet >= renterNet) breakEvenMonth = m;

        if (keepSeries) {
          series.push({
            m: m, ownCost: round2(ownCost), rentCost: round2(rentCost),
            homeValue: round2(homeValue), balance: round2(balance),
            buyerNet: round2(buyerNet), renterNet: round2(renterNet),
            cumOwn: round2(cumOwn), cumRent: round2(cumRent)
          });
        }
        if (m === horizon) {
          atH = {
            buyerNet: round2(buyerNet), renterNet: round2(renterNet),
            advantage: round2(buyerNet - renterNet),
            homeValue: round2(homeValue), balance: round2(balance),
            equity: round2(homeValue - balance),
            sellingCost: round2(homeValue * sellClosePct / 100),
            buyerFund: round2(buyerFund), renterFund: round2(renterFund),
            deposit: round2(deposit),
            cumOwn: round2(cumOwn), cumRent: round2(cumRent)
          };
        }

        if (m % 12 === 0) rent *= Math.pow(mRentGrow, 12);
      }
      return { series: series, breakEvenMonth: breakEvenMonth, at: atH };
    }

    var main = run(rent0, true);

    // Equivalent rent: the starting rent at which, over the horizon, renting
    // and buying end up with the same net wealth — the NYT headline number.
    // Advantage-to-buying rises with rent, so bisection converges cleanly.
    var equivalentRent = null;
    if (run(0, false).at.advantage >= 0) {
      equivalentRent = 0; // buying wins even against free rent
    } else {
      var lo = 0, hi = 1000;
      var guard = 0;
      while (run(hi, false).at.advantage < 0 && guard++ < 12) hi *= 2;
      if (run(hi, false).at.advantage >= 0) {
        for (var i = 0; i < 50; i++) {
          var mid = (lo + hi) / 2;
          if (run(mid, false).at.advantage >= 0) hi = mid; else lo = mid;
        }
        equivalentRent = round2(hi);
      }
    }

    // Today’s monthly cost of each path, itemized from the starting values
    // (before any growth), for the side-by-side cost table.
    var firstMonth = {
      pi: round2(pmt),
      tax: round2(price * taxPct / 100 / 12),
      insurance: round2(insuranceYr / 12),
      hoa: round2(hoaMonthly),
      maintenance: round2(price * maintPct / 100 / 12),
      pmi: round2(pmiMo),
      rent: round2(rent0),
      rentersIns: round2(rentersInsMo)
    };
    firstMonth.ownTotal = round2(firstMonth.pi + firstMonth.tax + firstMonth.insurance +
      firstMonth.hoa + firstMonth.maintenance + firstMonth.pmi);
    firstMonth.rentTotal = round2(firstMonth.rent + firstMonth.rentersIns);

    var start = opts.start || todayYM();
    return {
      payment: pmt,
      loanAmount: loan,
      downPayment: round2(down),
      buyClose: buyClose,
      initialCash: initialCash,
      deposit: round2(rent0),
      pmiMonthly: pmiMo,
      horizonMonths: horizon,
      months: months,
      series: main.series,
      breakEvenMonth: main.breakEvenMonth,
      breakEvenDate: main.breakEvenMonth ? addMonths(start, main.breakEvenMonth - 1) : null,
      at: main.at,
      equivalentRent: equivalentRent,
      firstMonth: firstMonth
    };
  }

  return {
    MAX_MONTHS: MAX_MONTHS,
    round2: round2, round4: round4, cents: cents, dollars: dollars, num: num, clamp: clampNum,
    addMonths: addMonths, formatMonth: formatMonth, todayYM: todayYM, MONTH_NAMES: MONTH_NAMES,
    monthlyRate: monthlyRate,
    payment: payment,
    balanceAfter: balanceAfter,
    monthsToPayoff: monthsToPayoff,
    rateFromPayment: rateFromPayment,
    apr: apr,
    pmiMonthly: pmiMonthly,
    buildSchedule: buildSchedule,
    summarizeByYear: summarizeByYear,
    comparePrepayment: comparePrepayment,
    extraNeededForTerm: extraNeededForTerm,
    sensitivity: sensitivity,
    analyzeRefinance: analyzeRefinance,
    summarizeDebts: summarizeDebts,
    analyzeConsolidation: analyzeConsolidation,
    analyzeBuydown: analyzeBuydown,
    analyzeBuyVsRent: analyzeBuyVsRent,
    analyzeCostOfWaiting: analyzeCostOfWaiting,
    analyzeBidOverAsk: analyzeBidOverAsk,
    affordability: affordability,
    analyzeTempBuydown: analyzeTempBuydown,
    analyzeConcessionVsPriceCut: analyzeConcessionVsPriceCut,
    analyzeArmVsFixed: analyzeArmVsFixed,
    currentLoanFromOrigination: currentLoanFromOrigination
  };
});
