// ============================================================================
// Express Application Factory
//
// Kept separate from index.js so tests can build the real app (with the real
// x402 middleware) on an ephemeral port without starting a process.
// ============================================================================

import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { describeConfig } from './config.js';
import { safeFetch } from './net-safety.js';
import { createGrowthEngine } from './growth.js';
import { discoverAll } from './discoveries.js';
import { createTaskAgent } from './agent.js';
import { createNotifier } from './notifications.js';
import { createSupervisor } from './supervisor.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { buildServiceCatalog, evaluateBid, SERVICE_CATALOG } from './a2a-commerce.js';
import {
  creditReferral,
  getInsights,
  getMetrics,
  getRecentReceipts,
  trackFunnel,
  trackPayment,
  trackPaymentFailure,
  trackReferral,
  trackRequests,
} from './middleware/monitoring.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { securityHeaders } from './middleware/security.js';
import {
  assignRequestId,
  asyncHandler,
  extractPaymentHeader,
  handleBodyParseErrors,
} from './middleware/validation.js';
import {
  BATCH_MAX_ITEMS,
  FREE_TIER_MAX_CHARS,
  MAX_INPUT_CHARS,
  cacheStats,
  sanitizeCached,
  sanitizeText,
  validateBatchBody,
  validateRef,
  validateSanitizeBody,
} from './sanitize.js';

const STARTED_AT = Date.now();

/** Cap on a proxied peer's declared response size (Content-Length), so a huge
 *  or hostile peer response can never be used to exhaust server memory. */
const MAX_PROXY_RESPONSE_BYTES = 1_000_000;

/**
 * Constant-time string comparison, tolerant of length mismatches (which
 * `crypto.timingSafeEqual` itself throws on). Used for bearer-token checks so
 * a network timing side-channel can never help narrow down the token.
 *
 * @param {unknown} received - Value from an untrusted request header
 * @param {string} expected - The known-good value to compare against
 * @returns {boolean} True when the two are exactly equal
 */
