# Pricing & market intelligence

Standing research job: recurring scans of x402/agent-economy pricing and
comparable PII/data-sanitization products, kept here as a dated log so
pricing decisions are backed by real numbers instead of gut feel.

**Scope:** pricing and honest positioning only. This does **not** touch who
gets pitched or how the outreach/growth engine behaves — those are governed
separately by the anti-spam, buy-signal-required rules added in the security
PR (`growth.js`/`agent-guard.js`), and this job doesn't loosen them.

**Autonomy level: 1 (report only).** Nothing in this file's process changes
`PRICE`, code, or config automatically — see "Autonomy roadmap" at the
bottom for the planned path to level 2 (propose a PR) and level 3
(auto-apply).

---

## 2026-09-19 — Initial pass

### The core problem, quantified

- Coinbase's CDP facilitator — the mainnet path this repo documents in
  `GO_LIVE.md` — charges **$0.001 per on-chain settlement** once a seller is
  past the first 1,000 free transactions/month.
- This repo's default `PRICE` (shown in both the testnet and mainnet
  examples in `GO_LIVE.md`) is **also $0.001**.
- Published x402-seller guidance states the failure mode plainly: *"A $0.001
  ticket that costs $0.001 to settle after the free tier is a 100%
  Facilitator take before gas, infra, or model cost."* The same source
  recommends pricing at **≥10× the facilitator's per-settlement cost**
  (so the facilitator is ≤10% of the ticket) when using standard
  (`exact`) per-transaction settlement — or adopting batch-settlement,
  which amortizes the flat $0.001 across many payments and can justify a
  lower headline price instead.

### A second, distinct pricing bug: the batch route

`/api/sanitize/batch` (`x402.js`) sanitizes 1–10 texts per call but settles
at the **exact same `config.price`** as the single-text route — `makeRoute`
applies one flat price to every route, batch included. A buyer who always
uses the batch endpoint for 10 items pays the same $0.001 as a buyer
sanitizing 1 item: on top of the facilitator-margin problem above, this is
roughly a 90% effective discount for the app's heaviest users.

### Comparable market pricing (positioning, not just cost recovery)

- **x402 ecosystem (2026):** 112+ APIs across 11 categories, 165M+
  transactions, ~$50M+ volume, 480K+ agents transacting. Comparable
  general-purpose x402 APIs have been seen listed around **~$0.005/request**.
- **Non-x402 PII/redaction competitors** (traditional pricing — useful as an
  outside anchor, not a direct comparison since they carry no x402
  settlement overhead):
  - AWS Comprehend PII detection: ~$0.0001 per 100 characters
  - Apify PII Redactor: ~$0.0008 per 10k characters
  - Nutrient AI redaction: 0.05 credits/page
  - SafeRedact: $499 per 1,000 files (job-based, not per-call)
  - Redactable: subscription tiers ($12/day pass, $29/mo, $99/yr), not per-call

### Recommendations (not applied — for review)

1. Raise `PRICE` to at least **$0.01** (10× the facilitator fee) for the
   single-text route if staying on `exact` per-transaction settlement —
   the single highest-leverage change, and it directly matches published
   x402 seller guidance.
2. Price `/api/sanitize/batch` **per item** (e.g. single-price × item count,
   or a flat batch price ≥10× the single price) instead of reusing the flat
   single-call price — it's currently the most underpriced route in the app.
3. Consider batch-settlement (amortizing the facilitator's flat fee off-chain
   across many payments, one on-chain claim) as an alternative or
   complement if a sub-cent headline price matters for competitive
   positioning against non-x402 competitors.
4. None of this needs new credentials or infrastructure — it's a `PRICE`
   env var change plus a small pricing-logic change in `x402.js`.

### Sources

- [CDP Facilitator — Coinbase Developer Docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)
- [How to Price an x402 API in USDC (2026)](https://stablecoininsider.org/how-to-price-an-x402-api-in-usdc/)
- [Coinbase x402 Facilitator to Charge $0.001 per Settlement Starting January 2026 — KuCoin](https://www.kucoin.com/news/flash/coinbase-x402-facilitator-to-charge-0-001-per-settlement-starting-january-2026)
- [x402 Bazaar — AI Agent API Marketplace](https://www.x402bazaar.org/)
- [Coinbase presents x402 Bazaar — Cryptonomist](https://en.cryptonomist.ch/2025/09/11/coinbase-presents-x402-bazaar-the-ai-agents-marketplace-they-pay-apis-in-200-ms-and-configure-themselves/)
- [Redaction Software Cost — Pricing Comparison for 2026 — SafeRedact](https://saferedact.app/pages/redaction-software-cost)
- [PII Redactor API — Apify](https://apify.com/nibble/pii-redactor/api)

---

## Autonomy roadmap

- **Now (level 1):** this file, refreshed on a recurring schedule,
  report-only — nothing here changes code or config automatically.
- **Next (level 2):** once you're comfortable, findings above a
  materiality threshold (e.g. a large facilitator-fee-margin shift, or a
  major new competitor price point) open a draft PR adjusting `PRICE` or
  batch pricing, for you to review and merge.
- **Later (level 3):** auto-apply — once mainnet is actually live, account
  security is confirmed, and the level-2 PRs have a track record.

*Maintained by a recurring Claude Code job. Each run appends a new dated
section above this roadmap rather than overwriting history.*
