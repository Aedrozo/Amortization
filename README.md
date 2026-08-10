# Gem Home Team — Mortgage Calculator Suite

A complete, client-side mortgage amortization, prepayment and refinance calculator,
branded for **Gem Home Team Mortgage Lending × NEO Home Loans**.

No build step, no framework, no dependencies, no network calls. Three JS files, one
stylesheet, one HTML page. Drop it on any static host, or paste it into a CMS.

---

## The five tools

### 1. Payment & Schedule
The full picture of a purchase loan.

- Home price, down payment (dollars **or** percent — all three fields stay in sync), loan amount
- Rate, term (30/25/20/15/10 or any custom month count), first-payment month
- Property tax entered as an annual dollar amount **or** a percentage of the price
- Homeowners insurance, HOA dues, and any other monthly cost
- **PMI** with automatic cancellation at 78% LTV (or 80% on request), and it switches
  itself on when you drop below 20% down
- Optional home appreciation and escrow inflation assumptions
- Donut breakdown of the true PITI payment
- Total interest, total of payments, total cost of ownership, and the first payment's
  principal/interest split
- Balance, equity and cumulative-interest curves; principal vs. interest by year
- **Milestones**: when principal overtakes interest, when you hit 20% equity, when PMI
  falls off, the halfway point, and payoff
- Full amortization schedule, annual or monthly, exportable to CSV

### 2. Extra Payments
Everything that shortens a loan, and what each is worth.

- Extra every month (with a start month, so you can begin later)
- **Biweekly** payments (the 13th-payment equivalent)
- An annual lump sum landing in whichever calendar month you choose
- Unlimited one-time lump sums on specific dates
- Round the payment up to the next $50/$100/$250/$500
- Interest saved, time saved, PMI saved, and the return on every extra dollar
- A "payoff race" chart against the minimum-payment schedule
- A what-if ladder for $50 / $100 / $200 / $300 / $500 / $1,000 a month
- **Goal seek**: name a payoff date and it solves for the extra payment required

### 3. Side-by-Side
The minimum payment and a payment you choose, read straight across.

- Enter a total P&I payment, or use the +$100/+$250/+$500/+$1k shortcuts
- Two summary columns: payment, payoff date, and term for each
- A single paired table — one row per period with **both** loans' payment, interest and
  balance, plus how much less you owe at that point
- Combined CSV export of both schedules
- Payments below the required minimum are caught and explained, not silently accepted

### 4. Refinance
Whether it is actually worth it.

- Enter your current balance and rate, **or** the original loan terms and we derive the
  balance, remaining term and payment for you
- New rate, term, closing costs, discount points, cash-out, and roll-costs-into-the-loan
- **Break-even on interest** — the headline number, and the honest one. See below.
- **Payment-based break-even** (costs ÷ monthly payment drop) shown alongside it, clearly
  labelled, so you can see the difference between the two framings
- **Total-cost crossover** that also counts the balance you still owe
- Estimated **APR** on the new loan under Regulation Z
- A plain-English verdict judged against how long you plan to stay
- Lifetime interest comparison, and the opportunity cost of investing the savings instead
- **Debt consolidation** — see below
- **"Keep your old payment"** — refinance to the lower rate but keep writing the same
  check, and see how much earlier the loan dies
- Discount-point buydown break-even

#### Break-even is measured on interest, not on the payment

Most calculators divide closing costs by the drop in the monthly payment. That overstates
the benefit, because part of a lower payment is often just **paying less principal** — and
principal isn't a cost. It buys down your balance and comes back to you as equity when you
sell. Interest is the only part of a payment you never see again.

So the headline break-even here is the month at which **cumulative interest avoided**
covers what the refinance cost. The difference is not academic:

> A $280,000 balance with 20 years left at 6.00%, refinanced to 5.90% over a fresh 30-year
> term with $9,000 in costs. The payment drops, so the payment-based method reports a
> break-even and calls it a win. Measured on interest, it **never** breaks even — the
> "savings" were the term extension, not a better rate.

That case is pinned down by a test (`a term extension at a barely-better rate never repays
its cost in interest`), as is the guarantee that the interest-based figure is never more
optimistic than the payment-based one.

#### Debt consolidation

Add each debt — creditor, balance, monthly payment and rate — and a single switch decides
whether those balances are paid off at closing and folded into the new loan.

The result is a three-way read on the same month:

| | Today | Refinance only | Refinance + consolidate |
|---|---|---|---|
| Monthly outlay | $3,543 | $3,260 | $2,383 |
| | baseline | −$283/mo | **−$1,161/mo** |

Alongside it: the saving attributable to consolidating *alone* (separated from what the
refinance was going to save anyway), the total balance rolled in, and the **blended rate** —
the balance-weighted average across the mortgage and every debt, which is the number that
shows why a 6% mortgage sitting next to 25% cards is not a 6% problem.

