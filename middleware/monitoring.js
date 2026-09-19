// ============================================================================
// Monitoring & Analytics Middleware
//
// Deliberately dependency-free and in-process: enough to answer "is this
// making money and staying healthy?" from the /metrics endpoint. For long-term
// retention ship these numbers to your observability stack.
// ============================================================================

import { createLogger } from '../logger.js';

const logger = createLogger('monitoring');

/** Rolling retention for latency samples. */
const MAX_SAMPLES = 1000;

// Several of the maps below are keyed by attacker-influenced strings reachable
// from unauthenticated routes (`trackFunnel`/`trackReferral` are called from
// the free POST /api/sanitize/trial on every request, keyed by the caller's
// own ?ref= value). Without a cap, hammering that endpoint with a fresh
// referral id each time grows these objects — and the process's memory —
// without bound. Once the cap is hit, further *distinct* keys are dropped;
// existing keys keep counting normally.
const MAX_TRACKED_KEYS = 2000;

/**
 * Increment a counter in a plain-object store, refusing to introduce a new
 * key once the store is at the tracked-key cap.
 *
 * @param {Record<string, number>} store - Counter map
 * @param {string} key - Key to increment
 * @param {number} [amount] - Amount to add
 * @returns {void}
 */
function boundedIncrement(store, key, amount = 1) {
  if (!(key in store)) {
    if (Object.keys(store).length >= MAX_TRACKED_KEYS) return;
  }
  store[key] = (store[key] || 0) + amount;
}

const metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalErrors: 0,
  // 402s are the normal, expected unpaid state — they must not be counted as
  // errors or the error rate becomes meaningless.
  paymentRequiredResponses: 0,
  settledPayments: 0,
  failedPayments: 0,
  paymentFailureReasons: {},
  revenueAtomicByAsset: {},
  funnel: {},
  // Verifiable proof buyers actually got value: recent settled receipts
  // (tx, payer, amount — public on-chain facts, safe to publish).
  receipts: [],
  // Referral leaderboard: which ?ref= brought paying buyers.
  referrals: {},
  // Referral revenue: 10% of referred spend credited back to the referrer.
  referralRevenue: {},
  referralCredits: {},
  // Buyer retention: per-payer purchase counts (addresses are public on-chain
  // facts, already in /receipts). Powers repeatPurchaseRate in /api/insights.
  buyers: {},
  requestTimes: [],
};

/**
 * Human-readable status buckets, used for the /metrics breakdown.
 */
const STATUS_FAMILY = { '2': 'success', '4': 'clientError', '5': 'serverError' };

/**
 * Request tracking middleware. Records latency, status families and request
 * IDs, and logs slow or failed requests.
 *
 * @param {object} loggerInstance - Logger (defaults to the monitoring logger)
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
export function trackRequests(loggerInstance = logger) {
  return (req, res, next) => {
    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
      const statusCode = res.statusCode;
      const family = STATUS_FAMILY[String(statusCode).charAt(0)];

      metrics.totalRequests++;

      if (statusCode === 402) {
        metrics.paymentRequiredResponses++;

        // A 402 that arrived WITH a payment header means a buyer tried to pay
        // and was rejected — the only reliable place to observe that, because
        // the x402 verify hook fires on errors, not on declined payments.
        if (req.x402?.paymentHeader) {
          metrics.failedPayments++;
        }
      } else if (statusCode >= 400) {
        metrics.totalErrors++;
      }

      metrics.requestTimes.push(durationMs);
      if (metrics.requestTimes.length > MAX_SAMPLES) {
        metrics.requestTimes.shift();
      }

      if (durationMs > 5000) {
        loggerInstance.warn(
          `Slow request: ${req.method} ${req.originalUrl} took ${durationMs.toFixed(0)}ms (${statusCode})`,
        );
      }

      if (statusCode >= 500) {
        loggerInstance.error(`${req.method} ${req.originalUrl} -> ${statusCode} in ${durationMs.toFixed(0)}ms`);
      } else if (family) {
        loggerInstance.debug(`${req.method} ${req.originalUrl} -> ${statusCode} in ${durationMs.toFixed(0)}ms`);
      }
    });

    next();
  };
}

/**
 * Record a settled payment. Called from the x402 after-settle path so revenue
 * is observable without querying the chain.
 *
 * @param {object} payment - Payment details
 * @param {string} payment.amount - Atomic amount received
 * @param {string} [payment.asset] - Token contract address
 * @param {string} [payment.payer] - Paying address
 * @param {string} [payment.network] - Network the payment settled on
 * @param {string} [payment.transaction] - Settlement transaction hash
 * @returns {void}
 */