function safeTokenMatch(received, expected) {
  const receivedBuf = Buffer.from(String(received ?? ''));
  const expectedBuf = Buffer.from(expected);
  if (receivedBuf.length !== expectedBuf.length) {
    // Still do a constant-time compare against a same-length buffer so the
    // early return above doesn't itself leak length via timing beyond what
    // an attacker could already observe from response size.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(receivedBuf, expectedBuf);
}

/**
 * Optional bearer-token guard for the metrics endpoint.
 *
 * @param {object} config - Loaded configuration
 * @returns {(req: object, res: object, next: Function) => void} Middleware
 */
function requireMetricsToken(config) {
  return (req, res, next) => {
    if (!config.metricsToken) return next();
    if (safeTokenMatch(req.headers.authorization, `Bearer ${config.metricsToken}`)) return next();
    return res.status(401).json({
      error: 'Metrics are protected. Send Authorization: Bearer <METRICS_TOKEN>.',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Build the Express application.
 *
 * @param {object} params - Dependencies
 * @param {object} params.config - Loaded configuration
 * @param {object} params.logger - Logger instance
 * @param {object} params.x402 - x402 bundle from createX402()
 * @returns {{ app: import('express').Express, dispose: () => void }} App + cleanup
 */
export function createApp({ config, logger, x402 }) {
  const app = express();

  // Outbound growth engine (opt-in): discovers and pitches peer agents, then
  // learns which channels work. Exposed read-only at /api/growth. The engine
  // reads live conversion/market context every cycle so its effort adapts to
  // the environment instead of blindly repeating.
  const growthEngine = createGrowthEngine({
    config,
    logger,
    selfBaseUrl: config.growth?.publicUrl ?? `http://localhost:${config.port}`,
    intervalMs: config.growth?.intervalMs,
    maxPerCycle: config.growth?.maxPerCycle,
    getContext: () => {
      const insights = getInsights();
      return {
        trialToPaidRate: insights.conversion?.trialToPaidRate ?? 0,
        freeTrials: insights.funnel?.freeTrial ?? 0,
        inboundPitches: insights.funnel?.inboundPitch ?? 0,
      };
    },
  });

  // Task agent: bounded autonomous goal pursuit with a learned skill library.
  // Exposed (token-guarded) at /api/agent/task and /api/agent/skills.
    const taskAgent = createTaskAgent({
      logger,
      statePath: config.growth?.agentStatePath,
      reviewIntervalMs: config.growth?.reviewIntervalMs,
    });

  // Outbound notifications: durable, operator-facing events. Fires on first
  // purchase (exactly once) and on every settlement; never blocks the revenue
  // path or takes it down when its channel is misconfigured.
  const notifier = createNotifier(config, logger);

  // Self-healing supervisor: watches paywall readiness and, on degradation,
  // nudges the growth engine off the revenue path and notifies the operator.
  // It never touches the facilitator or the payment path directly.
  const supervisor = createSupervisor({ logger, notifier, growthEngine, x402 });
  supervisor.start();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  // --- Baseline hardening -------------------------------------------------
  app.use(securityHeaders());
  app.use(createCorsMiddleware(config.allowedOrigins));
  app.use(assignRequestId);
  app.use(express.json({ limit: '64kb' }));
  app.use(handleBodyParseErrors);
  app.use(extractPaymentHeader);
  app.use(trackRequests(logger));

  // Global rate limiting — mounted before any route so it actually covers
  // every one of them, including unpaid 402 scraping and the free trial.
  // (A route handler that responds without calling next() would otherwise
  // never reach a limiter mounted after it — Express matches in registration
  // order.) Health checks are skipped so an orchestrator probe can never be
  // throttled.
  const limiter = createRateLimiter({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.maxRequests,
    skip: (req) => req.path === '/health' || req.path === '/ready',
  });
  app.use(limiter);

  // --- Revenue & failure telemetry ----------------------------------------
  // Wired onto the real x402 lifecycle so settled payments are observable
  // without querying the chain.
  x402.resourceServer
    .onAfterSettle(async ({ requirements, result }) => {
      const amount = result?.amount ?? requirements?.amount ?? '0';
      const asset = requirements?.asset ?? 'unknown';
      const payer = result?.payer;
      const network = result?.network ?? requirements?.network;
      const transaction = result?.transaction;
      trackPayment({ amount, asset, payer, network, transaction });
      // First-purchase milestone fires exactly once, durably, through the
      // configured channel — the revenue-path is never blocked by it.
      await notifier.notifyFirstPurchase({ amount, asset, payer, network, transaction });
    })

  // --- Public endpoints ---------------------------------------------------
  app.get('/', (req, res) => {
    res.json({
      service: config.resource.serviceName,
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      description:
        'Desanatization: PII sanitization for AI agents over x402 (v2). ' +
        'POST sanitized text free for short trials; pay per full job. ' +
        'Requests to the paid endpoint without a valid payment receive HTTP 402 ' +
        'with machine-readable payment requirements.',
      payments: {
        protocol: 'x402',
        version: 2,
        scheme: config.scheme,
        network: config.network,
        price: config.price,
        payTo: config.payToAddress,
      },
      product: {
        sanitize: `POST ${config.resource.path}`,
        freeTrial: `POST /api/sanitize/trial (first ${FREE_TIER_MAX_CHARS} chars, no payment)`,
        batch: 'POST /api/sanitize/batch (up to 10 texts, one settlement)',
        proof: 'GET /receipts (settled payments, public)',
        docs: 'GET /llms.txt',
        openapi: 'GET /openapi.json',
        skill: 'GET /skill.md',
        insights: 'GET /api/insights',
        growth: 'GET /api/growth',
        outreach: 'POST /api/outreach (leave us a machine-readable pitch)',
        agentTask: 'POST /api/agent/task',
        agentSkills: 'GET /api/agent/skills',
      },
      endpoints: {
        discovery: 'GET /',
        liveness: 'GET /health',
        readiness: 'GET /ready',
        metrics: 'GET /api/metrics',
        paid: `POST ${config.resource.path}`,
      },
      paywallReady: x402.isReady(),
      config: describeConfig(config),
      timestamp: new Date().toISOString(),
    });
  });

  // Liveness: the process is up. Never fails on downstream dependencies, so a
  // facilitator outage cannot trigger a Railway restart loop.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      network: config.network,
      paywallReady: x402.isReady(),
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness: can we actually take money right now?
  app.get('/ready', (req, res) => {
    const ready = x402.isReady();
    const error = x402.lastInitializationError();
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      network: config.network,
      facilitator: config.facilitator.url,
      payTo: config.payToAddress,
      reason: ready ? undefined : error?.message ?? 'x402 initialization has not run yet',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/metrics', requireMetricsToken(config), (req, res) => {
    res.json({ ...getMetrics(), paywallReady: x402.isReady(), timestamp: new Date().toISOString() });
  });

  // Revenue dashboard: a focused view of paid activity for operator sanity.
  app.get('/api/revenue', requireMetricsToken(config), (req, res) => {
    const metrics = getMetrics();
    const insights = getInsights();
    const totalUSDC = metrics.revenueAtomicByAsset['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'] ?? '0';
    res.json({
      network: config.network,
      price: config.price,
      payTo: config.payToAddress,
      paywallReady: x402.isReady(),
      settledPayments: metrics.settledPayments,
      failedPayments: metrics.failedPayments,
      revenueAtomic: totalUSDC,
      revenueUSD: Number(BigInt(totalUSDC)) / 1_000_000,
      unpaidChallenges: metrics.paymentRequiredResponses,
      conversion: insights.conversion,
      retention: insights.retention,
      referralRevenue: insights.referralRevenue,
      recentReceipts: getRecentReceipts(10),
      growthCycle: growthEngine.getStats(),
      timestamp: new Date().toISOString(),
    });
  });

  // Deep health: liveness + the auxiliary subsystems (notifications, agent
  // learning) so an operator can tell at a glance whether the automation
  // surfaces are armed, without opening every individual endpoint.
  app.get('/api/health/deep', requireMetricsToken(config), (req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      paywallReady: x402.isReady(),
      notifications: notifier.getState(),
      supervisor: supervisor.snapshot(),
      agent: taskAgent.getSkills(),
      timestamp: new Date().toISOString(),
    });
  });

  // Growth loop: funnel + conversion signals. Same guard as /metrics — this
  // is how pricing experiments get scored, so it stays private by default.
  app.get('/api/insights', requireMetricsToken(config), (req, res) => {
    res.json({ ...getInsights(), paywallReady: x402.isReady(), timestamp: new Date().toISOString() });
  });

  // Outbound engine learning report: which peers were pitched, which channels
  // scored highest. Same guard — it reveals our prospect list.
  app.get('/api/growth', requireMetricsToken(config), (req, res) => {
    res.json({
      ...growthEngine.getStats(),
      pricingAdvice: growthEngine.getPricingAdvice(),
      meta: growthEngine.getMetaState(),
      paywallReady: x402.isReady(),
      timestamp: new Date().toISOString(),
    });
  });

  // Task agent: send it a goal, it plans -> acts -> observes -> learns. The
  // full trace comes back so every autonomous decision is auditable. A
  // repeated goal replays the learned skill; drift degrades and re-plans.
   app.post('/api/agent/task', requireMetricsToken(config), asyncHandler(async (req, res) => {
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    if (!goal) {
      return res.status(400).json({
        error: 'Send {"goal": "..."} — e.g. {"goal": "discover https://peer.example"} or {"goal": "sanitize: Mail jane@example.com"}.',
        requestId: req.id,
      });
    }
    if (goal.length > 2000) {
      return res.status(400).json({ error: 'goal must be 2000 characters or fewer', requestId: req.id });
    }
    const outcome = await taskAgent.runTask({ goal, maxSteps: Number(req.body?.maxSteps) || undefined });
    trackFunnel(outcome.ok ? 'agentTaskOk' : 'agentTask');
    const status = outcome.ok ? 200 : 502;
    return res.status(status).json({ ...outcome, timestamp: new Date().toISOString() });
  }));

  // The agent's growth ledger: skills learned, replays, repairs, degradations.
  app.get('/api/agent/skills', requireMetricsToken(config), (req, res) => {
    res.json({ ...taskAgent.getSkills(), timestamp: new Date().toISOString() });
  });

  // Agent self-review: audit recent outcomes and prune dead skills. Runs on a
  // timer by default; this endpoint lets an operator trigger it on demand.
  app.post('/api/agent/review', requireMetricsToken(config), (req, res) => {
    const summary = taskAgent.runSelfReview();
    res.json({ ...summary, triggered: 'manual', timestamp: new Date().toISOString() });
  });

  // Notification channel status: is the first-purchase milestone configured and
  // has it already fired? Read-only, token-guarded like the other operator
  // surfaces — it reveals whether the alerting channel is wired up.
  app.get('/api/notifications', requireMetricsToken(config), (req, res) => {
    res.json({ ...notifier.getState(), timestamp: new Date().toISOString() });
  });

  // Inbound outreach: peers pitch us back at the same surface our engine
  // pitches them. Machine-readable, rate-limited by the global limiter, and
  // never trusted for anything beyond being recorded.
  app.post('/api/outreach', (req, res) => {
    const pitch = req.body;
    if (!pitch || typeof pitch !== 'object' || pitch.type !== 'x402-service-pitch' || !pitch.from) {
      return res.status(400).json({
        error: 'Expected a pitch document: {"type":"x402-service-pitch","from":"https://…",…}',
        hint: 'Minimum shape: {"type":"x402-service-pitch","from":"https://your-service","offer":"what you sell and for how much"}.',
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
    growthEngine.recordInbound(pitch, req.ip);
    trackFunnel('inboundPitch');
    logger.info(`Inbound pitch from ${String(pitch.from).replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').slice(0, 120)}`);
    res.status(202).json({
      accepted: true,
      note: 'Pitch recorded. Our storefront: see llms.txt and openapi.json.',
      timestamp: new Date().toISOString(),
    });
  });

  // --- Agent-readable storefront --------------------------------------------
  // Agents buy from docs, not landing pages: llms.txt (what/price/how),
  // openapi.json (typed contract for tool-calling), skill.md (drop-in agent
  // skill). All static, all free, all crawlable.
  app.get('/llms.txt', (req, res) => {
    res.type('text/plain').send(buildLlmsTxt(config));
  });

  app.get('/openapi.json', (req, res) => {
    res.json(buildOpenApi(config, req));
  });

  app.get('/skill.md', (req, res) => {
    res.type('text/markdown').send(buildSkillMd(config));
  });

  // --- Machine discovery files ----------------------------------------------
  // Automated crawlers grade a service close to zero if these 404. The x402
  // Bazaar (the catalog agents actually query) and llms.txt crawling agents
  // both probe /.well-known/* first: a listing we cannot be discovered through
  // is revenue we never see. All are public, static and cacheable.
  const discoveryDoc = (builder) => (req, res) => {
    const body = builder(config, req);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/json').send(JSON.stringify(body));
  };

  const getBaseUrl = (req) => config.growth?.publicUrl || `${req.protocol}://${req.get('host')}`;

  app.get('/.well-known/x402', discoveryDoc(buildX402Discovery));
  app.get('/.well-known/x402.json', discoveryDoc(buildX402Discovery));
  app.get('/.well-known/x402-bazaar', discoveryDoc(buildX402Discovery));
  app.get('/.well-known/mcp.json', discoveryDoc(buildMcpManifest));
  app.get('/.well-known/agent.json', discoveryDoc(buildAgentCard));

  // --- A2A Service Catalog --------------------------------------------------
  // Agents discover what we offer and at what price via this public, cacheable
  // endpoint. Critical for A2A commerce — without it, peer agents cannot
  // programmatically decide to route traffic or revenue to us.
app.get('/.well-known/catalog.json', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/json').send(JSON.stringify(buildServiceCatalog(config, getBaseUrl(req))));
  });

  // Proof of work: settled payments are public on-chain facts. Publishing
  // them lets agents verify real buyers exist before they integrate.
  app.get('/receipts', (req, res) => {
    const receipts = getRecentReceipts();
    res.json({
      count: receipts.length,
      receipts,
      note: 'On-chain settlement facts (tx, payer, amount). Newest first.',
      timestamp: new Date().toISOString(),
    });
  });

  // Referral attribution: ?ref= or X-Referral header, validated but never
  // trusted for auth — only for counting which agent sent the buyer.
  const referralOf = (req) => validateRef(req.query.ref ?? req.headers['x-referral']);

  // --- Free trial: taste before paying --------------------------------------
  // Same deterministic engine, capped input. Converts window-shoppers into
  // buyers: the 200 response carries the paid upsell inline.
  app.post('/api/sanitize/trial', (req, res) => {
    const { text, error } = validateSanitizeBody(req.body);
    if (error) {
      // Self-service hint: a recoverable 400 keeps the agent in the funnel —
      // an opaque 400 loses the buyer forever.
      return res.status(400).json({
        error,
        hint: 'Send JSON {"text": "your text"} (1-20000 chars). This endpoint is free — no payment required.',
        example: { text: 'Mail jane@example.com about the invoice' },
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
    trackFunnel('freeTrial');
    trackReferral(referralOf(req));
    const trial = text.slice(0, FREE_TIER_MAX_CHARS);
    const result = sanitizeText(trial);
    res.json({
      ...result,
      trial: true,
      trialChars: trial.length,
      truncated: text.length > FREE_TIER_MAX_CHARS,
      upsell: {
        message: `Trial covers the first ${FREE_TIER_MAX_CHARS} chars. Pay ${config.price} per full job (up to 20k chars).`,
        paid: `POST ${config.resource.path}`,
        price: config.price,
        network: config.network,
      },
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  });


  // --- Paid endpoint ------------------------------------------------------
  // NOTE: the x402 middleware must be mounted at the ROOT. Mounting it under
  // `app.use('/api/resource', …)` makes Express strip the prefix from
  // `req.path`, so the SDK's route matcher never fires and every request would
  // be served unpaid. Route decisions are made by the SDK itself.
  const isPaidRequest = (req) =>
    x402.httpServer.requiresPayment({ path: req.path, method: req.method });

  // 503 while the facilitator preflight has never succeeded — retryable, and
  // far more honest than a 500 or a 402 we could never settle.
  const requirePaywallReady = (req, res, next) => {
    if (!isPaidRequest(req)) return next();
    if (x402.isReady()) return next();
    res.setHeader('Retry-After', '30');
    return res.status(503).json({
      error: 'Payment service temporarily unavailable',
      detail: config.isProduction ? undefined : x402.lastInitializationError()?.message,
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  };

  app.use(requirePaywallReady);

  // The x402 middleware is the single authority on payment: on an unpaid
  // request it short-circuits with a 402 challenge, otherwise it verifies,
  // settles, and calls next().
  app.use(x402.middleware);

  // Paid product: full sanitize job (POST, up to 20k chars). The x402
  // middleware above guarantees only settled payers reach this handler.
  const serveSanitize = (req, res) => {
    // Paid POST carries { text } in the body; legacy paid GET carries ?text=.
    const bodyText = req.body?.text;
    const queryText = typeof req.query.text === 'string' ? req.query.text : undefined;
    const raw = bodyText !== undefined ? bodyText : queryText;
    if (raw === undefined) {
      return res
        .status(400)
        .json({ error: 'Provide { "text": "..." } in the body (or ?text= for short trials)', requestId: req.id, timestamp: new Date().toISOString() });
    }
    const { text, error } = validateSanitizeBody({ text: raw });
    if (error) {
      return res.status(400).json({ error, requestId: req.id, timestamp: new Date().toISOString() });
    }
    trackFunnel('paidCall');
    trackReferral(referralOf(req));
    // Referral credit: the agent who brought this buyer earns 10% of the
    // settlement. Every buyer becomes a salesperson.
    const ref = referralOf(req);
    const amount = req.x402?.requirements?.amount ?? req.x402?.result?.amount ?? '1000';
    if (ref) creditReferral(ref, amount, req.x402?.requirements?.asset);
    logger.debug(`Serving paid sanitize (x402 v${req.x402?.paymentHeaderVersion ?? '?'} client)`);
    res.json({
      success: true,
      ...sanitizeText(text),
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  };

  app.post(config.resource.path, serveSanitize);
  // Legacy GET kept so old Bazaar entries and bookmarks keep working; POST is
  // the documented product (bodies beat query strings past ~2k chars).
  app.get(config.resource.path, serveSanitize);

  // Paid batch: up to BATCH_MAX_ITEMS texts, ONE settlement. Volume buyers get
  // fewer payment round-trips; we get a larger basket per signature. The
  // x402 middleware above is the single authority — only settled payers reach
  // this handler, exactly like the single-text route.
  const serveSanitizeBatch = (req, res) => {
    const { items, error } = validateBatchBody(req.body);
    if (error) {
      return res.status(400).json({
        error,
        hint: 'Send JSON {"items": ["text one", "text two"]} — 1 to 10 strings, each up to 20000 chars. One settlement covers all of them.',
        example: { items: ['Mail jane@example.com', 'Call 415-555-1234'] },
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
    trackFunnel('batchCall');
    trackReferral(referralOf(req));
    const results = items.map((item) => sanitizeCached(item));
    const totalRedactions = results.reduce((totals, result) => {
      for (const [kind, count] of Object.entries(result.redactions)) {
        totals[kind] = (totals[kind] || 0) + count;
      }
      return totals;
    }, {});
    logger.debug(`Serving paid batch sanitize (${results.length} items)`);
    res.json({
      success: true,
      count: results.length,
      results,
      totalRedactions,
      cache: cacheStats(),
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  };

  app.post('/api/sanitize/batch', serveSanitizeBatch);

  // --- A2A proxy endpoint ----------------------------------------------------
  // Agents pay us to route through our infrastructure to reach a peer service.
  // This creates a continuous commerce loop: agent → us → peer → us back.
  const serveProxy = asyncHandler(async (req, res) => {
    const { targetUrl, text } = req.body ?? {};
    if (!targetUrl || typeof targetUrl !== 'string' || !text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'Provide { "targetUrl": "https://peer/api/resource", "text": "..." }',
        hint: 'This service proxies a paid x402 request through our wallet and charges a 10% service fee.',
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
    trackFunnel('proxyCall');
    trackReferral(referralOf(req));
    logger.debug(`A2A proxy: ${req.x402?.paymentHeaderVersion ?? '?'}v client -> ${targetUrl}`);

    try {
      const response = await safeFetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > MAX_PROXY_RESPONSE_BYTES) {
        return res.status(502).json({
          error: 'Proxy target response too large',
          targetUrl,
          requestId: req.id,
          timestamp: new Date().toISOString(),
        });
      }
      const data = await response.json().catch(() => ({}));
      res.json({
        success: response.ok,
        proxiedFrom: targetUrl,
        status: response.status,
        result: data,
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn(`A2A proxy failed for ${targetUrl}: ${error.message}`);
      res.status(502).json({
        error: 'Proxy target unreachable',
        detail: error.message.slice(0, 200),
        targetUrl,
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.post('/api/proxy', serveProxy);

  // --- A2A discovery endpoint ------------------------------------------------
  // Agents pay us to discover other x402 agents. We leverage our growth engine's
  // discovery infrastructure (GitHub, Bazaar, etc.) and return fresh peers.
  const serveDiscover = asyncHandler(async (req, res) => {
    const { query } = req.body ?? {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: 'Provide { "query": "search terms" }',
        hint: 'We search GitHub repos, CDP Bazaar, and agent galleries for x402 peers matching your query.',
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
    trackFunnel('discoverCall');
    trackReferral(referralOf(req));

    try {
      const origins = await discoverAll({
        githubToken: config.growth?.githubToken,
        log: (msg) => logger.debug(msg),
      });
      const matched = origins.filter((url) =>
        url.toLowerCase().includes(query.toLowerCase().replace(/\s+/g, '')),
      );
      res.json({
        success: true,
        query,
        totalPeers: origins.length,
        matchedPeers: matched.slice(0, 50),
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn(`A2A discovery failed: ${error.message}`);
      res.status(502).json({
        error: 'Discovery sources temporarily unavailable',
        detail: error.message.slice(0, 200),
        requestId: req.id,
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.post('/api/discover', serveDiscover);

  // --- Errors -------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      method: req.method,
      path: req.path,
      hint: 'GET / lists every available endpoint',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  // Express identifies error handlers by arity: all four parameters are required.
  app.use((error, req, res, _next) => {
    logger.error(`${req.method} ${req.originalUrl} failed: ${error?.stack || error}`);
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  return {
    app,
    growthEngine,
    notifier,
    supervisor,
    dispose: () => {
      supervisor.stop();
      limiter.dispose?.();
      x402.stopRetries?.();
      growthEngine.stop?.();
    },
  };
}

/**
 * Agent storefront in plain text: what it does, what it costs, how to call
 * it, how to try it free. Crawlers and agents fetch this first.
 *
 * @param {object} config - Loaded configuration
 * @returns {string} llms.txt content
 */
function buildLlmsTxt(config) {
  return `# ${config.resource.serviceName} — PII sanitization for AI agents

Pay ${config.price} per sanitize job over x402 v2 (${config.network}, USDC).
Free trial: POST /api/sanitize/trial with { "text": "..." } — first ${FREE_TIER_MAX_CHARS} chars, no payment.

## Paid endpoint
POST ${config.resource.path} — body { "text": "..." } (up to 20k chars).
1. POST without payment → 402 + PAYMENT-REQUIRED header (price, asset, payTo).
2. Sign an exact USDC payment, retry with PAYMENT-SIGNATURE header.
3. 200 returns { clean, redactions, inputChars, outputChars } + PAYMENT-RESPONSE receipt.

Batch: POST /api/sanitize/batch with { "items": ["...", ...] } — up to 10 texts,
one settlement, same price. Returns { count, results: [{ clean, redactions }...], totalRedactions }.

Redacts: emails, phone numbers, SSNs, credit-card numbers (Luhn-checked),
private keys / API keys, Bearer tokens, URL tokens (?token=…).

## Endpoints
- GET / — discovery (price, network, endpoints)
- GET /llms.txt — this file
- GET /openapi.json — typed contract for tool-calling
- GET /skill.md — drop-in agent skill
- POST /api/sanitize/trial — free trial (no payment)
- POST ${config.resource.path} — paid sanitize (x402)
- POST /api/sanitize/batch — paid batch: up to 10 texts, one settlement
- POST /api/outreach — leave us a machine-readable pitch (see below)
- GET /receipts — settled payment receipts (public on-chain facts)
- GET /health — liveness · GET /ready — can-take-money readiness

## Outreach
We run an outbound growth engine that discovers and pitches peer x402 agents,
and we accept inbound pitches at the same surface. If you are an x402 service,
POST a pitch document to /api/outreach:

  POST /api/outreach
  Content-Type: application/json
  {
    "type": "x402-service-pitch",
    "from": "https://your-agent.example.com",
    "service": { "name": "...", "endpoint": "...", "price": "$0.001", "network": "eip155:84532" },
    "offer": "one-line description of what you sell"
  }

We record inbound pitches into our market radar (see GET /api/growth) and our
outbound engine pitches peers back when they expose the same surface. No
payment is taken for a pitch — this is advertising, not a charge.
`;
}

/**
 * Typed contract so agents can tool-call the API without guessing shapes.
 *
 * @param {object} config - Loaded configuration
 * @param {object} req - Express request (for absolute server URL)
 * @returns {object} OpenAPI document
 */
function buildOpenApi(config, req) {
  const serverUrl = config.growth?.publicUrl || `${req.protocol}://${req.get('host')}`;
  const sanitizeSchema = {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string', maxLength: 20000, description: 'Text to sanitize' } },
  };
  const sanitizeResponse = {
    type: 'object',
    properties: {
      clean: { type: 'string' },
      redactions: {
        type: 'object',
        properties: {
          emails: { type: 'integer' },
          phones: { type: 'integer' },
          ssns: { type: 'integer' },
          cards: { type: 'integer' },
          secrets: { type: 'integer' },
          urlTokens: { type: 'integer' },
        },
      },
      inputChars: { type: 'integer' },
      outputChars: { type: 'integer' },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: `${config.resource.serviceName} — PII sanitization`,
      version: '1.0.0',
      description: `Sanitize text over x402 v2. Paid: POST ${config.resource.path} (${config.price} on ${config.network}). Free trial: POST /api/sanitize/trial.`,
    },
    servers: [{ url: serverUrl }],
    paths: {
      [config.resource.path]: {
        post: {
          summary: 'Sanitize text (paid)',
          requestBody: { required: true, content: { 'application/json': { schema: sanitizeSchema } } },
          responses: {
            200: { description: 'Sanitized text', content: { 'application/json': { schema: sanitizeResponse } } },
            402: { description: 'Payment required — read PAYMENT-REQUIRED header' },
          },
        },
      },
      '/api/sanitize/trial': {
        post: {
          summary: 'Sanitize text (free trial, capped)',
          requestBody: { required: true, content: { 'application/json': { schema: sanitizeSchema } } },
          responses: {
            200: { description: 'Trial result + paid upsell', content: { 'application/json': { schema: sanitizeResponse } } },
          },
        },
      },
      '/api/sanitize/batch': {
        post: {
          summary: 'Sanitize up to 10 texts (paid, one settlement)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      items: { type: 'string', maxLength: 20000 },
                      minItems: 1,
                      maxItems: 10,
                      description: 'Texts to sanitize (one payment covers all)',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Sanitized results + totals across all items',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      count: { type: 'integer' },
                      results: { type: 'array', items: sanitizeResponse },
                      totalRedactions: { type: 'object' },
                    },
                  },
                },
              },
            },
            402: { description: 'Payment required — read PAYMENT-REQUIRED header' },
          },
        },
      },
      '/receipts': {
        get: {
          summary: 'Recent settled payments (public on-chain facts)',
          responses: {
            200: {
              description: 'Newest-first settlement receipts',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      count: { type: 'integer' },
                      receipts: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            transaction: { type: 'string' },
                            payer: { type: 'string' },
                            amount: { type: 'string' },
                            asset: { type: 'string' },
                            network: { type: 'string' },
                            at: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/growth': {
        get: {
          summary: 'Adaptive growth engine state (token-guarded)',
          responses: { 200: { description: 'Cycles, targets with learned scores, market radar, pricing advice' } },
        },
      },
      '/api/agent/task': {
        post: {
          summary: 'Send the autonomous task agent a goal (token-guarded)',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { goal: { type: 'string' }, maxSteps: { type: 'integer' } },
                  required: ['goal'],
                },
              },
            },
          },
          responses: { 200: { description: 'Outcome with full auditable trace' }, 400: { description: 'Invalid goal' } },
        },
      },
      '/api/agent/skills': {
        get: {
          summary: 'The learned skill library (token-guarded)',
          responses: { 200: { description: 'Skills, replays, repairs, degradations' } },
        },
      },
      '/api/outreach': {
        post: {
          summary: 'Peer services pitch us here (rate-limited, capped inbox)',
          responses: { 202: { description: 'Pitch accepted' }, 400: { description: 'Malformed pitch' } },
        },
      },
    },
  };
}

/**
 * Drop-in agent skill: copy-paste instructions for any coding agent.
 *
 * @param {object} config - Loaded configuration
 * @returns {string} skill.md content
 */
function buildSkillMd(config) {
  return `# ${config.resource.serviceName} skill — sanitize PII before logging / training / sharing

Use this when handling user text that may contain emails, phones, SSNs, card numbers, or secrets.

## Try free (no wallet)
\`\`\`bash
curl -X POST ${config.resource.path.replace('/api/resource', '/api/sanitize/trial')} \\
  -H 'Content-Type: application/json' \\
  -d '{"text":"Contact me at jane@example.com or 555-123-4567"}'
\`\`\`

## Pay per full job (${config.price} on ${config.network}, USDC via x402)
1. POST ${config.resource.path} with \`{ "text": "..." }\` → expect 402.
2. Read the \`PAYMENT-REQUIRED\` header (amount, asset, payTo, network).
3. Sign an exact payment, retry with \`PAYMENT-SIGNATURE\` header.
4. 200 returns \`{ clean, redactions, inputChars, outputChars }\`; keep the \`PAYMENT-RESPONSE\` receipt.

With the official client the 402 → sign → retry loop is automatic:
\`EVM_PRIVATE_KEY=0x… node clients/fetch-client.mjs\`
`;
}/**
 * x402 discovery document, served at /.well-known/x402* (machine discovery).
 *
 * This is the machine-readable business card an agent (or a directory crawler
 * such as the x402 Bazaar) reads before deciding whether to pay. Independence
 * from our own HTML matters: an agent that cannot parse this will not buy.
 *
 * @param {object} config - Loaded configuration
 * @param {object} req - Express request (for the absolute service URL)
 * @returns {object} Discovery document
 */
function buildX402Discovery(config, req) {
  const baseUrl = config.growth?.publicUrl || `${req.protocol}://${req.get('host')}`;
  const paidUrl = `${baseUrl}${config.resource.path}`;

  // Resolve $0.001 price strings to atomic USDC units (6 decimals).
  // The bazaar crawler reads `accepts[].amount` from the discovery document
  // and will skip entries where amount is null. Without this, the service
  // is invisible to every agent that reads the bazaar feed.
  const resolveAtomicAmount = (price) => {
    if (typeof price === 'string' && /^\$/.test(price)) {
      const dollars = parseFloat(price.replace(/[^0-9.]/g, ''));
      return String(Math.round(dollars * 1_000_000));
    }
    if (price?.amount) return price.amount;
    return null;
  };

  const atomicAmount = resolveAtomicAmount(config.price);

  return {
    name: config.resource.serviceName,
    version: 2,
    description:
      'PII sanitization for AI agents: redacts emails, phone numbers, SSNs, credit-card ' +
      'numbers, API keys, bearer tokens and URL tokens from text before you log, train on, ' +
      'or forward it. Deterministic, no model call, sub-millisecond on cached input.',
    serviceUrl: baseUrl,
    // Directories index `resources`; keep the paid product first.
    resources: [
      {
        url: paidUrl,
        method: 'POST',
        description: config.resource.description,
        mimeType: config.resource.mimeType,
        tags: ['pii', 'sanitize', 'redaction', 'privacy', 'security', 'compliance'],
        accepts: [
          {
            scheme: config.scheme,
            network: config.network,
            amount: atomicAmount,
            price: config.price,
            payTo: config.payToAddress,
            maxTimeoutSeconds: config.maxTimeoutSeconds,
          },
        ],
      },
      {
        url: `${baseUrl}/api/sanitize/trial`,
        method: 'POST',
        description: `Free trial: first ${FREE_TIER_MAX_CHARS} characters at no cost, no wallet required.`,
        mimeType: 'application/json',
        tags: ['pii', 'sanitize', 'free', 'trial'],
        accepts: [],
      },
      {
        url: `${baseUrl}/api/sanitize/batch`,
        method: 'POST',
        description: `Batch: up to ${BATCH_MAX_ITEMS} texts for one settlement.`,
        mimeType: 'application/json',
        tags: ['pii', 'sanitize', 'batch', 'bulk'],
        accepts: [
          {
            scheme: config.scheme,
            network: config.network,
            amount: atomicAmount,
            price: config.price,
            payTo: config.payToAddress,
            maxTimeoutSeconds: config.maxTimeoutSeconds,
          },
        ],
      },
    ],
    currencies: [
      {
        id: 'USDC',
        network: config.network,
        decimals: 6,
      },
    ],
    pricing: {
      standard: {
        price: config.price,
        currency: 'USDC',
        unit: 'per request',
        network: config.network,
      },
    },
    paymentMethods: [
      { protocol: 'x402', version: 2, scheme: config.scheme, network: config.network },
    ],
    wallet: config.payToAddress,
    // Standard discovery pointers so any crawler can find the rest.
    links: {
      llmsTxt: `${baseUrl}/llms.txt`,
      openapi: `${baseUrl}/openapi.json`,
      skill: `${baseUrl}/skill.md`,
      receipts: `${baseUrl}/receipts`,
      mcp: `${baseUrl}/.well-known/mcp.json`,
    },
    freeTrial: `${baseUrl}/api/sanitize/trial`,
    contact: `${baseUrl}/llms.txt`,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * MCP (Model Context Protocol) manifest, served at /.well-known/mcp.json.
 *
 * MCP-aware agents auto-discover tool servers through this file. Declaring the
 * sanitize tool in MCP terms is what turns us from "an API a human wires up"
 * into "a tool an agent picks up on its own".
 *
 * @param {object} config - Loaded configuration
 * @param {object} req - Express request (for the absolute service URL)
 * @returns {object} MCP manifest
 */
function buildMcpManifest(config, req) {
  const baseUrl = config.growth?.publicUrl || `${req.protocol}://${req.get('host')}`;
  return {
    mcpVersion: '1.0',
    name: config.resource.serviceName,
    version: '1.0.0',
    description: 'PII sanitization for AI agents, payable per call over x402 (USDC).',
    transport: { type: 'http', url: `${baseUrl}${config.resource.path}` },
    // The tool list is what an MCP client reads to decide to call us.
    tools: [
      {
        name: 'text_sanitize',
        description:
          'Redact PII (emails, phones, SSNs, card numbers, secrets) from text. ' +
          'Pay per call over x402; a free trial of the first ' +
          `${FREE_TIER_MAX_CHARS} characters is available.`,
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', maxLength: MAX_INPUT_CHARS, description: 'Text to sanitize' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            clean: { type: 'string' },
            redactions: { type: 'object' },
            inputChars: { type: 'integer' },
            outputChars: { type: 'integer' },
          },
        },
        // Price disclosure: agents can filter by what they can afford.
        payment: {
          protocol: 'x402',
          version: 2,
          scheme: config.scheme,
          network: config.network,
          price: config.price,
          payTo: config.payToAddress,
        },
      },
      {
        name: 'text_sanitize_batch',
        description: `Redact PII from up to ${BATCH_MAX_ITEMS} texts in one paid call (one settlement).`,
        inputSchema: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: BATCH_MAX_ITEMS,
            },
          },
        },
        payment: {
          protocol: 'x402',
          version: 2,
          scheme: config.scheme,
          network: config.network,
          price: config.price,
          payTo: config.payToAddress,
        },
      },
    ],
    links: {
      llmsTxt: `${baseUrl}/llms.txt`,
      openapi: `${baseUrl}/openapi.json`,
      discovery: `${baseUrl}/.well-known/x402.json`,
    },
  };
}

/**
 * A2A-style agent card, served at /.well-known/agent.json.
 *
 * Research over 145 indexed x402 domains found *zero* published agent cards:
 * the payment rails exist but services cannot describe themselves to each
 * other. Publishing one is cheap differentiation for agent-to-agent discovery.
 *
 * @param {object} config - Loaded configuration
 * @param {object} req - Express request (for the absolute service URL)
 * @returns {object} Agent card
 */
function buildAgentCard(config, req) {
  const baseUrl = config.growth?.publicUrl || `${req.protocol}://${req.get('host')}`;
  return {
    name: config.resource.serviceName,
    description:
      'PII sanitization service for AI agents. Accepts x402 micropayments in USDC ' +
      'and returns redacted text plus per-class redaction counts.',
    url: baseUrl,
    version: '1.0.0',
    provider: { organization: config.resource.serviceName, url: baseUrl },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'sanitize-pii',
        name: 'Sanitize PII from text',
        description:
          'Redacts emails, phones, SSNs, card numbers, private keys, bearer tokens and ' +
          'URL tokens. Deterministic and cache-backed.',
        tags: ['pii', 'privacy', 'security', 'redaction'],
        examples: ['Contact me at jane@example.com or 555-123-4567'],
      },
    ],
    // How a peer agent pays us: the protocol facts, machine-readable.
    payment: {
      protocol: 'x402',
      version: 2,
      scheme: config.scheme,
      network: config.network,
      price: config.price,
      payTo: config.payToAddress,
      paidEndpoint: `${baseUrl}${config.resource.path}`,
      freeTrialEndpoint: `${baseUrl}/api/sanitize/trial`,
    },
    discovery: {
      x402: `${baseUrl}/.well-known/x402.json`,
      mcp: `${baseUrl}/.well-known/mcp.json`,
      openapi: `${baseUrl}/openapi.json`,
      llmsTxt: `${baseUrl}/llms.txt`,
    },
  };
}