Each debt is also listed with how long it takes to clear at its current payment and how
much interest that costs. A payment too small to cover its own interest is flagged as
`never at this payment` rather than being turned into a fake payoff date.

**The tool argues with itself here, deliberately.** Rolling five-year debt into a thirty-year
mortgage almost always lowers the payment and raises the lifetime interest. Both numbers are
shown with equal weight — in the example above, $1,161/month saved and about $53,000 more
interest — so the conversation with the borrower is an informed one. Where the debt is
expensive enough or the new term short enough that consolidating wins on interest too, the
callout says so instead.

The include/exclude switch drives the whole tab, not just this card: the new loan amount,
payment, APR and break-even all move with it. The three-column comparison always shows both
paths regardless, so the choice stays visible.

### 5. Compare Loans
Three scenarios side by side — 15 vs. 30 year, two lenders, or the same loan with and
without extra payments. Balance curves on one axis and a head-to-head metrics table.

### Throughout
Light/dark theme, keyboard-accessible tabs, print/PDF stylesheet, and a **Share** button
that encodes the entire scenario in the URL so you can send a client their exact numbers.

---

## Running it locally

```bash
npm start                 # python3 -m http.server 8080  -> http://localhost:8080
# or
npx serve .
# or just open index.html directly in a browser
```

## Going live

### GitHub Pages
`.github/workflows/pages.yml` publishes the site on every push to the default
branch. It runs the engine tests first, so a change that breaks the math never
reaches the live site.

**One-time setup, required.** The workflow asks GitHub to enable Pages, but the
Actions token is only permitted to *deploy* to Pages, not to *create* the Pages
site — that attempt fails with `Resource not accessible by integration`. Enable
it once by hand:

> **Settings → Pages → Build and deployment → Source: GitHub Actions**

then re-run the workflow. Every push after that deploys on its own. Until it is
enabled the workflow still builds and tests, and prints those instructions in
the log rather than failing silently.

The published site is `https://<owner>.github.io/<repo>/`, and it also serves
`/standalone.html` — the single-file build, handy to link or hand to a web team.

### Embedding in an existing website
```bash
npm run build             # -> dist/index.html, one self-contained file
npm run build -- dist/embed.html --fragment
```
`dist/index.html` is a complete page: upload it anywhere, or point a domain at
it. Everything is inlined — CSS, all three scripts, the favicon — so there is
nothing else to upload and no path to get wrong.

`--fragment` drops the `<!doctype>/<html>/<head>/<body>` wrapper and emits just
`<title>`, `<style>` and the body content. That is the form a CMS "custom HTML"
block wants (WordPress Custom HTML, Squarespace Code Block, Wix Embed, HubSpot
rich text).

To embed in a page you do not control the markup of, host `dist/index.html`
somewhere and iframe it:
```html
<iframe src="https://your-host/calculator.html"
        style="width:100%;height:1400px;border:0" loading="lazy"
        title="Mortgage calculator"></iframe>
```

### Verifying a build
```bash
npm run test:dist         # builds, then runs all 45 browser tests against the bundle
```
The bundle is held to exactly the same test suite as the multi-file site, so a
packaging mistake fails loudly rather than shipping a subtly broken page.

## Tests

```bash
npm test          # 71 engine tests (pure math, no browser)
npm run test:ui   # 45 browser tests (needs Playwright + a server on :8080)
npm run test:all
```

The engine suite covers the closed-form payment/balance formulas, schedule integrity
(every row reconciles, principal repaid equals principal borrowed, the balance lands on
exactly zero), every extra-payment mode, PMI cancellation, escrow, APR under Reg Z, both
refinance break-even measures including the term-reset trap, debt consolidation, and a
250-case fuzz sweep
across loan sizes, rates and terms. The browser suite drives the real page: it asserts the
rendered figures match the engine to the cent, that charts draw with resolved colours, that
a below-minimum payment is rejected, that a bad refinance is called out, that toggling debt
consolidation moves the balances in and out of the loan, that the required disclosures are
present, and that no viewport from 320px to 1280px scrolls horizontally.

`tests/ui.test.mjs` launches Chromium from `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Override with `CHROMIUM_PATH=/path/to/chrome` if your Playwright install manages its own.

---

## Customising

### Calls to action and licensing — READ THIS BEFORE PUBLISHING
Top of `assets/js/app.js`. Every field left blank is omitted from the footer, and while
both NMLS IDs are empty the page renders a visible amber warning so an unconfigured build
cannot ship quietly.

```js
var CONFIG = {
  quoteUrl: '#', contactUrl: '#',
  loanOfficer: '', loanOfficerNmls: '',
  company: '', companyNmls: '', dba: '',
  address: '', phone: '',
  statesLicensed: '', stateLicenseIds: '',
  consumerAccessUrl: 'https://www.nmlsconsumeraccess.org/',
  extraDisclosures: ''
};
```

### The logo
The Gem Home Team and NEO lockups are **reconstructed as inline SVG** in the `<defs>`
block at the top of `index.html` (`#mark-gem`, `#mark-neo`) so they stay sharp at any
size and recolour themselves in dark mode. To use your official artwork instead, replace
the `<use href="#mark-gem">` elements with an `<img>` pointing at your file — and supply a
light-mode and dark-mode version, since the current marks invert automatically via the
`--brand-ink` / `--brand-knockout` tokens.

