/*!
 * app.js — UI layer for the Gem Home Team mortgage calculator suite.
 * Depends on finance.js (math) and charts.js (rendering).
 */
(function () {
  'use strict';

  var F = window.Finance;
  var C = window.Charts;

  /* ==================================================================
   * Branding / contact configuration
   * Edit this block to point the calls-to-action at your real links.
   * ================================================================== */
  /*
   * IMPORTANT — licensing disclosures.
   *
   * The SAFE Act and most state regulators require the originator's and the
   * company's NMLS unique identifiers to appear on advertising and consumer-facing
   * tools, together with the licensing detail below. Fill every field in before
   * this page goes live, and have your compliance officer review the rendered
   * footer. Leaving a field blank simply omits that line — it does not make the
   * requirement go away.
   */
  var CONFIG = {
    quoteUrl: '#',                 // e.g. 'https://apply.neohomeloans.com/...'
    contactUrl: '#',               // e.g. 'tel:+15551234567' or a booking link

    loanOfficer: '',               // e.g. 'Jane Doe, Loan Officer'
    loanOfficerNmls: '',           // e.g. '123456'
    company: '',                   // legal entity name on the license
    companyNmls: '',               // e.g. '1015894'
    dba: '',                       // e.g. 'Gem Home Team is a DBA of ...'
    address: '',                   // licensed branch address
    phone: '',
    statesLicensed: '',            // e.g. 'Licensed in AZ, CA, NV and TX.'
    stateLicenseIds: '',           // e.g. 'AZ MB-0123456 · CA DFPI 60DBO-98765'
    consumerAccessUrl: 'https://www.nmlsconsumeraccess.org/',
    extraDisclosures: ''           // any additional state-required language
  };

  /* ==================================================================
   * Formatting
   * ================================================================== */
  var money0 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });
  var money2 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  var num0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /**
   * SVG presentation attributes (stroke, fill) do NOT understand var(), so
   * every colour handed to charts.js is resolved to a concrete value first.
   * Cleared whenever the theme flips.
   */
  var _colorCache = {};
  function cssVar(name) {
    if (_colorCache[name] !== undefined) return _colorCache[name];
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return (_colorCache[name] = v || '#7d90a4');
  }
  function clearColorCache() { _colorCache = {}; }

  function fmt$(v) { return money0.format(Math.round(v || 0)); }
  function fmt$2(v) { return money2.format(v || 0); }
  function fmtPct(v, dp) { return (v || 0).toFixed(dp === undefined ? 1 : dp) + '%'; }

  /** "$1,896" + a smaller ".20" so the headline number reads cleanly. */
  function splitCurrency(v) {
    var n = Math.abs(v || 0);
    var whole = Math.floor(n);
    var cts = Math.round((n - whole) * 100);
    if (cts === 100) { whole += 1; cts = 0; }
    return (v < 0 ? '-' : '') + money0.format(whole) +
      '<span class="cents">.' + String(cts).padStart(2, '0') + '</span>';
  }

  /** "24 yrs 7 mos" — the phrasing people actually use for a payoff timeline. */
  function fmtDuration(months) {
    months = Math.max(0, Math.round(months || 0));
    var y = Math.floor(months / 12), m = months % 12;
    if (y === 0) return m + (m === 1 ? ' month' : ' months');
    if (m === 0) return y + (y === 1 ? ' year' : ' years');
    return y + ' yr' + (y === 1 ? '' : 's') + ' ' + m + ' mo' + (m === 1 ? '' : 's');
  }

  function ymLabel(ym) { return ym ? F.formatMonth(ym) : '—'; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ==================================================================
   * Input helpers — text fields that accept "450,000", "$450k", "450000"
   * ================================================================== */
  function parseNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v == null ? '' : v).trim().toLowerCase().replace(/[$,\s]/g, '');
    var mult = 1;
    if (/k$/.test(s)) { mult = 1e3; s = s.slice(0, -1); }
    else if (/m$/.test(s)) { mult = 1e6; s = s.slice(0, -1); }
    var n = parseFloat(s);
    return isFinite(n) ? n * mult : 0;
  }

  function val(id) { return parseNum($(id) ? $(id).value : 0); }

  function setVal(id, v, decimals) {
    var elx = $(id);
    if (!elx) return;
    var n = Number(v) || 0;
    elx.value = decimals ? n.toFixed(decimals) : num0.format(Math.round(n));
  }

  /** Re-format a currency field on blur without fighting the user mid-type. */
  function attachCurrencyFormatting(input) {
    input.addEventListener('blur', function () {
      var n = parseNum(input.value);
      if (input.value.trim() === '') return;
      input.value = num0.format(Math.round(n * 100) / 100);
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ==================================================================
   * Shared state
   * ================================================================== */
  var state = {
    schedView: 'annual',
    accelView: 'annual',
    sideView: 'annual',
    taxMode: 'amount',
    curMode: 'balance',
    oneTime: [],
    debts: [],
    sideTouched: false,
    activeTab: 'payment'
  };

  var cache = {};   // last computed results, shared across tabs

  /* ==================================================================
   * Reading the loan configuration from the Payment tab
   * ================================================================== */
  function termMonths() {
    var sel = $('loanTerm').value;
    return sel === 'custom' ? Math.max(1, Math.round(val('customTermMonths'))) : parseInt(sel, 10);
  }

  function annualTax() {
    var v = val('propertyTax');
    return state.taxMode === 'percent' ? val('homePrice') * (v / 100) : v;
  }

  function loanConfig() {
    return {
      principal: val('loanAmount'),
      annualRate: val('interestRate'),
      termMonths: termMonths(),
      start: { year: Math.round(val('startYear')), month: parseInt($('startMonth').value, 10) },
      propertyValue: val('homePrice'),
      appreciationPct: val('appreciation'),
      pmi: {
        enabled: $('pmiEnabled').getAttribute('aria-checked') === 'true',
        ratePct: val('pmiRate'),
        cancelLtv: parseNum($('pmiCancel').value)
      },
      escrow: {
        taxAnnual: annualTax(),
        insuranceAnnual: val('homeInsurance'),
        hoaMonthly: val('hoaMonthly'),
        otherMonthly: val('otherMonthly'),
        inflationPct: val('escrowInflation')
      }
    };
  }

  function extrasConfig() {
    return {
      monthly: val('extraMonthly'),
      startMonth: Math.max(1, Math.round(val('extraStartMonth')) || 1),
      biweekly: $('biweekly').getAttribute('aria-checked') === 'true',
      annual: val('extraAnnual'),
      annualMonth: parseInt($('extraAnnualMonth').value, 10) + 1,
      roundUpTo: parseNum($('roundUpTo').value),
      oneTime: state.oneTime.map(function (o) {
        return { amount: parseNum(o.amount), year: o.year, month: o.month };
      })
    };
  }

  function hasExtras(e) {
    return e.monthly > 0 || e.biweekly || e.annual > 0 || e.roundUpTo > 0 ||
      e.oneTime.some(function (o) { return o.amount > 0; });
  }

  /* ==================================================================
   * Error rendering
   * ================================================================== */
  var ERRORS = {
    'no-principal': 'Enter a loan amount greater than zero to see a schedule.',
    'no-term': 'Enter a loan term greater than zero.',
    'negative-amortization': 'That payment is smaller than the first month\'s interest, so the balance would grow instead of shrink. Increase the payment or lower the rate.',
    'no-payoff': 'These numbers never pay the loan off. Check the rate and payment amount.'
  };

  function showError(containerId, code) {
    var box = $(containerId);
    if (!box) return false;
    if (!code) { box.innerHTML = ''; return false; }
    box.innerHTML = '<div class="callout is-bad mt-0" style="margin-bottom:18px">' +
      '<svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.5"/></svg>' +
      '<div>' + esc(ERRORS[code] || 'Something in these inputs doesn\'t work. Please review them.') + '</div></div>';
    return true;
  }

  /* ==================================================================
   * TAB 1 — Payment & Schedule
   * ================================================================== */
  function renderPayment() {
    var cfg = loanConfig();
    var s = F.buildSchedule(cfg);
    cache.base = s;
    cache.cfg = cfg;

    if (showError('paymentError', s.error)) return;

    var first = s.rows[0];
    var pi = s.basePayment;
    var tax = first.tax, ins = first.insurance, hoa = first.hoa,
        other = first.other, pmi = first.pmi;
    var total = pi + tax + ins + hoa + other + pmi;

    $('totalMonthly').innerHTML = splitCurrency(total);
    $('paymentCaption').textContent = pmi > 0
      ? 'Principal, interest, taxes, insurance and PMI'
      : (tax + ins + hoa + other > 0
        ? 'Principal, interest, taxes and insurance'
        : 'Principal and interest');

    // --- Donut + breakdown -------------------------------------------
    var segs = [
      { label: 'Principal & interest', value: pi, color: cssVar('--c-principal') },
      { label: 'Property tax', value: tax, color: cssVar('--c-tax') },
      { label: 'Homeowners insurance', value: ins, color: cssVar('--c-insurance') },
      { label: 'Mortgage insurance', value: pmi, color: cssVar('--c-pmi') },
      { label: 'HOA dues', value: hoa, color: cssVar('--c-hoa') },
      { label: 'Other', value: other, color: cssVar('--slate-500') }
    ];
    C.donut($('donutChart'), {
      segments: segs, size: 232, thickness: 34,
      centerValue: fmt$(total), centerLabel: 'per month',
      ariaLabel: 'Monthly payment breakdown'
    });

    $('paymentBreakdown').innerHTML = segs.filter(function (x) { return x.value > 0; })
      .map(function (x) {
        return '<div class="breakdown-row">' +
          '<span class="breakdown-swatch" style="background:' + x.color + '"></span>' +
          '<span class="breakdown-label">' + x.label + '</span>' +
          '<span class="breakdown-value">' + fmt$2(x.value) + '</span></div>';
      }).join('') +
      '<div class="breakdown-row is-total"><span></span>' +
      '<span class="breakdown-label">Total monthly payment</span>' +
      '<span class="breakdown-value">' + fmt$2(total) + '</span></div>';

    // --- Summary stats -------------------------------------------------
    var stats = [
      { label: 'Payoff date', value: ymLabel(s.payoff), sub: fmtDuration(s.months), hero: true },
      { label: 'Total interest', value: fmt$(s.totalInterest),
        sub: fmtPct(s.interestSharePct, 0) + ' of the amount borrowed' },
      { label: 'Total of payments', value: fmt$(s.totalPaid), sub: 'Principal + interest' },
      { label: 'Total cost of ownership', value: fmt$(s.totalOutOfPocket),
        sub: 'Including taxes, insurance & fees' }
    ];
    if (s.totalPmi > 0) {
      stats.push({
        label: 'Mortgage insurance', value: fmt$(s.totalPmi),
        sub: 'Drops off ' + ymLabel(s.pmiEndDate), cls: 'is-warn'
      });
    }
    // Regulation Z: a stated interest rate invites an APR comparison. Show it
    // whenever the borrower has told us what the cost of credit is.
    var financeCharges = val('loanCosts');
    if (financeCharges > 0) {
      var aprPct = F.apr(cfg.principal, financeCharges, cfg.annualRate, cfg.termMonths);
      stats.push({
        label: 'Estimated APR', value: fmtPct(aprPct, 3),
        sub: 'Note rate ' + fmtPct(cfg.annualRate, 3) + ' plus ' + fmt$(financeCharges) + ' in finance charges',
        tip: 'Estimated under Regulation Z (12 CFR 1026.22). Your official APR appears on the Loan Estimate and may differ.'
      });
    }
    stats.push({
      label: 'First payment split', value: fmt$(first.principal) + ' principal',
      sub: fmt$(first.interest) + ' of your first payment is interest'
    });
    $('loanStats').innerHTML = stats.map(statHTML).join('');

    renderBalanceChart(s);
    renderSplitChart(s);
    renderMilestones(s, cfg);
    renderSchedule(s);

    $('scheduleSub').textContent = s.months + ' payments · ' +
      ymLabel(s.rows[0].ym) + ' through ' + ymLabel(s.payoff);
  }

  function statHTML(st) {
    return '<div class="stat ' + (st.hero ? 'is-hero ' : '') + (st.cls || '') + '">' +
      '<div class="stat-label">' + esc(st.label) +
      (st.tip ? ' <button class="info" type="button" tabindex="0" data-tip="' + esc(st.tip) + '">i</button>' : '') +
      '</div>' +
      '<div class="stat-value">' + st.value + '</div>' +
      (st.sub ? '<div class="stat-sub">' + st.sub + '</div>' : '') +
      '</div>';
  }

  /** Sample a monthly schedule down to one point per year for charting. */
  function yearlySamples(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i += 12) out.push(rows[i]);
    if (rows.length && (rows.length - 1) % 12 !== 0) out.push(rows[rows.length - 1]);
    return out;
  }

  function renderBalanceChart(s) {
    var pts = yearlySamples(s.rows);
    var labels = pts.map(function (r) { return r.year; });
    C.area($('balanceChart'), {
      height: 320,
      labels: labels,
      series: [
        { label: 'Loan balance', color: cssVar('--c-balance'), data: pts.map(function (r) { return r.balance; }), fill: true },
        { label: 'Home equity', color: cssVar('--c-equity'), data: pts.map(function (r) { return Math.max(0, r.equity); }), fill: true },
        { label: 'Interest paid to date', color: cssVar('--c-pmi'), data: pts.map(function (r) { return r.cumInterest; }), dashed: true }
      ],
      markers: s.pmiEndMonth && s.totalPmi > 0
        ? [{ index: Math.floor((s.pmiEndMonth - 1) / 12), label: 'PMI ends', color: cssVar('--amber-500') }]
        : [],
      ariaLabel: 'Loan balance, equity and cumulative interest by year'
    });
    C.legend($('balanceLegend'), [
      { label: 'Loan balance', color: cssVar('--c-balance') },
      { label: 'Home equity', color: cssVar('--c-equity') },
      { label: 'Interest paid to date', color: cssVar('--c-pmi') }
    ]);
  }

  function renderSplitChart(s) {
    var yrs = s.years;
    C.bars($('splitChart'), {
      height: 290, stacked: true,
      labels: yrs.map(function (y) { return y.year; }),
      series: [
        { label: 'Principal', color: cssVar('--c-principal'), data: yrs.map(function (y) { return y.principal; }) },
        { label: 'Interest', color: cssVar('--c-interest'), data: yrs.map(function (y) { return y.interest; }) }
      ],
      ariaLabel: 'Principal versus interest paid each year'
    });
    C.legend($('splitLegend'), [
      { label: 'Principal', color: cssVar('--c-principal') },
      { label: 'Interest', color: cssVar('--c-interest') }
    ]);
  }

  function renderMilestones(s, cfg) {
    var items = [];
    var rows = s.rows;

    // The month the principal portion finally exceeds the interest portion.
    var flip = rows.findIndex(function (r) { return r.principal > r.interest; });
    if (flip > 0) {
      items.push({
        icon: 'swap', title: 'Principal overtakes interest',
        sub: 'More of your payment starts building equity than paying the bank',
        when: ymLabel(rows[flip].ym), n: flip + 1
      });
    }

    if (cfg.propertyValue > 0) {
      var eq20 = rows.findIndex(function (r) { return r.ltv <= 80; });
      if (eq20 >= 0) {
        items.push({
          icon: 'shield', title: '20% equity reached',
          sub: 'Balance falls to 80% of the original value',
          when: ymLabel(rows[eq20].ym), n: eq20 + 1
        });
      }
    }

    if (s.totalPmi > 0 && s.pmiEndDate) {
      items.push({
        icon: 'check', title: 'Mortgage insurance drops off',
        sub: 'Your payment falls by ' + fmt$2(rows[0].pmi) + ' a month',
        when: ymLabel(s.pmiEndDate), n: s.pmiEndMonth
      });
    }

    var half = rows.findIndex(function (r) { return r.balance <= s.principal / 2; });
    if (half >= 0) {
      items.push({
        icon: 'half', title: 'Halfway paid off',
        sub: 'Balance drops below ' + fmt$(s.principal / 2),
        when: ymLabel(rows[half].ym), n: half + 1
      });
    }

    items.push({
      icon: 'flag', title: 'Loan paid in full',
      sub: 'After ' + s.months + ' payments and ' + fmt$(s.totalInterest) + ' of interest',
      when: ymLabel(s.payoff), n: s.months
    });

    items.sort(function (a, b) { return a.n - b.n; });

    var ICONS = {
      swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>',
      shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      half: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 010 18z" fill="currentColor" stroke="none"/></svg>',
      flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>'
    };

    $('milestones').innerHTML = items.map(function (it) {
      return '<div class="milestone">' +
        '<div class="milestone-dot">' + (ICONS[it.icon] || '') + '</div>' +
        '<div><div class="milestone-title">' + esc(it.title) + '</div>' +
        '<div class="milestone-sub">' + it.sub + '</div></div>' +
        '<div class="milestone-when">' + it.when + '<div class="milestone-sub">payment ' + it.n + '</div></div>' +
        '</div>';
    }).join('');
  }

  /* ---------- Amortization tables ---------- */

  function scheduleTableHTML(s, view, opts) {
    opts = opts || {};
    var showExtra = s.totalExtra > 0;
    var showPmi = s.totalPmi > 0;
    var showEscrow = s.totalEscrow > 0;

    var head = '<tr><th>' + (view === 'annual' ? 'Year' : 'Payment') + '</th>' +
      (view === 'annual' ? '' : '<th>Date</th>') +
      '<th>Payment</th><th>Principal</th><th>Interest</th>' +
      (showExtra ? '<th>Extra</th>' : '') +
      (showPmi ? '<th>PMI</th>' : '') +
      (showEscrow ? '<th>Tax &amp; ins.</th>' : '') +
      '<th>Interest to date</th><th>Balance</th></tr>';

    var body;
    if (view === 'annual') {
      body = s.years.map(function (y, i) {
        var pmiDrop = s.pmiEndMonth && y.rows.some(function (r) { return r.n === s.pmiEndMonth; });
        return '<tr class="' + (i === s.years.length - 1 ? 'is-payoff' : '') +
          (pmiDrop ? ' is-pmi-drop' : '') + '">' +
          '<td><strong>' + y.year + '</strong></td>' +
          '<td>' + fmt$(y.payment + y.extra) + '</td>' +
          '<td class="num-principal">' + fmt$(y.principal - y.extra) + '</td>' +
          '<td class="num-interest">' + fmt$(y.interest) + '</td>' +
          (showExtra ? '<td class="num-extra">' + (y.extra > 0 ? fmt$(y.extra) : '—') + '</td>' : '') +
          (showPmi ? '<td class="muted">' + (y.pmi > 0 ? fmt$(y.pmi) : '—') + '</td>' : '') +
          (showEscrow ? '<td class="muted">' + fmt$(y.escrow) + '</td>' : '') +
          '<td class="muted">' + fmt$(y.rows[y.rows.length - 1].cumInterest) + '</td>' +
          '<td class="num-balance">' + fmt$(y.balance) + '</td></tr>';
      }).join('');
    } else {
      body = s.rows.map(function (r) {
        var cls = [];
        if (r.n === s.months) cls.push('is-payoff');
        if (r.n === s.pmiEndMonth) cls.push('is-pmi-drop');
        if ((r.n - 1) % 12 === 0 && r.n > 1) cls.push('is-year-start');
        return '<tr class="' + cls.join(' ') + '">' +
          '<td>' + r.n + '</td><td>' + r.date + '</td>' +
          '<td>' + fmt$2(r.payment + r.extra) + '</td>' +
          '<td class="num-principal">' + fmt$2(r.principal) + '</td>' +
          '<td class="num-interest">' + fmt$2(r.interest) + '</td>' +
          (showExtra ? '<td class="num-extra">' + (r.extra > 0 ? fmt$2(r.extra) : '—') + '</td>' : '') +
          (showPmi ? '<td class="muted">' + (r.pmi > 0 ? fmt$2(r.pmi) : '—') + '</td>' : '') +
          (showEscrow ? '<td class="muted">' + fmt$2(r.escrow) + '</td>' : '') +
          '<td class="muted">' + fmt$(r.cumInterest) + '</td>' +
          '<td class="num-balance">' + fmt$2(r.balance) + '</td></tr>';
      }).join('');
    }

    var colCount = 5 + (view === 'annual' ? 0 : 1) +
      (showExtra ? 1 : 0) + (showPmi ? 1 : 0) + (showEscrow ? 1 : 0) + 1;

    var foot = '<tr><td>Totals</td>' + (view === 'annual' ? '' : '<td></td>') +
      '<td>' + fmt$(s.totalPaid) + '</td>' +
      '<td>' + fmt$(s.principal) + '</td>' +
      '<td>' + fmt$(s.totalInterest) + '</td>' +
      (showExtra ? '<td>' + fmt$(s.totalExtra) + '</td>' : '') +
      (showPmi ? '<td>' + fmt$(s.totalPmi) + '</td>' : '') +
      (showEscrow ? '<td>' + fmt$(s.totalEscrow) + '</td>' : '') +
      '<td></td><td>' + fmt$(0) + '</td></tr>';

    return '<table class="data"><thead>' + head + '</thead><tbody>' + body +
      '</tbody><tfoot>' + foot + '</tfoot></table>';
  }

  function renderSchedule(s) {
    $('scheduleWrap').innerHTML = scheduleTableHTML(s, state.schedView);
  }

  /* ==================================================================
   * TAB 2 — Extra payments
   * ================================================================== */
  function renderExtra() {
    var cfg = loanConfig();
    var extras = extrasConfig();
    var cmp = F.comparePrepayment(cfg, extras);
    cache.compare = cmp;

    if (showError('extraError', cmp.accelerated.error || cmp.base.error)) return;

    var any = hasExtras(extras);
    var accel = cmp.accelerated, base = cmp.base;

    var stats = [
      {
        label: 'New payoff date', value: ymLabel(accel.payoff),
        sub: any ? 'Instead of ' + ymLabel(base.payoff) : 'No extra payments yet', hero: true
      },
      {
        label: 'Time saved', value: cmp.monthsSaved > 0 ? fmtDuration(cmp.monthsSaved) : '—',
        sub: cmp.monthsSaved > 0 ? cmp.monthsSaved + ' fewer payments' : 'Add an extra payment above',
        cls: cmp.monthsSaved > 0 ? 'is-good' : ''
      },
      {
        label: 'Interest saved', value: fmt$(cmp.interestSaved),
        sub: fmt$(base.totalInterest) + ' → ' + fmt$(accel.totalInterest),
        cls: cmp.interestSaved > 0 ? 'is-good' : ''
      },
      {
        label: 'Extra principal paid', value: fmt$(accel.totalExtra),
        sub: cmp.returnPerDollar > 0
          ? 'Every $1 extra saves ' + fmt$2(cmp.returnPerDollar) + ' in interest'
          : 'Over the life of the loan'
      }
    ];
    if (cmp.pmiSaved > 0) {
      stats.push({
        label: 'PMI saved', value: fmt$(cmp.pmiSaved),
        sub: 'Insurance drops ' + ymLabel(accel.pmiEndDate) + ' instead of ' + ymLabel(base.pmiEndDate),
        cls: 'is-good'
      });
    }
    stats.push({
      label: 'Total saved', value: fmt$(cmp.totalSaved),
      sub: 'Interest + mortgage insurance', cls: cmp.totalSaved > 0 ? 'is-good' : ''
    });
    $('savingsStats').innerHTML = stats.map(statHTML).join('');

    // --- Race chart ----------------------------------------------------
    var basePts = yearlySamples(base.rows);
    var accelPts = yearlySamples(accel.rows);
    var labels = basePts.map(function (r) { return r.year; });
    var accelData = labels.map(function (_, i) {
      return i < accelPts.length ? accelPts[i].balance : 0;
    });
    C.area($('prepayChart'), {
      height: 320, labels: labels,
      series: [
        { label: 'Minimum payment', color: cssVar('--c-interest'), data: basePts.map(function (r) { return r.balance; }), fill: true },
        { label: 'With extra payments', color: cssVar('--c-accel'), data: accelData, fill: true }
      ],
      markers: cmp.monthsSaved > 0
        ? [{ index: Math.floor((accel.months - 1) / 12), label: 'Paid off ' + fmtDuration(cmp.monthsSaved) + ' early', color: cssVar('--green-600') }]
        : [],
      ariaLabel: 'Loan balance with and without extra payments'
    });
    C.legend($('prepayLegend'), [
      { label: 'Minimum payment only', color: cssVar('--c-interest') },
      { label: 'With your extra payments', color: cssVar('--c-accel') }
    ]);

    // --- Sensitivity ladder --------------------------------------------
    var ladder = F.sensitivity(cfg, [50, 100, 200, 300, 500, 1000]);
    $('sensitivityWrap').innerHTML =
      '<table class="data"><thead><tr>' +
      '<th>Extra per month</th><th>New payment</th><th>Payoff date</th>' +
      '<th>Time saved</th><th>Total interest</th><th>Interest saved</th></tr></thead><tbody>' +
      ladder.map(function (row) {
        var isCurrent = Math.abs(row.extra - extras.monthly) < 0.5;
        return '<tr' + (isCurrent ? ' class="is-pmi-drop"' : '') + '>' +
          '<td><strong>' + fmt$(row.extra) + '</strong>' +
          (isCurrent ? ' <span class="chip is-cyan">yours</span>' : '') + '</td>' +
          '<td>' + fmt$2(row.newPayment) + '</td>' +
          '<td>' + ymLabel(row.payoff) + '</td>' +
          '<td class="text-good">' + fmtDuration(row.monthsSaved) + '</td>' +
          '<td class="muted">' + fmt$(row.totalInterest) + '</td>' +
          '<td class="text-good"><strong>' + fmt$(row.interestSaved) + '</strong></td></tr>';
      }).join('') + '</tbody></table>';

    // --- Accelerated schedule -------------------------------------------
    $('accelScheduleWrap').innerHTML = scheduleTableHTML(accel, state.accelView);
    $('accelScheduleSub').textContent = accel.months + ' payments · ' +
      ymLabel(accel.rows[0].ym) + ' through ' + ymLabel(accel.payoff);
  }

  /* ---------- Goal seek ---------- */
  function runGoalSeek() {
    var cfg = loanConfig();
    var years = Math.max(1, val('goalYears'));
    var target = Math.round(years * 12);
    var seed = extrasConfig();
    var res = F.extraNeededForTerm(cfg, target, {
      biweekly: seed.biweekly, annual: seed.annual, annualMonth: seed.annualMonth,
      oneTime: seed.oneTime, roundUpTo: seed.roundUpTo
    });
    var box = $('goalResult');

    if (!res.achievable || res.schedule.error) {
      box.innerHTML = '<div class="callout is-bad">Those inputs can\'t reach that goal. Check the loan details.</div>';
      return;
    }
    if (res.extra <= 0) {
      box.innerHTML = '<div class="callout is-good">Your current plan already pays the loan off in ' +
        fmtDuration(res.schedule.months) + '.</div>';
      return;
    }

    var base = F.buildSchedule(Object.assign({}, cfg, { extras: null }));
    box.innerHTML =
      '<div class="callout is-info" style="flex-direction:column;gap:10px">' +
      '<div>To be free and clear in <strong>' + years + ' years</strong>, add</div>' +
      '<div style="font-size:28px;font-weight:800;letter-spacing:-.03em">' + fmt$2(res.extra) + '<span style="font-size:14px;font-weight:600;opacity:.7"> / month</span></div>' +
      '<div>New payment: <strong>' + fmt$2(base.basePayment + res.extra) + '</strong> &nbsp;·&nbsp; ' +
      'Interest saved: <strong>' + fmt$(base.totalInterest - res.schedule.totalInterest) + '</strong></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-sm btn-block mt-12" id="btnApplyGoal">Apply this to my plan</button>';

    $('btnApplyGoal').addEventListener('click', function () {
      $('extraMonthly').value = num0.format(Math.ceil(res.extra));
      $('extraMonthlyRange').value = Math.min(2000, Math.ceil(res.extra));
      recalcAll();
    });
  }

  /* ---------- One-time payments ---------- */
  function renderOneTimeList() {
    var list = $('oneTimeList');
    if (!state.oneTime.length) {
      list.innerHTML = '<p class="hint mb-0" style="margin-bottom:10px">No lump sums yet — a bonus or tax refund applied straight to principal has an outsized effect early in the loan.</p>';
      return;
    }
    list.innerHTML = state.oneTime.map(function (o, i) {
      return '<div class="onetime-item">' +
        '<div class="input-wrap"><span class="affix affix-left">$</span>' +
        '<input type="text" inputmode="decimal" class="has-affix-left" data-ot="amount" data-i="' + i + '" value="' + esc(o.amount) + '"></div>' +
        '<div class="field-row" style="gap:6px">' +
        '<select data-ot="month" data-i="' + i + '">' + monthOptions(o.month) + '</select>' +
        '<input type="text" inputmode="numeric" data-ot="year" data-i="' + i + '" value="' + o.year + '">' +
        '</div>' +
        '<button class="remove-btn" type="button" data-ot="remove" data-i="' + i + '" aria-label="Remove this lump sum">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button></div>';
    }).join('');
  }

  function monthOptions(selected) {
    return F.MONTH_NAMES.map(function (m, i) {
      return '<option value="' + i + '"' + (i === selected ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
  }

  /* ==================================================================
   * TAB 3 — Side by side: minimum payment vs. a payment you choose
   * ================================================================== */
  function renderSide() {
    var cfg = loanConfig();
    var base = F.buildSchedule(Object.assign({}, cfg, { extras: null }));
    if (showError('sideError', base.error)) return;

    var minPay = base.basePayment;

    // Seed the field with something meaningful the first time through.
    if (!state.sideTouched) {
      var seed = Math.ceil((minPay + 200) / 10) * 10;
      $('sidePayment').value = num0.format(seed);
    }

    var chosen = val('sidePayment');
    var clamped = false;
    if (chosen < minPay) { chosen = minPay; clamped = true; }

    var extra = Math.max(0, chosen - minPay);
    var accel = F.buildSchedule(Object.assign({}, cfg, { extras: { monthly: extra } }));

    $('sideHint').innerHTML = clamped
      ? '<span class="text-bad">' + fmt$2(val('sidePayment')) + ' is below the required payment of ' +
        fmt$2(minPay) + ', so we\'re comparing at the minimum.</span>'
      : 'Minimum principal &amp; interest is <strong>' + fmt$2(minPay) + '</strong>. ' +
        'You entered <strong>' + fmt$2(chosen) + '</strong>, which sends <strong>' + fmt$2(extra) +
        '</strong> a month straight to principal.';

    cache.side = { base: base, accel: accel, extra: extra, chosen: chosen, minPay: minPay };

    // --- Column headers -------------------------------------------------
    $('sideHeads').innerHTML =
      '<div class="compare-col"><div class="compare-head is-base">' +
      '<div class="ch-title">Minimum payment</div>' +
      '<div class="ch-value">' + fmt$2(minPay) + '</div>' +
      '<div class="ch-sub">Paid off ' + ymLabel(base.payoff) + ' · ' + fmtDuration(base.months) + '</div>' +
      '</div></div>' +
      '<div class="compare-col"><div class="compare-head is-accel">' +
      '<div class="ch-title">Your payment</div>' +
      '<div class="ch-value">' + fmt$2(chosen) + '</div>' +
      '<div class="ch-sub">Paid off ' + ymLabel(accel.payoff) + ' · ' + fmtDuration(accel.months) + '</div>' +
      '</div></div>';

    // --- Deltas ----------------------------------------------------------
    var monthsSaved = base.months - accel.months;
    var interestSaved = base.totalInterest - accel.totalInterest;
    $('sideStats').innerHTML = [
      { label: 'Extra per month', value: fmt$2(extra), sub: 'On top of the minimum' },
      {
        label: 'Paid off earlier by', value: monthsSaved > 0 ? fmtDuration(monthsSaved) : '—',
        sub: base.months + ' → ' + accel.months + ' payments', cls: monthsSaved > 0 ? 'is-good' : ''
      },
      {
        label: 'Interest saved', value: fmt$(interestSaved),
        sub: fmt$(base.totalInterest) + ' → ' + fmt$(accel.totalInterest),
        cls: interestSaved > 0 ? 'is-good' : ''
      },
      {
        label: 'Total out of pocket', value: fmt$(accel.totalOutOfPocket),
        sub: 'vs ' + fmt$(base.totalOutOfPocket) + ' at the minimum'
      }
    ].map(statHTML).join('');

    // --- Chart -----------------------------------------------------------
    var basePts = yearlySamples(base.rows);
    var accelPts = yearlySamples(accel.rows);
    var labels = basePts.map(function (r) { return r.year; });
    C.area($('sideChart'), {
      height: 320, labels: labels,
      series: [
        { label: 'Minimum payment', color: cssVar('--c-interest'), data: basePts.map(function (r) { return r.balance; }), fill: true },
        { label: 'Your payment', color: cssVar('--c-accel'), data: labels.map(function (_, i) { return i < accelPts.length ? accelPts[i].balance : 0; }), fill: true }
      ],
      ariaLabel: 'Balance comparison between the minimum payment and your payment'
    });
    C.legend($('sideLegend'), [
      { label: 'Minimum payment — ' + fmt$2(minPay), color: cssVar('--c-interest') },
      { label: 'Your payment — ' + fmt$2(chosen), color: cssVar('--c-accel') }
    ]);

    renderSideTable(base, accel);
  }

  /** One row per period, both loans across it, so the eye can read straight over. */
  function renderSideTable(base, accel) {
    var annual = state.sideView === 'annual';
    var left = annual ? base.years : base.rows;
    var right = annual ? accel.years : accel.rows;
    var n = Math.max(left.length, right.length);

    var head =
      '<thead><tr>' +
      '<th rowspan="2">' + (annual ? 'Year' : '#') + '</th>' +
      (annual ? '' : '<th rowspan="2">Date</th>') +
      '<th class="group-head group-base sep-left" colspan="3">Minimum payment</th>' +
      '<th class="group-head group-accel sep-left" colspan="3">Your payment</th>' +
      '<th rowspan="2">Balance difference</th>' +
      '</tr><tr>' +
      '<th class="sep-left">Payment</th><th>Interest</th><th>Balance</th>' +
      '<th class="cell-accel sep-left">Payment</th><th class="cell-accel">Interest</th><th class="cell-accel">Balance</th>' +
      '</tr></thead>';

    var money = annual ? fmt$ : fmt$2;
    var rows = [];
    for (var i = 0; i < n; i++) {
      var l = left[i], r = right[i];
      var label = annual
        ? (l ? l.year : r.year)
        : (l ? l.n : r.n);
      var date = annual ? '' : '<td>' + (l ? l.date : r.date) + '</td>';

      var lPay = l ? money(annual ? l.payment + l.extra : l.payment + l.extra) : '—';
      var lInt = l ? money(l.interest) : '—';
      var lBal = l ? money(annual ? l.balance : l.balance) : '—';

      var rPay, rInt, rBal, cls = '';
      if (r) {
        rPay = money(r.payment + r.extra);
        rInt = money(r.interest);
        rBal = money(r.balance);
      } else {
        rPay = '<span class="chip is-green">paid off</span>';
        rInt = '—'; rBal = money(0);
        cls = 'is-past-base';
      }

      var lBalNum = l ? l.balance : 0;
      var rBalNum = r ? r.balance : 0;
      var diff = lBalNum - rBalNum;

      rows.push('<tr class="' + (i === n - 1 ? 'is-payoff ' : '') + '">' +
        '<td><strong>' + label + '</strong></td>' + date +
        '<td class="sep-left">' + lPay + '</td>' +
        '<td class="num-interest">' + lInt + '</td>' +
        '<td class="num-balance">' + lBal + '</td>' +
        '<td class="cell-accel sep-left">' + rPay + '</td>' +
        '<td class="cell-accel num-interest">' + rInt + '</td>' +
        '<td class="cell-accel num-balance">' + rBal + '</td>' +
        '<td>' + (diff > 0.5
          ? '<span class="delta-pill up">' + fmt$(diff) + ' less owed</span>'
          : '<span class="delta-pill flat">—</span>') + '</td>' +
        '</tr>');
    }

    var foot = '<tfoot><tr><td>Totals</td>' + (annual ? '' : '<td></td>') +
      '<td class="sep-left">' + fmt$(base.totalPaid) + '</td>' +
      '<td>' + fmt$(base.totalInterest) + '</td>' +
      '<td>—</td>' +
      '<td class="cell-accel sep-left">' + fmt$(accel.totalPaid) + '</td>' +
      '<td class="cell-accel">' + fmt$(accel.totalInterest) + '</td>' +
      '<td class="cell-accel">—</td>' +
      '<td class="text-good"><strong>' + fmt$(base.totalInterest - accel.totalInterest) + ' saved</strong></td>' +
      '</tr></tfoot>';

    $('sideTableWrap').innerHTML =
      '<table class="data paired">' + head + '<tbody>' + rows.join('') + '</tbody>' + foot + '</table>';
  }

  /* ==================================================================
   * TAB 4 — Refinance
   * ================================================================== */
  function currentLoanInputs() {
    if (state.curMode === 'original') {
      var derived = F.currentLoanFromOrigination(
        val('origAmount'), val('origRate'), parseInt($('origTerm').value, 10),
        { year: Math.round(val('origStartYear')), month: parseInt($('origStartMonth').value, 10) },
        F.todayYM()
      );
      $('derivedLoanNote').innerHTML =
        'After <strong>' + derived.elapsedMonths + '</strong> payments your balance is about <strong>' +
        fmt$(derived.balance) + '</strong>, with <strong>' + fmtDuration(derived.remainingMonths) +
        '</strong> left at <strong>' + fmt$2(derived.payment) + '</strong> a month.';
      return {
        balance: derived.balance,
        rate: val('origRate'),
        remainingMonths: derived.remainingMonths,
        paymentOverride: derived.payment
      };
    }
    var override = parseNum($('curPaymentOverride').value);
    return {
      balance: val('curBalance'),
      rate: val('curRate'),
      remainingMonths: Math.round(val('curRemaining') * 12),
      paymentOverride: override > 0 ? override : 0
    };
  }

  /* ---------- Debt consolidation ---------- */

  function debtsConfig() {
    return state.debts.map(function (d) {
      return {
        creditor: d.creditor,
        balance: parseNum(d.balance),
        payment: parseNum(d.payment),
        rate: parseNum(d.rate)
      };
    });
  }

  function consolidating() {
    return $('consolidateDebts').getAttribute('aria-checked') === 'true';
  }

  function renderDebtList() {
    var list = $('debtList');
    if (!state.debts.length) {
      list.innerHTML = '<p class="hint" style="margin-bottom:12px">No debts added yet. Add credit cards, ' +
        'auto or student loans to see what folding them into the refinance does to the monthly payment.</p>';
      return;
    }
    list.innerHTML = state.debts.map(function (d, i) {
      return '<div class="debt-item">' +
        '<div class="debt-item-head">' +
        '<input type="text" data-debt="creditor" data-i="' + i + '" value="' + esc(d.creditor) + '" placeholder="Creditor" aria-label="Creditor name">' +
        '<button class="remove-btn" type="button" data-debt="remove" data-i="' + i + '" aria-label="Remove this debt">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button></div>' +
        '<div class="debt-item-fields">' +
        '<label><span>Balance</span><div class="input-wrap"><span class="affix affix-left">$</span>' +
        '<input type="text" inputmode="decimal" class="has-affix-left" data-debt="balance" data-i="' + i + '" value="' + esc(d.balance) + '"></div></label>' +
        '<label><span>Payment</span><div class="input-wrap"><span class="affix affix-left">$</span>' +
        '<input type="text" inputmode="decimal" class="has-affix-left" data-debt="payment" data-i="' + i + '" value="' + esc(d.payment) + '"></div></label>' +
        '<label><span>Rate</span><div class="input-wrap">' +
        '<input type="text" inputmode="decimal" class="has-affix-right" data-debt="rate" data-i="' + i + '" value="' + esc(d.rate) + '"><span class="affix affix-right">%</span></div></label>' +
        '</div></div>';
    }).join('');
  }

  function renderConsolidation(cur) {
    var box = $('consolidationResult');
    var debts = debtsConfig();
    var summary = F.summarizeDebts(debts);

    $('consolidateHint').textContent = summary.count
      ? (consolidating()
        ? fmt$(summary.totalBalance) + ' is added to the new loan and the ' + summary.count +
          ' separate payment' + (summary.count === 1 ? '' : 's') + ' stop.'
        : 'The refinance covers the mortgage only; you keep paying these separately.')
      : '';

    if (!summary.count) {
      box.innerHTML = '<p class="empty-state mb-0">Add a debt on the left to see how much your total ' +
        'monthly outlay changes when those balances are rolled into the loan.</p>';
      return;
    }

    var c = F.analyzeConsolidation({
      currentBalance: cur.balance,
      currentRate: cur.rate,
      currentRemainingMonths: cur.remainingMonths,
      currentPaymentOverride: cur.paymentOverride,
      newRate: val('newRate'),
      newTermMonths: parseInt($('newTerm').value, 10),
      closingCosts: val('closingCosts'),
      pointsPct: val('points'),
      rollIntoLoan: $('rollIn').getAttribute('aria-checked') === 'true',
      cashOut: val('cashOut'),
      start: F.todayYM(),
      debts: debts
    });
    cache.consolidation = c;

    // --- Three ways to look at the same month ---------------------------
    var columns = [
      {
        title: 'Today', value: c.monthlyToday,
        sub: 'Mortgage ' + fmt$(c.withoutConsolidation.currentPayment) + ' + ' +
          fmt$(summary.totalMonthly) + ' in debt payments'
      },
      {
        title: 'Refinance only', value: c.monthlyRefiOnly,
        sub: c.monthlySavingsRefiOnly >= 0
          ? 'Saves ' + fmt$2(c.monthlySavingsRefiOnly) + ' a month'
          : 'Costs ' + fmt$2(-c.monthlySavingsRefiOnly) + ' more a month',
        delta: c.monthlySavingsRefiOnly
      },
      {
        title: 'Refinance + consolidate', value: c.monthlyConsolidated,
        sub: 'One payment, ' + summary.count + ' account' + (summary.count === 1 ? '' : 's') + ' closed',
        delta: c.monthlySavingsConsolidated, highlight: true
      }
    ];

    var colsHtml = '<div class="outlay-grid">' + columns.map(function (col) {
      return '<div class="outlay-col' + (col.highlight ? ' is-highlight' : '') + '">' +
        '<div class="outlay-title">' + esc(col.title) + '</div>' +
        '<div class="outlay-value">' + fmt$2(col.value) + '<span class="outlay-per">/mo</span></div>' +
        (col.delta !== undefined
          ? '<div class="outlay-delta ' + (col.delta > 0 ? 'up' : col.delta < 0 ? 'down' : 'flat') + '">' +
            (col.delta > 0 ? '−' : col.delta < 0 ? '+' : '') + fmt$(Math.abs(col.delta)) + '/mo</div>'
          : '<div class="outlay-delta flat">baseline</div>') +
        '<div class="outlay-sub">' + col.sub + '</div>' +
        '</div>';
    }).join('') + '</div>';

    // --- Headline numbers -----------------------------------------------
    var stats = [
      {
        label: 'Monthly savings if we consolidate',
        value: fmt$2(c.monthlySavingsConsolidated),
        sub: fmt$(c.annualSavingsConsolidated) + ' a year back in your pocket',
        hero: true
      },
      {
        label: 'From consolidating alone',
        value: fmt$2(c.monthlySavingsFromConsolidating),
        sub: 'On top of the ' + fmt$2(c.monthlySavingsRefiOnly) + ' the refinance itself saves',
        cls: c.monthlySavingsFromConsolidating > 0 ? 'is-good' : ''
      },
      {
        label: 'Debt rolled in', value: fmt$(summary.totalBalance),
        sub: summary.count + ' account' + (summary.count === 1 ? '' : 's') +
          ' · new loan ' + fmt$(c.newPrincipalConsolidated)
      },
      {
        label: 'Blended rate today', value: fmtPct(c.blendedRateBefore, 2),
        sub: 'Mortgage and debts combined, versus ' + fmtPct(c.newRate, 3) + ' on the new loan',
        tip: 'The balance-weighted average rate across your mortgage and every debt. It is what you are really paying to borrow.',
        cls: c.blendedRateBefore > c.newRate ? 'is-good' : ''
      }
    ];

    // --- The honest counterpoint ------------------------------------------
    var caveat;
    if (!isFinite(summary.totalInterest)) {
      caveat = '<div class="callout is-warn"><svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>' +
        '<div><strong>At least one of these never gets paid off.</strong> The payment does not cover the ' +
        'interest accruing on the balance, so it grows instead of shrinking. Consolidating is not just a ' +
        'cash-flow move here — it is the only way that balance ever clears.</div></div>';
    } else if (c.lifetimeInterestDelta > 0) {
      caveat = '<div class="callout is-warn"><svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>' +
        '<div><strong>Lower payment, more interest over time.</strong> Paid on their own schedules these ' +
        'debts cost ' + fmt$(summary.totalInterest) + ' in interest and are gone in ' +
        fmtDuration(summary.longestMonths) + '. Spread across ' +
        fmtDuration(c.withConsolidation.newSchedule.months) + ' of mortgage they cost ' +
        fmt$(c.interestOnConsolidatedDebt) + ' — about ' + fmt$(c.lifetimeInterestDelta) +
        ' more. The monthly relief is real; so is that number. Keep paying the old amount toward ' +
        'principal and you claw most of it back.</div></div>';
    } else {
      caveat = '<div class="callout is-good"><svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '<div><strong>Cheaper monthly and cheaper overall.</strong> These balances cost ' +
        fmt$(summary.totalInterest) + ' in interest on their own schedules. Rolled into the loan at ' +
        fmtPct(c.newRate, 3) + ' they cost ' + fmt$(c.interestOnConsolidatedDebt) + ' — ' +
        fmt$(Math.abs(c.lifetimeInterestDelta)) + ' less, on top of the monthly saving.</div></div>';
    }

    // --- Per-creditor detail -----------------------------------------------
    var table = '<div class="table-scroll mt-20"><table class="data">' +
      '<thead><tr><th>Creditor</th><th>Balance</th><th>Payment</th><th>Rate</th>' +
      '<th>Paid off in</th><th>Interest if you keep it</th></tr></thead><tbody>' +
      summary.rows.map(function (d) {
        return '<tr' + (d.neverPaysOff ? ' class="is-pmi-drop"' : '') + '>' +
          '<td><strong>' + esc(d.creditor) + '</strong></td>' +
          '<td>' + fmt$(d.balance) + '</td>' +
          '<td>' + fmt$2(d.payment) + '</td>' +
          '<td>' + fmtPct(d.rate, 2) + '</td>' +
          '<td>' + (d.neverPaysOff
            ? '<span class="delta-pill down">never at this payment</span>'
            : fmtDuration(d.months)) + '</td>' +
          '<td class="' + (d.neverPaysOff ? 'text-bad' : 'num-interest') + '">' +
          (d.neverPaysOff ? 'Balance grows' : fmt$(d.totalInterest)) + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr><td>Totals</td><td>' + fmt$(summary.totalBalance) + '</td>' +
      '<td>' + fmt$2(summary.totalMonthly) + '</td>' +
      '<td>' + fmtPct(summary.blendedRate, 2) + '</td><td></td>' +
      '<td>' + (isFinite(summary.totalInterest) ? fmt$(summary.totalInterest) : '—') +
      '</td></tr></tfoot></table></div>';

    box.innerHTML = colsHtml +
      '<div class="stat-grid mt-20">' + stats.map(statHTML).join('') + '</div>' +
      '<div class="mt-20">' + caveat + '</div>' +
      table;
  }

  function renderRefi() {
    var cur = currentLoanInputs();
    var r = F.analyzeRefinance({
      currentBalance: cur.balance,
      currentRate: cur.rate,
      currentRemainingMonths: cur.remainingMonths,
      currentPaymentOverride: cur.paymentOverride,
      newRate: val('newRate'),
      newTermMonths: parseInt($('newTerm').value, 10),
      closingCosts: val('closingCosts'),
      pointsPct: val('points'),
      rollIntoLoan: $('rollIn').getAttribute('aria-checked') === 'true',
      cashOut: val('cashOut'),
      debtPayoff: consolidating() ? F.summarizeDebts(debtsConfig()).totalBalance : 0,
      start: F.todayYM(),
      investmentReturnPct: val('investReturn'),
      yearsInHome: val('yearsInHome')
    });
    cache.refi = r;

    var err = r.currentSchedule.error || r.newSchedule.error;
    if (showError('refiError', err)) return;

    renderRefiVerdict(r);

    var stats = [
      {
        label: 'New monthly payment', value: fmt$2(r.newPayment),
        sub: 'Was ' + fmt$2(r.currentPayment) + ' (principal & interest)', hero: true
      },
      {
        label: r.monthlySavings >= 0 ? 'Monthly savings' : 'Monthly increase',
        value: fmt$2(Math.abs(r.monthlySavings)),
        sub: fmt$(Math.abs(r.annualSavings)) + ' a year',
        cls: r.monthlySavings > 0 ? 'is-good' : 'is-bad'
      },
      {
        label: 'Break-even on interest', value: r.interestBreakEvenMonths
          ? fmtDuration(r.interestBreakEvenMonths) : 'Never',
        sub: r.interestBreakEvenMonths
          ? 'Interest saved covers ' + fmt$(r.totalCosts) + ' by ' + ymLabel(r.interestBreakEvenDate)
          : 'Interest saved never covers the cost',
        tip: 'The month the interest you avoid adds up to what the refinance cost. Principal is not counted — that is equity you keep either way, so only interest is money actually spent.',
        cls: r.interestBreakEvenMonths && r.interestBreakEvenMonths <= r.horizonMonths
          ? 'is-good' : 'is-warn'
      },
      {
        label: 'Interest saved by move-out',
        value: fmt$(r.interestSavedAtHorizon),
        sub: 'Over ' + fmtDuration(r.horizonMonths) + ', net of ' + fmt$(r.totalCosts) + ' in costs: ' +
          fmt$(r.interestSavedAtHorizon - r.totalCosts),
        cls: r.interestSavedAtHorizon > r.totalCosts ? 'is-good' : 'is-warn'
      },
      {
        label: 'Payment-based break-even', value: isFinite(r.simpleBreakEvenMonths)
          ? fmtDuration(r.simpleBreakEvenMonths) : 'Never',
        sub: isFinite(r.simpleBreakEvenMonths)
          ? 'Costs recovered by ' + ymLabel(r.simpleBreakEvenDate)
          : 'The payment doesn\'t go down',
        tip: 'Closing costs divided by the monthly payment drop — the number most lenders quote. It flatters a longer term, because part of the "savings" is simply paying less principal.'
      },
      {
        label: 'Estimated APR', value: fmtPct(r.newApr, 3),
        sub: 'Note rate ' + fmtPct(r.newSchedule.annualRate, 3) + ' plus the cost of credit',
        tip: 'Estimated under Regulation Z (12 CFR 1026.22). Your official APR appears on the Loan Estimate and may differ.'
      },
      {
        label: 'Cost to refinance', value: fmt$(r.totalCosts),
        sub: r.cashAtClosing > 0 ? fmt$(r.cashAtClosing) + ' due at closing' : 'Rolled into the loan'
      },
      {
        label: 'Lifetime interest', value: fmt$(r.newTotalInterest),
        sub: (r.lifetimeInterestSaved >= 0 ? 'Saves ' : 'Costs an extra ') +
          fmt$(Math.abs(r.lifetimeInterestSaved)) + ' vs. staying put',
        cls: r.lifetimeInterestSaved > 0 ? 'is-good' : 'is-bad'
      }
    ];

    if (r.savingsInvestedValue > 0) {
      stats.push({
        label: 'If you invest the savings', value: fmt$(r.savingsInvestedValue),
        sub: 'After ' + fmtDuration(r.horizonMonths) + ' at ' + fmtPct(val('investReturn')),
        cls: 'is-good'
      });
    }
    if (r.cashOut > 0) {
      stats.push({ label: 'Cash in hand', value: fmt$(r.cashOut), sub: 'Taken from your equity at closing' });
    }
    $('refiStats').innerHTML = stats.map(statHTML).join('');

    // --- Interest-saved crossover ----------------------------------------
    // Plots cumulative interest avoided against the cost of the refinance.
    // Where the curve clears the flat cost line, the refinance has paid for
    // itself in real money — no principal counted as "savings".
    var step = Math.max(1, Math.floor(r.series.length / 180));
    var pts = r.series.filter(function (_, i) { return i % step === 0 || i === r.series.length - 1; });
    C.area($('refiChart'), {
      height: 330,
      labels: pts.map(function (p) { return F.MONTH_NAMES[p.ym.month] + " '" + String(p.ym.year).slice(2); }),
      series: [
        {
          label: 'Interest saved so far', color: cssVar('--green-500'),
          data: pts.map(function (p) { return p.interestSaved; }), fill: true
        },
        {
          label: 'Cost to refinance', color: cssVar('--c-pmi'),
          data: pts.map(function () { return r.totalCosts; }), dashed: true
        }
      ],
      markers: [
        r.interestBreakEvenMonths
          ? { index: Math.round(r.interestBreakEvenMonths / step), label: 'Pays for itself', color: cssVar('--green-600') }
          : null,
        r.horizonMonths
          ? { index: Math.round(r.horizonMonths / step), label: 'You move', color: cssVar('--text-3') }
          : null
      ].filter(Boolean),
      valueFormat: function (v) { return fmt$(v); },
      ariaLabel: 'Cumulative interest saved compared with the cost of refinancing'
    });
    C.legend($('refiLegend'), [
      { label: 'Interest saved so far', color: cssVar('--green-500') },
      { label: 'Cost to refinance — ' + fmt$(r.totalCosts), color: cssVar('--c-pmi') }
    ]);

    var lifetimeInterestCur = r.currentTotalInterest, lifetimeInterestNew = r.newTotalInterest;
    $('refiBreakEvenNote').innerHTML =
      '<div class="callout is-info"><svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="8"/></svg>' +
      '<div><strong>Why interest, and not the payment?</strong> The principal in every payment is not a cost — ' +
      'it buys down your balance and comes back to you as equity when you sell. Interest is the only part you ' +
      'never see again, so it is the only honest measure of what a loan costs. This chart tracks the interest ' +
      'you avoid at ' + fmtPct(r.newSchedule.annualRate, 3) + ' instead of ' +
      fmtPct(r.currentSchedule.annualRate, 3) + ' — ' +
      fmt$(r.monthlyInterestSavedFirstMonth) + ' in the first month alone — and the point where that ' +
      'adds up to the ' + fmt$(r.totalCosts) + ' the refinance costs. ' +
      (r.trueBreakEvenMonths
        ? 'Counting the balance still owed as well, you are ahead on total position from ' +
          ymLabel(r.trueBreakEvenDate) + '.'
        : 'Note that on total cost including the balance still owed, this loan does not pull ahead — ' +
          'the longer term is doing some of the work.') +
      '</div></div>';

    renderConsolidation(cur);
    renderRefiCompare(r);
    renderKeepSame(r);
    renderBuydown(r);
  }

  function renderRefiVerdict(r) {
    var box = $('refiVerdict');
    var kind, title, text;
    var stays = r.horizonMonths;

    // The verdict is judged on interest avoided, not on the payment drop.
    var be = r.interestBreakEvenMonths;
    var netAtMove = r.interestSavedAtHorizon - r.totalCosts;

    if (r.monthlySavings <= 0 && r.cashOut <= 0 && !be) {
      kind = 'bad';
      title = 'This refinance costs you money';
      text = 'The new rate does not save interest, and the payment is ' +
        fmt$2(Math.abs(r.monthlySavings)) + ' higher. Unless you are refinancing to drop mortgage ' +
        'insurance or escape an adjustable rate, this one does not pencil.';
    } else if (!be) {
      kind = 'bad';
      title = 'The interest saved never repays the cost';
      text = (r.monthlySavings > 0
        ? 'The payment drops ' + fmt$2(r.monthlySavings) + ' a month, but that is mostly because the term ' +
          'resets — you would be paying less principal, not less interest. '
        : '') +
        'Across the life of the loan this costs ' + fmt$(Math.abs(r.lifetimeInterestSaved)) +
        ' more in interest than staying put, so the ' + fmt$(r.totalCosts) +
        ' upfront never comes back.';
    } else if (be <= stays) {
      kind = 'good';
      title = 'This refinance pays for itself';
      text = 'The interest you avoid covers the ' + fmt$(r.totalCosts) + ' cost after ' +
        fmtDuration(be) + ' — comfortably inside the ' + fmtDuration(stays) + ' you plan to stay. ' +
        'By the time you move you are ' + fmt$(netAtMove) + ' ahead in interest alone, and you save ' +
        fmt$(r.lifetimeInterestSaved) + ' over the full term if you keep it.';
    } else {
      kind = 'warn';
      title = 'Good loan, but you may move too soon';
      text = 'It takes ' + fmtDuration(be) + ' of interest savings to repay the ' + fmt$(r.totalCosts) +
        ' cost, and you expect to stay only ' + fmtDuration(stays) + '. You would be about ' +
        fmt$(Math.abs(netAtMove)) + ' short when you sell. Ask about a lender credit to cut the ' +
        'upfront cost and pull that date forward.';
    }

    var ICON = {
      good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
      bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };

    box.innerHTML = '<div class="verdict is-' + kind + '">' +
      '<div class="verdict-badge">' + ICON[kind] + '</div>' +
      '<div><div class="verdict-title">' + title + '</div>' +
      '<div class="verdict-text">' + text + '</div></div></div>';
  }

  function renderRefiCompare(r) {
    var rows = [
      ['Loan amount', fmt$(r.currentSchedule.principal), fmt$(r.newPrincipal)],
      ['Interest rate', fmtPct(r.currentSchedule.annualRate, 3), fmtPct(r.newSchedule.annualRate, 3)],
      ['Term remaining', fmtDuration(r.currentSchedule.months), fmtDuration(r.newSchedule.months)],
      ['Monthly principal &amp; interest', fmt$2(r.currentPayment), fmt$2(r.newPayment)],
      ['Total interest remaining', fmt$(r.currentTotalInterest), fmt$(r.newTotalInterest)],
      ['Upfront cost', fmt$(0), fmt$(r.totalCosts)],
      ['Total you will pay', fmt$(r.currentTotalPaid), fmt$(r.newTotalPaid)],
      ['Paid off', ymLabel(r.currentSchedule.payoff), ymLabel(r.newSchedule.payoff)]
    ];
    $('refiCompareWrap').innerHTML =
      '<table class="data"><thead><tr><th></th><th>Current loan</th><th>After refinancing</th><th>Difference</th></tr></thead><tbody>' +
      rows.map(function (row) {
        var a = row[1], b = row[2];
        var diff = '';
        if (a.charAt(0) === '$' && b.charAt(0) === '$') {
          var d = parseNum(b) - parseNum(a);
          diff = Math.abs(d) < 0.5 ? '<span class="delta-pill flat">—</span>'
            : '<span class="delta-pill ' + (d < 0 ? 'up' : 'down') + '">' +
              (d < 0 ? '\u2212' : '+') + fmt$(Math.abs(d)) + '</span>';
        } else if (/%$/.test(a) && /%$/.test(b)) {
          // Rates differ in percentage points, not dollars.
          var dp = parseNum(b) - parseNum(a);
          diff = Math.abs(dp) < 0.0005 ? '<span class="delta-pill flat">—</span>'
            : '<span class="delta-pill ' + (dp < 0 ? 'up' : 'down') + '">' +
              (dp < 0 ? '\u2212' : '+') + Math.abs(dp).toFixed(3) + ' pts</span>';
        }
        return '<tr><td><strong>' + row[0] + '</strong></td><td>' + a + '</td><td>' + b + '</td><td>' + diff + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderKeepSame(r) {
    var box = $('keepSameResult');
    if (!r.keepSameSchedule || r.monthlySavings <= 0) {
      box.innerHTML = '<p class="empty-state mb-0">This move applies when the refinance lowers your payment — ' +
        'you keep paying the old amount and the difference attacks the principal.</p>';
      return;
    }
    var k = r.keepSameSchedule;
    box.innerHTML =
      '<div class="callout is-good" style="margin-bottom:16px"><svg class="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>' +
      '<div>Refinance to ' + fmtPct(r.newSchedule.annualRate, 3) + ', then keep writing the same ' +
      fmt$2(r.currentPayment) + ' check you write today. The extra ' + fmt$2(r.monthlySavings) +
      ' goes straight to principal every month.</div></div>' +
      '<div class="stat-grid">' + [
        { label: 'Paid off', value: ymLabel(k.payoff), sub: 'Instead of ' + ymLabel(r.newSchedule.payoff), hero: true },
        { label: 'Years cut from the new loan', value: fmtDuration(r.keepSameMonthsSaved), sub: 'Versus the minimum payment', cls: 'is-good' },
        { label: 'Extra interest saved', value: fmt$(r.keepSameInterestSaved), sub: 'On top of the refinance savings', cls: 'is-good' },
        { label: 'Your payment', value: fmt$2(r.currentPayment), sub: 'Exactly what you pay now' }
      ].map(statHTML).join('') + '</div>';
  }

  function renderBuydown(r) {
    var b = F.analyzeBuydown({
      principal: r.newPrincipal,
      termMonths: parseInt($('newTerm').value, 10),
      baseRate: val('bdBaseRate'),
      buydownRate: val('bdBuyRate'),
      pointsPct: val('bdPoints')
    });
    var box = $('buydownResult');
    if (b.monthlySavings <= 0) {
      box.innerHTML = '<div class="callout is-warn">The bought-down rate needs to be lower than the base rate for this to make sense.</div>';
      return;
    }
    box.innerHTML = '<div class="stat-grid">' + [
      { label: 'Cost of the points', value: fmt$(b.cost), sub: fmtPct(val('bdPoints'), 2) + ' of ' + fmt$(r.newPrincipal) },
      { label: 'Monthly saving', value: fmt$2(b.monthlySavings), sub: fmt$2(b.basePayment) + ' → ' + fmt$2(b.buydownPayment) },
      { label: 'Break-even', value: fmtDuration(b.breakEvenMonths), sub: 'Then it is pure savings', hero: true },
      {
        label: 'Net lifetime benefit', value: fmt$(b.lifetimeSavings),
        sub: 'If you keep the loan the whole term', cls: b.lifetimeSavings > 0 ? 'is-good' : 'is-bad'
      }
    ].map(statHTML).join('') + '</div>' +
      '<div class="hint mt-12">Worth it only if you keep this loan past ' + fmtDuration(b.breakEvenMonths) +
      '. You expect to stay ' + fmtDuration(Math.round(val('yearsInHome') * 12)) + '.</div>';
  }

  /* ==================================================================
   * TAB 5 — Compare loans
   * ================================================================== */
  function scenarioColors() {
    return [cssVar('--c-principal'), cssVar('--violet-500'), cssVar('--amber-500')];
  }
  var scenarios = [
    { name: '30-year fixed', amount: 360000, rate: 6.5, term: 360, extra: 0 },
    { name: '15-year fixed', amount: 360000, rate: 5.75, term: 180, extra: 0 },
    { name: '30-year + $300/mo', amount: 360000, rate: 6.5, term: 360, extra: 300 }
  ];

  function renderScenarioInputs() {
    $('scenarioInputs').innerHTML = scenarios.map(function (sc, i) {
      return '<div class="card scenario-card">' +
        '<div class="scenario-color-bar" style="background:' + scenarioColors()[i] + '"></div>' +
        '<div class="card-body">' +
        '<div class="field"><label class="field-label" for="scName' + i + '">Scenario name</label>' +
        '<input type="text" id="scName' + i + '" data-sc="name" data-i="' + i + '" value="' + esc(sc.name) + '"></div>' +
        '<div class="field"><label class="field-label" for="scAmount' + i + '">Loan amount</label>' +
        '<div class="input-wrap"><span class="affix affix-left">$</span>' +
        '<input type="text" inputmode="decimal" class="has-affix-left" id="scAmount' + i + '" data-sc="amount" data-i="' + i + '" value="' + num0.format(sc.amount) + '"></div></div>' +
        '<div class="field-row">' +
        '<div class="field"><label class="field-label" for="scRate' + i + '">Rate</label>' +
        '<div class="input-wrap"><input type="text" inputmode="decimal" class="has-affix-right" id="scRate' + i + '" data-sc="rate" data-i="' + i + '" value="' + sc.rate + '"><span class="affix affix-right">%</span></div></div>' +
        '<div class="field"><label class="field-label" for="scTerm' + i + '">Term</label>' +
        '<select id="scTerm' + i + '" data-sc="term" data-i="' + i + '">' +
        [360, 300, 240, 180, 120].map(function (t) {
          return '<option value="' + t + '"' + (t === sc.term ? ' selected' : '') + '>' + (t / 12) + ' years</option>';
        }).join('') + '</select></div></div>' +
        '<div class="field mb-0"><label class="field-label" for="scExtra' + i + '">Extra per month</label>' +
        '<div class="input-wrap"><span class="affix affix-left">$</span>' +
        '<input type="text" inputmode="decimal" class="has-affix-left" id="scExtra' + i + '" data-sc="extra" data-i="' + i + '" value="' + num0.format(sc.extra) + '"></div></div>' +
        '</div></div>';
    }).join('');
  }

  function renderCompare() {
    var results = scenarios.map(function (sc) {
      return F.buildSchedule({
        principal: sc.amount, annualRate: sc.rate, termMonths: sc.term,
        start: F.todayYM(),
        extras: sc.extra > 0 ? { monthly: sc.extra } : null
      });
    });
    cache.scenarios = results;

    var valid = results.filter(function (s) { return !s.error; });
    if (!valid.length) {
      $('compareStats').innerHTML = '<p class="empty-state">Enter valid loan details to compare.</p>';
      return;
    }

    var bestInterest = Math.min.apply(null, valid.map(function (s) { return s.totalInterest; }));

    $('compareStats').innerHTML = results.map(function (s, i) {
      if (s.error) {
        return '<div class="stat is-bad"><div class="stat-label">' + esc(scenarios[i].name) + '</div>' +
          '<div class="stat-value" style="font-size:15px">Check inputs</div></div>';
      }
      var isWinner = Math.abs(s.totalInterest - bestInterest) < 0.5;
      return '<div class="stat' + (isWinner ? ' is-good' : '') + '" style="border-left:4px solid ' + scenarioColors()[i] + '">' +
        '<div class="stat-label">' + esc(scenarios[i].name) + (isWinner ? ' · least interest' : '') + '</div>' +
        '<div class="stat-value">' + fmt$2(s.basePayment + scenarios[i].extra) + '</div>' +
        '<div class="stat-sub">' + fmt$(s.totalInterest) + ' interest · paid off ' + ymLabel(s.payoff) + '</div>' +
        '</div>';
    }).join('');

    var maxMonths = Math.max.apply(null, valid.map(function (s) { return s.months; }));
    var labels = [];
    for (var y = 0; y <= Math.ceil(maxMonths / 12); y++) labels.push(F.todayYM().year + y);

    C.area($('compareChart'), {
      height: 330, labels: labels,
      series: results.map(function (s, i) {
        if (s.error) return null;
        return {
          label: scenarios[i].name, color: scenarioColors()[i],
          data: labels.map(function (_, k) {
            var idx = k * 12;
            if (idx === 0) return s.principal;
            return idx - 1 < s.rows.length ? s.rows[idx - 1].balance : 0;
          })
        };
      }).filter(Boolean),
      ariaLabel: 'Balance over time for each scenario'
    });
    C.legend($('compareLegend'), results.map(function (s, i) {
      return { label: scenarios[i].name, color: scenarioColors()[i] };
    }));

    var metrics = [
      ['Monthly payment', function (s, i) { return fmt$2(s.basePayment + scenarios[i].extra); }],
      ['Principal &amp; interest', function (s) { return fmt$2(s.basePayment); }],
      ['Extra per month', function (s, i) { return scenarios[i].extra > 0 ? fmt$2(scenarios[i].extra) : '—'; }],
      ['Payoff date', function (s) { return ymLabel(s.payoff); }],
      ['Actual term', function (s) { return fmtDuration(s.months); }],
      ['Total interest', function (s) { return fmt$(s.totalInterest); }],
      ['Total of payments', function (s) { return fmt$(s.totalPaid); }],
      ['Interest per $1 borrowed', function (s) { return '$' + (s.totalInterest / s.principal).toFixed(2); }]
    ];

    $('compareTableWrap').innerHTML =
      '<table class="data"><thead><tr><th></th>' +
      scenarios.map(function (sc, i) {
        return '<th style="color:' + scenarioColors()[i] + '">' + esc(sc.name) + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      metrics.map(function (m) {
        return '<tr><td><strong>' + m[0] + '</strong></td>' +
          results.map(function (s, i) {
            return '<td>' + (s.error ? '—' : m[1](s, i)) + '</td>';
          }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  /* ==================================================================
   * CSV export
   * ================================================================== */
  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(v) {
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function scheduleCSV(s, title) {
    var lines = [];
    lines.push([title]);
    lines.push(['Loan amount', s.principal.toFixed(2)]);
    lines.push(['Rate', s.annualRate + '%']);
    lines.push(['Scheduled payment', s.basePayment.toFixed(2)]);
    lines.push(['Payments', s.months]);
    lines.push(['Total interest', s.totalInterest.toFixed(2)]);
    lines.push([]);
    lines.push(['Payment #', 'Date', 'Payment', 'Principal', 'Interest', 'Extra',
      'PMI', 'Tax & insurance', 'Total outlay', 'Interest to date', 'Balance']);
    s.rows.forEach(function (r) {
      lines.push([r.n, r.date, (r.payment + r.extra).toFixed(2), r.principal.toFixed(2),
        r.interest.toFixed(2), r.extra.toFixed(2), r.pmi.toFixed(2), r.escrow.toFixed(2),
        r.totalPayment.toFixed(2), r.cumInterest.toFixed(2), r.balance.toFixed(2)]);
    });
    return lines.map(function (row) { return row.map(csvCell).join(','); }).join('\n');
  }

  function sideBySideCSV(base, accel, chosen) {
    var lines = [];
    lines.push(['Side-by-side amortization comparison']);
    lines.push(['Minimum payment', base.basePayment.toFixed(2)]);
    lines.push(['Your payment', chosen.toFixed(2)]);
    lines.push(['Interest saved', (base.totalInterest - accel.totalInterest).toFixed(2)]);
    lines.push(['Payments saved', base.months - accel.months]);
    lines.push([]);
    lines.push(['Payment #', 'Date',
      'Min: payment', 'Min: principal', 'Min: interest', 'Min: balance',
      'Yours: payment', 'Yours: principal', 'Yours: interest', 'Yours: balance',
      'Balance difference']);
    var n = Math.max(base.rows.length, accel.rows.length);
    for (var i = 0; i < n; i++) {
      var l = base.rows[i], r = accel.rows[i];
      lines.push([
        i + 1, (l || r).date,
        l ? (l.payment + l.extra).toFixed(2) : '', l ? l.principal.toFixed(2) : '',
        l ? l.interest.toFixed(2) : '', l ? l.balance.toFixed(2) : '',
        r ? (r.payment + r.extra).toFixed(2) : 'PAID OFF', r ? r.principal.toFixed(2) : '',
        r ? r.interest.toFixed(2) : '', r ? r.balance.toFixed(2) : '0.00',
        ((l ? l.balance : 0) - (r ? r.balance : 0)).toFixed(2)
      ]);
    }
    return lines.map(function (row) { return row.map(csvCell).join(','); }).join('\n');
  }

  /* ==================================================================
   * Linked down-payment / loan-amount fields
   * ================================================================== */
  function syncFromPrice() {
    var price = val('homePrice');
    var pct = val('downPaymentPct');
    var down = price * (pct / 100);
    setVal('downPayment', down);
    setVal('loanAmount', Math.max(0, price - down));
    $('downPaymentRange').value = Math.min(50, pct);
  }

  function syncFromDownAmount() {
    var price = val('homePrice');
    var down = Math.min(val('downPayment'), price);
    var pct = price > 0 ? (down / price) * 100 : 0;
    setVal('downPaymentPct', pct, 2);
    setVal('loanAmount', Math.max(0, price - down));
    $('downPaymentRange').value = Math.min(50, pct);
  }

  function syncFromDownPct() {
    var price = val('homePrice');
    var pct = Math.min(100, Math.max(0, val('downPaymentPct')));
    var down = price * (pct / 100);
    setVal('downPayment', down);
    setVal('loanAmount', Math.max(0, price - down));
    $('downPaymentRange').value = Math.min(50, pct);
  }

  function syncFromLoanAmount() {
    var price = val('homePrice');
    var loan = Math.min(val('loanAmount'), price);
    var down = Math.max(0, price - loan);
    setVal('downPayment', down);
    setVal('downPaymentPct', price > 0 ? (down / price) * 100 : 0, 2);
    $('downPaymentRange').value = price > 0 ? Math.min(50, (down / price) * 100) : 0;
  }

  /** Turn PMI on automatically when the borrower drops below 20% down. */
  function autoTogglePmi() {
    var price = val('homePrice');
    var loan = val('loanAmount');
    if (price <= 0) return;
    var ltv = (loan / price) * 100;
    var sw = $('pmiEnabled');
    var on = sw.getAttribute('aria-checked') === 'true';
    if (ltv > 80 && !on && !sw.dataset.userSet) setSwitch(sw, true);
    if (ltv <= 80 && on && !sw.dataset.userSet) setSwitch(sw, false);
    $('pmiFields').hidden = sw.getAttribute('aria-checked') !== 'true';
  }

  function setSwitch(sw, on) {
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  /* ==================================================================
   * Recalculation orchestration
   * ================================================================== */
  function recalcAll() {
    autoTogglePmi();
    try { renderPayment(); } catch (e) { console.error('payment', e); }
    try { renderExtra(); } catch (e) { console.error('extra', e); }
    try { renderSide(); } catch (e) { console.error('side', e); }
    try { renderRefi(); } catch (e) { console.error('refi', e); }
    try { renderCompare(); } catch (e) { console.error('compare', e); }
    writeUrl();
  }
  var recalcSoon = debounce(recalcAll, 160);

  /* ==================================================================
   * Share links — the whole scenario lives in the URL
   * ================================================================== */
  var URL_FIELDS = ['homePrice', 'downPayment', 'loanAmount', 'interestRate', 'startYear',
    'propertyTax', 'homeInsurance', 'hoaMonthly', 'otherMonthly', 'pmiRate', 'appreciation',
    'escrowInflation', 'loanCosts', 'extraMonthly', 'extraStartMonth', 'extraAnnual', 'sidePayment',
    'curBalance', 'curRate', 'curRemaining', 'newRate', 'closingCosts', 'points', 'cashOut',
    'yearsInHome', 'investReturn'];

  function writeUrl() {
    var p = new URLSearchParams();
    URL_FIELDS.forEach(function (id) {
      var elx = $(id);
      if (elx && elx.value !== '') p.set(id, parseNum(elx.value));
    });
    p.set('term', $('loanTerm').value);
    p.set('sm', $('startMonth').value);
    p.set('nt', $('newTerm').value);
    p.set('pmi', $('pmiEnabled').getAttribute('aria-checked'));
    p.set('bw', $('biweekly').getAttribute('aria-checked'));
    p.set('roll', $('rollIn').getAttribute('aria-checked'));
    p.set('cons', $('consolidateDebts').getAttribute('aria-checked'));
    if (state.debts.length) {
      p.set('debts', state.debts.map(function (d) {
        return [encodeURIComponent(d.creditor || ''), parseNum(d.balance),
          parseNum(d.payment), parseNum(d.rate)].join('.');
      }).join('~'));
    }
    p.set('tm', state.taxMode);
    if (state.oneTime.length) {
      p.set('ot', state.oneTime.map(function (o) {
        return [parseNum(o.amount), o.year, o.month].join('.');
      }).join('~'));
    }
    history.replaceState(null, '', '#' + p.toString());
  }

  function readUrl() {
    if (!location.hash || location.hash.length < 2) return false;
    var p = new URLSearchParams(location.hash.slice(1));
    if (![].concat.apply([], [p.keys()]).length && !p.get('homePrice')) { /* fallthrough */ }
    var applied = false;
    URL_FIELDS.forEach(function (id) {
      if (!p.has(id)) return;
      var elx = $(id);
      if (!elx) return;
      var n = parseNum(p.get(id));
      elx.value = /Rate|rate|points|appreciation|Inflation|Return|Remaining|yearsInHome/.test(id)
        ? n : num0.format(n);
      applied = true;
    });
    if (p.has('term')) $('loanTerm').value = p.get('term');
    if (p.has('sm')) $('startMonth').value = p.get('sm');
    if (p.has('nt')) $('newTerm').value = p.get('nt');
    if (p.has('tm')) {
      state.taxMode = p.get('tm');
      $$('[data-taxmode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.dataset.taxmode === state.taxMode ? 'true' : 'false');
      });
    }
    if (p.has('pmi')) { setSwitch($('pmiEnabled'), p.get('pmi') === 'true'); $('pmiEnabled').dataset.userSet = '1'; }
    if (p.has('bw')) setSwitch($('biweekly'), p.get('bw') === 'true');
    if (p.has('roll')) setSwitch($('rollIn'), p.get('roll') === 'true');
    if (p.has('cons')) setSwitch($('consolidateDebts'), p.get('cons') === 'true');
    if (p.has('debts')) {
      state.debts = p.get('debts').split('~').map(function (chunk) {
        var parts = chunk.split('.');
        return {
          creditor: decodeURIComponent(parts[0] || ''),
          balance: parts[1] || '', payment: parts[2] || '', rate: parts[3] || ''
        };
      });
      renderDebtList();
    }
    if (p.has('ot')) {
      state.oneTime = p.get('ot').split('~').map(function (chunk) {
        var parts = chunk.split('.');
        return { amount: parseNum(parts[0]), year: parseInt(parts[1], 10), month: parseInt(parts[2], 10) };
      }).filter(function (o) { return isFinite(o.year); });
      renderOneTimeList();
    renderDebtList();
    }
    if (p.has('sidePayment')) state.sideTouched = true;
    if (p.has('customTermMonths')) $('customTermMonths').value = p.get('customTermMonths');
    $('customTermField').hidden = $('loanTerm').value !== 'custom';
    return applied;
  }

  /* ==================================================================
   * Wiring
   * ================================================================== */
  function initMonthSelects() {
    var now = F.todayYM();
    ['startMonth', 'origStartMonth', 'extraAnnualMonth'].forEach(function (id) {
      var sel = $(id);
      if (!sel) return;
      sel.innerHTML = monthOptions(id === 'extraAnnualMonth' ? 11 : now.month);
    });
    $('startYear').value = now.year;
    $('origStartYear').value = now.year - 3;
  }

  function initTabs() {
    var tabs = $$('.tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var panelId = tab.getAttribute('aria-controls');
        tabs.forEach(function (t) {
          var selected = t === tab;
          t.setAttribute('aria-selected', selected ? 'true' : 'false');
          $(t.getAttribute('aria-controls')).hidden = !selected;
        });
        state.activeTab = panelId.replace('panel-', '');
        // Charts inside a hidden panel measured zero width — redraw now that it's visible.
        window.dispatchEvent(new Event('resize'));
        recalcAll();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      tab.addEventListener('keydown', function (e) {
        var i = tabs.indexOf(tab);
        if (e.key === 'ArrowRight') { tabs[(i + 1) % tabs.length].focus(); tabs[(i + 1) % tabs.length].click(); }
        if (e.key === 'ArrowLeft') { tabs[(i - 1 + tabs.length) % tabs.length].focus(); tabs[(i - 1 + tabs.length) % tabs.length].click(); }
      });
    });
  }

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem('gem-theme'); } catch (e) { /* private mode */ }
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);

    $('btnTheme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('gem-theme', next); } catch (e) { /* ignore */ }
      recalcAll();  // charts read CSS variables, so re-render them for the new palette
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    clearColorCache();
    $('iconSun').hidden = theme === 'dark';
    $('iconMoon').hidden = theme !== 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#060f17' : '#0b2a3c');
  }

  function initSwitches() {
    $$('.switch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        setSwitch(sw, sw.getAttribute('aria-checked') !== 'true');
        if (sw.id === 'pmiEnabled') {
          sw.dataset.userSet = '1';
          $('pmiFields').hidden = sw.getAttribute('aria-checked') !== 'true';
        }
        recalcAll();
      });
    });
  }

  function initSegmented() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.segmented button, [data-schedview], [data-accelview], [data-sideview], [data-taxmode], [data-curmode], [data-sidequick]');
      if (!btn) return;

      if (btn.dataset.sidequick) {
        var minPay = cache.side ? cache.side.minPay : 0;
        $('sidePayment').value = num0.format(Math.round(minPay + parseNum(btn.dataset.sidequick)));
        state.sideTouched = true;
        recalcAll();
        return;
      }

      var group = btn.closest('.segmented');
      if (group) {
        $$('button', group).forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
        btn.setAttribute('aria-pressed', 'true');
      }

      if (btn.dataset.schedview) { state.schedView = btn.dataset.schedview; renderSchedule(cache.base); return; }
      if (btn.dataset.accelview) { state.accelView = btn.dataset.accelview; $('accelScheduleWrap').innerHTML = scheduleTableHTML(cache.compare.accelerated, state.accelView); return; }
      if (btn.dataset.sideview) { state.sideView = btn.dataset.sideview; renderSideTable(cache.side.base, cache.side.accel); return; }
      if (btn.dataset.taxmode) {
        var wasPct = state.taxMode === 'percent';
        state.taxMode = btn.dataset.taxmode;
        var price = val('homePrice');
        // Convert the value in the box so the dollars stay the same when switching.
        if (state.taxMode === 'percent' && !wasPct && price > 0) {
          setVal('propertyTax', (val('propertyTax') / price) * 100, 3);
        } else if (state.taxMode === 'amount' && wasPct) {
          setVal('propertyTax', price * (val('propertyTax') / 100));
        }
        recalcAll();
        return;
      }
      if (btn.dataset.curmode) {
        state.curMode = btn.dataset.curmode;
        $('curBalanceMode').hidden = state.curMode !== 'balance';
        $('curOriginalMode').hidden = state.curMode !== 'original';
        recalcAll();
      }
    });
  }

  function initInputs() {
    // Linked price / down payment / loan amount
    $('homePrice').addEventListener('input', function () { syncFromPrice(); recalcSoon(); });
    $('downPayment').addEventListener('input', function () { syncFromDownAmount(); recalcSoon(); });
    $('downPaymentPct').addEventListener('input', function () { syncFromDownPct(); recalcSoon(); });
    $('loanAmount').addEventListener('input', function () { syncFromLoanAmount(); recalcSoon(); });
    $('downPaymentRange').addEventListener('input', function () {
      setVal('downPaymentPct', parseNum(this.value), 2);
      syncFromDownPct();
      recalcSoon();
    });

    $('extraMonthlyRange').addEventListener('input', function () {
      $('extraMonthly').value = num0.format(parseNum(this.value));
      recalcSoon();
    });
    $('extraMonthly').addEventListener('input', function () {
      $('extraMonthlyRange').value = Math.min(2000, parseNum(this.value));
      recalcSoon();
    });

    $('yearsInHomeRange').addEventListener('input', function () {
      $('yearsInHome').value = this.value; recalcSoon();
    });
    $('yearsInHome').addEventListener('input', function () {
      $('yearsInHomeRange').value = Math.min(30, Math.max(1, parseNum(this.value)));
      recalcSoon();
    });

    $('sidePayment').addEventListener('input', function () { state.sideTouched = true; recalcSoon(); });

    $('loanTerm').addEventListener('change', function () {
      $('customTermField').hidden = this.value !== 'custom';
      recalcAll();
    });

    // Everything else: recalculate on any change.
    $$('input, select').forEach(function (elx) {
      if (elx.type === 'range') return;
      if (['homePrice', 'downPayment', 'downPaymentPct', 'loanAmount', 'extraMonthly',
        'yearsInHome', 'sidePayment', 'loanTerm'].indexOf(elx.id) >= 0) return;
      if (elx.dataset.sc || elx.dataset.ot) return;
      elx.addEventListener('input', recalcSoon);
      elx.addEventListener('change', recalcSoon);
    });

    // Currency fields get comma formatting on blur.
    ['homePrice', 'downPayment', 'loanAmount', 'propertyTax', 'homeInsurance', 'hoaMonthly',
      'otherMonthly', 'extraMonthly', 'extraAnnual', 'sidePayment', 'curBalance', 'origAmount',
      'closingCosts', 'cashOut', 'curPaymentOverride'].forEach(function (id) {
        var elx = $(id);
        if (elx) attachCurrencyFormatting(elx);
      });

    // One-time payment rows (delegated — the list is re-rendered)
    $('btnAddOneTime').addEventListener('click', function () {
      var now = F.todayYM();
      state.oneTime.push({ amount: 5000, year: now.year + 1, month: now.month });
      renderOneTimeList();
    renderDebtList();
      recalcAll();
    });
    $('oneTimeList').addEventListener('input', handleOneTimeChange);
    $('oneTimeList').addEventListener('change', handleOneTimeChange);
    $('oneTimeList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-ot="remove"]');
      if (!btn) return;
      state.oneTime.splice(parseInt(btn.dataset.i, 10), 1);
      renderOneTimeList();
    renderDebtList();
      recalcAll();
    });

    // Debts (delegated — the list is re-rendered on add/remove)
    $('btnAddDebt').addEventListener('click', function () {
      state.debts.push({ creditor: '', balance: '', payment: '', rate: '' });
      renderDebtList();
      var inputs = $$('#debtList [data-debt="creditor"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
      recalcAll();
    });
    $('debtList').addEventListener('input', handleDebtChange);
    $('debtList').addEventListener('focusout', formatDelegatedCurrency);
    $('oneTimeList').addEventListener('focusout', formatDelegatedCurrency);
    $('debtList').addEventListener('change', handleDebtChange);
    $('debtList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-debt="remove"]');
      if (!btn) return;
      state.debts.splice(parseInt(btn.dataset.i, 10), 1);
      renderDebtList();
      recalcAll();
    });

    // Scenario inputs (delegated)
    $('scenarioInputs').addEventListener('input', handleScenarioChange);
    $('scenarioInputs').addEventListener('change', handleScenarioChange);

    $('btnGoalSeek').addEventListener('click', runGoalSeek);

    $('btnLoadFromMain').addEventListener('click', function () {
      var cfg = loanConfig();
      scenarios[0] = { name: 'Your loan', amount: cfg.principal, rate: cfg.annualRate, term: cfg.termMonths, extra: 0 };
      scenarios[1] = { name: '15-year fixed', amount: cfg.principal, rate: Math.max(0, cfg.annualRate - 0.75), term: 180, extra: 0 };
      scenarios[2] = {
        name: 'Your loan + extra', amount: cfg.principal, rate: cfg.annualRate,
        term: cfg.termMonths, extra: val('extraMonthly')
      };
      renderScenarioInputs();
      renderCompare();
    });

    $('btnReset').addEventListener('click', function () {
      location.hash = '';
      location.reload();
    });
  }

  function handleOneTimeChange(e) {
    var elx = e.target.closest('[data-ot]');
    if (!elx || elx.dataset.ot === 'remove') return;
    var i = parseInt(elx.dataset.i, 10);
    if (!state.oneTime[i]) return;
    var key = elx.dataset.ot;
    state.oneTime[i][key] = key === 'amount' ? parseNum(elx.value) : parseInt(elx.value, 10);
    recalcSoon();
  }

  /** Comma-format a currency field in a dynamically rendered row on blur. */
  function formatDelegatedCurrency(e) {
    var elx = e.target;
    var key = elx.dataset ? (elx.dataset.debt || elx.dataset.ot) : null;
    if (key !== 'balance' && key !== 'payment' && key !== 'amount') return;
    if (elx.value.trim() === '') return;
    var n = parseNum(elx.value);
    elx.value = num0.format(Math.round(n * 100) / 100);
    if (elx.dataset.debt) {
      var i = parseInt(elx.dataset.i, 10);
      if (state.debts[i]) state.debts[i][key] = elx.value;
    }
  }

  function handleDebtChange(e) {
    var elx = e.target.closest('[data-debt]');
    if (!elx || elx.dataset.debt === 'remove') return;
    var i = parseInt(elx.dataset.i, 10);
    if (!state.debts[i]) return;
    state.debts[i][elx.dataset.debt] = elx.value;
    recalcSoon();
  }

  function handleScenarioChange(e) {
    var elx = e.target.closest('[data-sc]');
    if (!elx) return;
    var i = parseInt(elx.dataset.i, 10);
    var key = elx.dataset.sc;
    scenarios[i][key] = key === 'name' ? elx.value
      : key === 'term' ? parseInt(elx.value, 10)
        : parseNum(elx.value);
    renderCompare();
  }

  function initExports() {
    $('btnExportSchedule').addEventListener('click', function () {
      download('amortization-schedule.csv', scheduleCSV(cache.base, 'Amortization schedule'));
    });
    $('btnExportAccel').addEventListener('click', function () {
      download('amortization-with-extra-payments.csv',
        scheduleCSV(cache.compare.accelerated, 'Amortization with extra payments'));
    });
    $('btnExportSide').addEventListener('click', function () {
      var s = cache.side;
      download('side-by-side-comparison.csv', sideBySideCSV(s.base, s.accel, s.chosen));
    });
    $('btnPrint').addEventListener('click', function () { window.print(); });

    $('btnShare').addEventListener('click', function () {
      writeUrl();
      var url = location.href;
      var done = function () {
        var old = $('btnShare').querySelector('.btn-text');
        if (!old) return;
        var prev = old.textContent;
        old.textContent = 'Copied!';
        setTimeout(function () { old.textContent = prev; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link:', url); });
      } else {
        window.prompt('Copy this link:', url);
      }
    });
  }

  function initBranding() {
    $('ctaPrimary').href = CONFIG.quoteUrl;
    $('ctaSecondary').href = CONFIG.contactUrl;
    renderLicensing();
  }

  /**
   * Renders the licensing block. Any field left blank in CONFIG is skipped, and
   * a visible reminder is shown while the NMLS identifiers are still unset so an
   * unconfigured build cannot quietly ship without them.
   */
  function renderLicensing() {
    var box = $('licensing');
    if (!box) return;
    var lines = [];

    var who = [];
    if (CONFIG.loanOfficer) who.push(esc(CONFIG.loanOfficer));
    if (CONFIG.loanOfficerNmls) who.push('NMLS #' + esc(CONFIG.loanOfficerNmls));
    if (who.length) lines.push('<strong>' + who.join(' · ') + '</strong>');

    var firm = [];
    if (CONFIG.company) firm.push(esc(CONFIG.company));
    if (CONFIG.companyNmls) firm.push('Company NMLS #' + esc(CONFIG.companyNmls));
    if (firm.length) lines.push(firm.join(' · '));

    if (CONFIG.dba) lines.push(esc(CONFIG.dba));
    if (CONFIG.address) lines.push(esc(CONFIG.address));
    if (CONFIG.phone) lines.push(esc(CONFIG.phone));
    if (CONFIG.statesLicensed) lines.push(esc(CONFIG.statesLicensed));
    if (CONFIG.stateLicenseIds) lines.push(esc(CONFIG.stateLicenseIds));
    if (CONFIG.extraDisclosures) lines.push(esc(CONFIG.extraDisclosures));

    if (CONFIG.consumerAccessUrl) {
      lines.push('Verify any license at <a href="' + esc(CONFIG.consumerAccessUrl) +
        '" target="_blank" rel="noopener noreferrer">NMLS Consumer Access</a>.');
    }

    if (!CONFIG.loanOfficerNmls && !CONFIG.companyNmls) {
      lines.unshift('<span class="license-todo">Set your NMLS identifiers and licensing ' +
        'detail in <code>CONFIG</code> at the top of <code>assets/js/app.js</code> ' +
        'before publishing this page.</span>');
    }

    box.innerHTML = lines.join('<br>');
  }

  /* ==================================================================
   * Boot
   * ================================================================== */
  function init() {
    initMonthSelects();
    initTabs();
    initTheme();
    initSwitches();
    initSegmented();
    initInputs();
    initExports();
    initBranding();
    renderScenarioInputs();
    renderOneTimeList();
    renderDebtList();

    var fromUrl = readUrl();
    if (!fromUrl) syncFromPrice();

    recalcAll();

    // Panels start hidden; force a chart re-measure once layout settles.
    window.addEventListener('load', function () {
      setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 60);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