export function trackPayment({ amount, asset = 'unknown', payer, network, transaction } = {}) {
  metrics.settledPayments++;
  trackFunnel('paidCall');
  const safeAmount = typeof amount === 'string' && /^\d+$/.test(amount) ? amount : '0';
  const key = `${asset}`;
  try {
    metrics.revenueAtomicByAsset[key] = String(BigInt(metrics.revenueAtomicByAsset[key] || '0') + BigInt(safeAmount));
  } catch {
    logger.warn(`Payment settled with non-numeric amount: ${amount}`);
  }
  // Ring buffer of the last 20 receipts — the social proof feed.
  metrics.receipts.unshift({
    transaction: transaction || 'n/a',
    payer: payer || 'unknown',
    amount: String(amount || '0'),
    asset: key,
    network: network || 'unknown',
    at: new Date().toISOString(),
  });
  if (metrics.receipts.length > 20) metrics.receipts.length = 20;
  // Retention: the money question is not "did they buy" but "did they return".
  if (payer) {
    const isNewBuyer = !(payer in metrics.buyers);
    if (!isNewBuyer || Object.keys(metrics.buyers).length < MAX_TRACKED_KEYS) {
      const buyer = metrics.buyers[payer] ?? { purchases: 0, firstAt: new Date().toISOString() };
      buyer.purchases += 1;
      buyer.lastAt = new Date().toISOString();
      metrics.buyers[payer] = buyer;
    }
  }
  logger.info(
    `Payment settled: ${amount} of ${asset} on ${network || 'unknown'} from ${payer || 'unknown'} (tx ${transaction || 'n/a'})`,
  );
}

/**
 * Credit a referral id for a settled payment (agent-recommends-agent loop).
 *
 * @param {string|undefined} ref - Validated referral id
 * @returns {void}
 */
export function trackReferral(ref) {
  if (!ref) return;
  boundedIncrement(metrics.referrals, ref);
  trackFunnel(`ref:${ref}`);
}

/**
 * Record a referral credit: the referrer earns a share of the referred
 * buyer's future spend. Every buyer becomes a salesperson.
 *
 * @param {string} ref - Referral id that produced the sale
 * @param {string} amount - Atomic amount credited
 * @param {string} asset - Asset the credit is in
 * @returns {void}
 */
export function creditReferral(ref, amount, asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') {
  if (!ref || !amount) return;
  const share = BigInt(amount) / 10n; // 10% to the referrer
  if (share === 0n) return;
  const key = `${asset}`;
  if (key in metrics.referralRevenue || Object.keys(metrics.referralRevenue).length < MAX_TRACKED_KEYS) {
    metrics.referralRevenue[key] = String(BigInt(metrics.referralRevenue[key] || '0') + share);
  }
  if (ref in metrics.referralCredits || Object.keys(metrics.referralCredits).length < MAX_TRACKED_KEYS) {
    metrics.referralCredits[ref] = String(BigInt(metrics.referralCredits[ref] || '0') + share);
  }
  logger.info(`Referral credit: ${share} of ${asset} to ref ${ref}`);
}

/**
 * Record why a payment failed. Feeds the reason breakdown only —
 * `failedPayments` itself is counted once, from the HTTP 402 response, so a
 * payment is never double counted when both signals fire.
 *
 * @param {string} reason - Why the payment failed
 * @returns {void}
 */
export function trackPaymentFailure(reason) {
  const key = String(reason || 'unknown').slice(0, 120);
  boundedIncrement(metrics.paymentFailureReasons, key);
  logger.warn(`Payment failure: ${key}`);
}

/**
 * Track a conversion-funnel event (free trial use, upsell view, paid call…).
 * Backed by the same counters object so /metrics and /api/insights agree.
 *
 * @param {string} event - Event name (e.g. 'freeTrial', 'paidCall')
 * @returns {void}
 */
export function trackFunnel(event) {
  const key = String(event || 'unknown').slice(0, 60);
  boundedIncrement(metrics.funnel, key);
}

/**
 * Snapshot of buyer-behaviour signals for the growth loop.
 *
 * @returns {object} Funnel + revenue signals
 */