### Colours
All brand colour lives in the `:root` token block at the top of `assets/css/styles.css`.
The navy is `--navy-800` and the cyan is `--cyan-500`; change those two and the whole
interface follows, charts included.

### Embedding
The page is self-contained and requests nothing external — no webfonts, no CDNs, no
analytics. It works offline, inside an iframe, and behind a corporate firewall.

---

## Regulatory notes

**This is scaffolding, not a compliance opinion.** I am not your compliance officer and
nothing here is legal advice. Have counsel or your compliance team review the rendered page
against your state licences and your company's marketing-review process before it goes live.

What is built in:

- **NMLS identifiers** for both the originator and the company, plus DBA, licensed address,
  states licensed, state licence numbers, and a link to NMLS Consumer Access — all driven
  from `CONFIG`. The page warns visibly while the IDs are unset.
- **APR** is computed under Regulation Z (12 CFR 1026.22) wherever you supply prepaid
  finance charges, with explicit language that a note rate is not an APR — the most common
  Reg Z advertising trap for a rate-quoting tool (12 CFR 1026.24).
- **Not an offer / not a commitment to lend / subject to credit approval**, and an explicit
  statement that the tool is not a Loan Estimate.
- **Equal Housing Opportunity** logo and statement, plus ECOA non-discrimination language.
- Disclosure of the modelling limits: no ARM adjustments, interest-only, temporary
  buydowns, balloons or prepayment penalties; escrow figures are estimates; MI cancellation
  follows the HPA but servicer rules and FHA/lender-paid MI may differ.
- A statement that nothing is collected or transmitted, which is true — there are no
  network calls of any kind.

What you still have to do:

1. Fill in every `CONFIG` licensing field.
2. Confirm which state-specific disclosures apply to you and add them via
   `extraDisclosures`.
3. Run it through your marketing/advertising review and keep a record, since advertising
   retention rules apply to web content too.
4. If you add live rate quotes or lead capture later, that changes the analysis
   substantially — re-review before doing so.

---

## How the math works

Standard monthly-accrual amortization: `payment = P·r / (1 − (1+r)^−n)`, with interest
accruing on the outstanding balance each month.

A few decisions worth knowing about:

- **Money is handled in integer cents.** The rounding drift that leaves other online
  calculators ending on a $0.03 balance can't occur.
- **The final payment absorbs the rounding residual**, the way a servicer does, so a
  30-year loan is exactly 360 payments — not 360 plus a stray $1.45 in month 361.
- **Extra payments are capped at the remaining balance.** You can never overpay.
- **A payment below the first month's interest is refused** rather than rendered as a
  fake schedule that never pays off.
- **Biweekly** is modeled as an extra 1/12 of a payment each month — 26 half-payments a
  year is one extra payment a year, and that is how servicers apply the accumulated
  halves. Slightly conservative versus a true 26-period accrual.
- **PMI** is priced against the original loan amount and cancelled against the original
  property value, per the Homeowners Protection Act.
- **Break-even on interest** compares cumulative interest accrued on each loan. Principal
  is deliberately excluded — it is equity, not cost.
- **Consolidation** sizes the new loan as `balance + cash-out + debt payoff`, with closing
  costs solved through the points circularity when they are rolled in. Each debt's payoff
  horizon comes from the same `monthsToPayoff` used elsewhere, so a payment that cannot
  cover its interest returns "never" instead of a fabricated date.
- **Total-cost crossover** compares `payments made + balance still owed` for each path, so
  extending the term is charged for rather than treated as free savings.
- **APR** follows Regulation Z (12 CFR 1026.22): the rate that discounts the payment
  stream back to the amount financed (loan amount less prepaid finance charges).

Escrow figures are estimates. The calculator does not model prepaid interest, escrow
reserves, per-diem charges, ARM adjustments, or interest-only periods.

---

## Files

```
index.html                 markup, brand marks, all five panels
assets/css/styles.css      design tokens, components, responsive + print
assets/js/finance.js       the engine — pure functions, no DOM (also runs in Node)
assets/js/charts.js        dependency-free SVG charts with hover crosshairs
assets/js/app.js           UI wiring, rendering, CSV export, URL sharing
tests/finance.test.mjs     engine tests
tests/ui.test.mjs          browser tests
```

`finance.js` has no DOM dependency and exports through both CommonJS and `window`, which
is why the same code that runs the page is what the test suite exercises.

---

For illustration only. Not a commitment to lend. Equal Housing Opportunity.
