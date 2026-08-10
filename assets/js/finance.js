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
    var rollIn = !!opts.rollIntoLoan;

    // Points are quoted against the new loan amount, which itself depends on
    // whether costs are rolled in — solve the small circular reference directly.
    // L = balance + cashOut + roll * (flat + points% * L)
    var newPrincipal;
    if (rollIn) {
      var p = pointsPct / 100;
      newPrincipal = (balance + cashOut + flatCosts) / (1 - p);
    } else {
      newPrincipal = balance + cashOut;
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
      // Cash-out proceeds are money in the borrower's pocket, not a cost.
      var newCost = newPaid + newBal - cashOut;

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
    analyzeBuydown: analyzeBuydown,
    currentLoanFromOrigination: currentLoanFromOrigination
  };
});