export function getInsights() {
  const funnel = { ...metrics.funnel };
  const freeTrial = funnel.freeTrial || 0;
  const paidCalls = metrics.settledPayments;
  const referrals = Object.entries(metrics.referrals)
    .map(([ref, sales]) => ({ ref, sales }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 10);
  const referralRevenue = Object.entries(metrics.referralRevenue)
    .map(([asset, amount]) => ({ asset, amount: String(amount) }));
  const referralCredits = Object.entries(metrics.referralCredits)
    .map(([ref, amount]) => ({ ref, amount: String(amount) }))
    .sort((a, b) => BigInt(b.amount) - BigInt(a.amount))
    .slice(0, 10);
  const buyerEntries = Object.entries(metrics.buyers);
  const returningBuyers = buyerEntries.filter(([, b]) => b.purchases >= 2).length;
  return {
    funnel,
    conversion: {
      freeTrials: freeTrial,
      paidCalls,
      // Paid calls per free trial — the single number pricing experiments move.
      trialToPaidRate: freeTrial ? Number((paidCalls / freeTrial).toFixed(4)) : 0,
    },
    // Retention: a buyer who returns is worth more than a new one. If this
    // rate is high, raise price; if buyers never return, the product is a
    // one-shot — bundle or subscribe instead.
    retention: {
      totalBuyers: buyerEntries.length,
      returningBuyers,
      repeatPurchaseRate: buyerEntries.length
        ? Number((returningBuyers / buyerEntries.length).toFixed(4))
        : 0,
      topBuyers: buyerEntries
        .sort((a, b) => b[1].purchases - a[1].purchases)
        .slice(0, 5)
        .map(([address, b]) => ({ address, purchases: b.purchases, lastAt: b.lastAt })),
    },
    demand: {
      unpaidChallenges: metrics.paymentRequiredResponses,
      failedPayments: metrics.failedPayments,
      failureReasons: { ...metrics.paymentFailureReasons },
    },
    referrals,
    referralRevenue,
    referralCredits,
    revenueAtomicByAsset: { ...metrics.revenueAtomicByAsset },
  };
}

/**
 * Public settlement receipts: tx, payer, amount — verifiable on-chain facts,
 * safe to publish. Agents check these before integrating.
 *
 * @param {number} [limit=20] - Maximum receipts to return
 * @returns {Array<object>} Recent receipts, newest first
 */
export function getRecentReceipts(limit = 20) {
  return metrics.receipts.slice(0, limit);
}

/**
 * Snapshot current metrics.
 *
 * @returns {object} Metrics snapshot
 */
export function getMetrics() {
  const uptimeSeconds = Math.max(1, Math.floor((Date.now() - metrics.startedAt) / 1000));
  const samples = metrics.requestTimes;
  const averageMs = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    uptimeSeconds,
    totalRequests: metrics.totalRequests,
    totalErrors: metrics.totalErrors,
    paymentRequiredResponses: metrics.paymentRequiredResponses,
    settledPayments: metrics.settledPayments,
    failedPayments: metrics.failedPayments,
    paymentFailureReasons: { ...metrics.paymentFailureReasons },
    revenueAtomicByAsset: { ...metrics.revenueAtomicByAsset },
    funnel: { ...metrics.funnel },
    requestsPerMinute: Number(((metrics.totalRequests / uptimeSeconds) * 60).toFixed(2)),
    errorRatePercent: metrics.totalRequests
      ? Number(((metrics.totalErrors / metrics.totalRequests) * 100).toFixed(2))
      : 0,
    latencyMs: {
      average: Number(averageMs.toFixed(2)),
      p50: sorted.length ? Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(2)) : 0,
      p95: sorted.length ? Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)) : 0,
      samples: sorted.length,
    },
  };
}

/**
 * Reset all counters. Primarily used by tests.
 *
 * @returns {void}
 */
export function resetMetrics() {
  metrics.startedAt = Date.now();
  metrics.totalRequests = 0;
  metrics.totalErrors = 0;
  metrics.paymentRequiredResponses = 0;
  metrics.settledPayments = 0;
  metrics.failedPayments = 0;
  metrics.paymentFailureReasons = {};
  metrics.revenueAtomicByAsset = {};
  metrics.funnel = {};
  metrics.receipts = [];
  metrics.referrals = {};
  metrics.buyers = {};
  metrics.requestTimes = [];
}