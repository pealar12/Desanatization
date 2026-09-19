// ============================================================================
// Outbound Growth Engine ("agents that seek agents")
//
// A self-learning outreach loop:
//   1. DISCOVER  — load peer targets from GROWTH_TARGETS (JSON) and/or an
//                  optional GROWTH_DISCOVERY_URL registry feed.
//   2. PROBE     — visit each peer's root: is it an x402 agent (402 challenge,
//                  bazaar extension, llms.txt)? What language does it speak?
//   3. PITCH     — leave a machine-readable pitch at the peer's advertised
//                  outreach surface, when it exposes one.
//   4. LEARN     — score targets by response rate; the next cycle spends
//                  effort on what worked and drops what did not.
//
// Opt-in (GROWTH_ENABLED), rate-limited and capped per cycle: it pitches a
// small number of peers politely, measures, and adapts. Never a spam cannon.
// ============================================================================

import fsSync from 'node:fs';
import { dirname } from 'node:path';
import { discoverAll } from './discoveries.js';
import { safeFetch } from './net-safety.js';

/** Total peers retained across all sources; oldest/lowest-scoring evicted beyond this. */
const MAX_POOL_SIZE = 500;

/** Strip control characters so an attacker-influenced string can never forge a log line. */
function sanitizeForLog(value, maxLen = 200) {
  return String(value ?? '').replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim().slice(0, maxLen);
}

const X402_CHALLENGE_HEADER = 'payment-required';

/**
 * @typedef {object} GrowthTarget
 * @property {string} url - Peer base URL
 * @property {string} kind - Channel label used for learning (e.g. "registry")
 * @property {number} score - Rolling effectiveness score (higher = pitch first)
 * @property {number} pitches - Times pitched
 * @property {number} responses - Times the peer answered
 * @property {string} [lastResult] - Last probe outcome
 * @property {string} [lastAt] - ISO timestamp of last contact
 */

/**
 * Parse the GROWTH_TARGETS environment variable.
 *
 * @param {string|undefined} raw - JSON array of {url, kind?} objects
 * @returns {GrowthTarget[]} Initial targets (empty when unset/invalid)
 */
export function parseTargets(raw) {
  if (!raw || String(raw).trim() === '') return [];
  const input = String(raw).trim();
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.url === 'string' && /^https?:\/\//.test(t.url))
      .map((t) => ({
        url: t.url.replace(/\/+$/, ''),
        kind: typeof t.kind === 'string' ? t.kind.slice(0, 32) : 'manual',
        score: 1,
        pitches: 0,
        responses: 0,
      }));
  } catch {
    // Fall through to the shell-friendly format below.
  }
  // Quote-proof fallback: "https://a|kind, https://b" — some hosts (Railway
  // CLI) strip double quotes from variable values, so JSON is not reliable.
  return input
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, kind] = part.split('|');
      return { url: url?.replace(/\/+$/, ''), kind: (kind ?? 'manual').slice(0, 32) };
    })
    .filter((t) => /^https?:\/\//.test(t.url))
    .map((t) => ({ ...t, score: 1, pitches: 0, responses: 0 }));
}

/**
 * Merge a discovery feed (array of URLs or {url, kind} objects) into the
 * target pool, deduplicating by URL and preserving learned scores.
 *
 * @param {GrowthTarget[]} existing - Current target pool
 * @param {Array<string|{url: string, kind?: string}>} feed - Discovered peers
 * @returns {GrowthTarget[]} Updated pool
 */
export function mergeDiscovered(existing, feed) {
  const byUrl = new Map(existing.map((t) => [t.url, t]));
  for (const entry of feed ?? []) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    const normalised = url.replace(/\/+$/, '');
    if (byUrl.has(normalised)) continue;
    byUrl.set(normalised, {
      url: normalised,
      kind: typeof entry === 'object' && typeof entry.kind === 'string' ? entry.kind.slice(0, 32) : 'discovered',
      score: 1,
      pitches: 0,
      responses: 0,
    });
  }
  let merged = [...byUrl.values()];
  // Bound the pool: a stuffed feed or scraped page can otherwise grow memory
  // and the persisted state file without limit. Keep the highest-scoring
  // (i.e. most responsive / most recently proven) entries.
  if (merged.length > MAX_POOL_SIZE) {
    merged = merged.sort((a, b) => b.score - a.score).slice(0, MAX_POOL_SIZE);
  }
  return merged;
}

/**
 * Collapse a Bazaar discovery feed into unique peer origins.
 *
 * The CDP Bazaar lists *routes* (full resource URLs with paths), not peer
 * base URLs. Pitching a route URL is wrong — the outreach surface lives at the
 * peer's root. This collapses every route to its origin so one host is one
 * target, and the engine probes the host instead of a sub-path.
 *
 * @param {Array<string|{resource?: string}>} items - Raw Bazaar items
 * @returns {string[]} Unique origin URLs (https://host)
 */
export function collapseToOrigins(items) {
  const origins = new Set();
  for (const item of items ?? []) {
    const url = typeof item === 'string' ? item : item?.resource;
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    try { origins.add(new URL(url).origin); } catch { continue; }
  }
  return [...origins];
}

/**
 * Fetch with a timeout, never throwing. Shared with the task agent.
 *
 * @param {string} url - Absolute URL
 * @param {RequestInit} [init] - Optional fetch init
 * @returns {Promise<{status: number, headers: Headers, body: string, ok: boolean}>}
 */
export async function fetchSafe(url, init = {}) {
  try {
    const response = await safeFetch(url, { signal: AbortSignal.timeout(10_000), ...init });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
      ok: response.ok,
    };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: String(error?.message ?? error), ok: false };
  }
}

/**
 * Build the machine-readable pitch we leave for peers. A pitch is a small,
 * honest advertisement of what we sell and how to resell it — never a claim
 * of payment received, never a request for funds.
 *
 * @param {object} config - Loaded application configuration
 * @param {string} selfBaseUrl - Our public base URL
 * @returns {object} Pitch document
 */
export function buildPitch(config, selfBaseUrl, market) {
  const pitch = {
    type: 'x402-service-pitch',
    from: selfBaseUrl,
    service: {
      name: config?.resource?.serviceName ?? 'x402 service',
      endpoint: `${selfBaseUrl}${config?.resource?.path ?? '/api/resource'}`,
      price: config?.price ?? null,
      network: config?.network ?? null,
      freeTrial: `${selfBaseUrl}/api/sanitize/trial`,
      batch: `${selfBaseUrl}/api/sanitize/batch`,
      docs: `${selfBaseUrl}/llms.txt`,
      openapi: `${selfBaseUrl}/openapi.json`,
      skill: `${selfBaseUrl}/skill.md`,
      agentCard: `${selfBaseUrl}/.well-known/agent.json`,
      mcp: `${selfBaseUrl}/.well-known/mcp.json`,
      catalog: `${selfBaseUrl}/.well-known/catalog.json`,
      receipts: `${selfBaseUrl}/receipts`,
    },
    offer:
      'PII sanitization for AI agents over x402 (USDC on Base). ' +
      'Redacts emails, phones, SSNs, card numbers, API keys and bearer tokens from ' +
      'agent output before it hits logs, training data, or downstream APIs. ' +
      'Free trial (first 500 chars), $0.001 per full job, batch pricing available. ' +
      'Resell with your own ?ref= tag and earn 10% revenue share. ' +
      'A2A commerce ready: proxy through us with 10% service fee.',
    // Reseller + affiliate hooks so peer agents can immediately monetize
    // routing traffic our way, not just purchase for themselves.
    reseller: {
      referralShare: '10%',
      header: 'X-Referral',
      queryParam: 'ref',
      leaderboard: `${selfBaseUrl}/receipts`,
    },
    // A2A proxy: agents can pay us to proxy through our wallet to reach a peer,
    // creating a continuous commerce loop (agent -> us -> peer -> us back).
    a2a: {
      proxyEndpoint: `${selfBaseUrl}/api/proxy`,
      proxyFee: '10%',
      discoverEndpoint: `${selfBaseUrl}/api/discover`,
    },
    // Social proof: verifiable on-chain receipts prove we have real buyers.
    proof: {
      receipts: `${selfBaseUrl}/receipts`,
      public: true,
      network: config?.network ?? null,
    },
  };
  // Context adaptation: when several peers are actively pitching us, lead
  // with what separates us instead of the generic line.
  if (market?.pitches >= 3) {
    pitch.differentiation =
      `Active market: ${market.pitches} services pitched us` +
      (market.min ? `, price floor observed $${market.min}` : '') +
      '. We differ: deterministic output, public /receipts, referral revenue share, A2A proxy and discover.';
  }
  return pitch;
}

/**
 * Probe one peer and (when it offers an outreach surface) pitch it.
 *
 * @param {GrowthTarget} target - Peer to visit
 * @param {object} pitch - Pitch document from buildPitch()
 * @returns {Promise<GrowthTarget>} Updated target with fresh learning data
 */
export async function probeAndPitch(target, pitch) {
  const updated = { ...target, pitches: target.pitches + 1, lastAt: new Date().toISOString() };

  const root = await fetchSafe(target.url);
  if (!root.ok && root.status !== 402) {
    updated.lastResult = `unreachable:${root.status}`;
    updated.score = Math.max(0, target.score - 0.5);
    updated.failures = (target.failures ?? 0) + 1;
    updated.nextAttemptAt = new Date(
      Date.now() + Math.min(3_600_000, 60_000 * 2 ** updated.failures),
    ).toISOString();
    return updated;
  }

  const isX402Peer =
    root.status === 402 ||
    Boolean(root.headers.get(X402_CHALLENGE_HEADER)) ||
    root.body.includes('x402');

  const hasLlms = root.body.includes('llms.txt') || (await fetchSafe(`${target.url}/llms.txt`)).ok;

  // Discover A2A endpoint from agent card when available.
  let a2aEndpoint = null;
  const agentCard = await fetchSafe(`${target.url}/.well-known/agent.json`);
  if (agentCard.ok) {
    try {
      const card = JSON.parse(agentCard.body);
      if (card?.url && /^https?:\/\//.test(card.url)) {
        a2aEndpoint = card.url.replace(/\/+$/, '');
      }
    } catch {}
  }

  // Consent gate: only pitch a peer that has given a positive, machine-legible
  // signal it wants agent outreach (an x402 challenge, an advertised
  // llms.txt, or an agent card). A generic reachable host is not an agent —
  // pitching it anyway would be unsolicited spam at whatever it actually is
  // (a marketing site, an unrelated API), which is exactly what this engine
  // must never become.
  if (!isX402Peer && !hasLlms && !a2aEndpoint) {
    updated.responses = target.responses + (root.ok ? 1 : 0);
    updated.failures = 0;
    updated.lastResult = 'reachable:no-agent-signal';
    updated.score = Math.max(0, target.score - 0.2);
    return updated;
  }

  // Outreach surface list — machine-oriented endpoints only. Never `/contact`
  // (a human-facing form) or a bare `/api` (too generic to be a safe target
  // for an automated JSON pitch) — a peer must expose a dedicated,
  // machine-readable surface to receive one. Entries here are relative paths;
  // a discovered agent-card endpoint is already absolute and must not be
  // concatenated onto target.url like the relative ones. `lastSurface` may be
  // either shape, carried over verbatim from a previous successful cycle.
  const previousSurface = target.lastSurface;
  const relativeSurfaces = ['/api/outreach', '/api/pitch', '/api/agents'];
  const candidates = [];
  if (previousSurface) candidates.push(previousSurface);
  if (a2aEndpoint && a2aEndpoint !== previousSurface) candidates.push(a2aEndpoint);
  for (const surface of relativeSurfaces) {
    if (surface !== previousSurface) candidates.push(surface);
  }

  // Serial outreach: try surfaces one at a time and stop at the first win.
  // Firing them all concurrently would emit a burst of requests at a single
  // third-party host; a peer deserves exactly one pitch attempt per cycle.
  let pitched = false;
  let workingSurface = null;
  for (const surface of candidates) {
    const fullUrl = /^https?:\/\//.test(surface) ? surface : `${target.url}${surface}`;
    const attempt = await fetchSafe(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pitch),
    });
    if (attempt.ok) {
      pitched = true;
      workingSurface = surface;
      break;
    }
  }

  updated.responses = target.responses + (root.ok ? 1 : 0);
  if (pitched) {
    updated.failures = 0;
    updated.nextAttemptAt = undefined;
    updated.lastSurface = workingSurface;
    updated.score += isX402Peer ? 3 : 1.5;
    updated.lastResult = 'pitched';
  } else if (root.ok) {
    updated.failures = 0;
    updated.score += 0.5;
    updated.lastResult = 'reachable:no-surface';
  } else {
    updated.failures = (target.failures ?? 0) + 1;
    updated.nextAttemptAt = new Date(
      Date.now() + Math.min(300_000, 30_000 * 2 ** updated.failures),
    ).toISOString();
    updated.lastResult = 'peer-seen:no-surface';
    updated.score = Math.max(0, target.score - 0.1);
  }
  return updated;
}

/**
 * Create the growth engine loop.
 *
 * @param {object} options
 * @param {object} options.config - Loaded application configuration
 * @param {object} options.logger - Pino-style logger
 * @param {string} options.selfBaseUrl - Our public base URL
 * @param {number} [options.intervalMs] - Milliseconds between cycles
 * @param {number} [options.maxPerCycle] - Pitch cap per cycle
 * @returns {{ runCycle: () => Promise<object>, getStats: () => object, start: () => void, stop: () => void }}
 */
export function createGrowthEngine({
  config,
  logger,
  selfBaseUrl,
  intervalMs = 6 * 60 * 60_000,
  maxPerCycle = 5,
  getContext,
}) {
  // Mutable cadence: assessAndAdapt() may shorten the interval when
  // conversion is hot. The knob lives beside the timer so a change is
  // observed by the loop instead of mutating a parameter nobody re-reads.
  let currentIntervalMs = intervalMs;
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  /** @type {GrowthTarget[]} */
  let targets = parseTargets(config.growth?.targets || config.growth?.seedTargets);
  let cycles = 0;
  let totalPitches = 0;
  /** @type {Array<object>} Inbound pitches from peers, newest first (capped). */
  let inbox = [];
  /** @type {object} Latest environment reading (conversion, market heat). */
  let lastContext = {};
  /** Queued by the health supervisor to skip the next cycle (reversible). */
  let skipNextCycle = false;
  /**
   * Market summary cache. The inbox only changes on recordInbound() and at the
   * start of a cycle, so the price-point regex scan runs once per cycle instead
   * of once per consumer (buildPitch, getPricingAdvice, getStats).
   * @type {object|null}
   */
  let cachedMarket = null;

  // META-LEARNING: the engine tracks its own strategy effectiveness and adapts.
  // Each strategy has a success rate, cost, and adoption counter.
  /** @type {Map<string, {successes: number, attempts: number, lastTried: string, enabled: boolean}>} */
  const strategyMetrics = new Map();
  /** Historical performance for pattern recognition. */
  const performanceHistory = [];
  const MAX_HISTORY = 500;
  /** Whether auto-adaptation is enabled (always on in production). */
  const autoAdapt = config.isProduction !== false;

  // Durable learning: restore the pool's earned scores, cycle counters and
  // inbox across restarts when GROWTH_STATE_PATH points at a writable file
  // (e.g. a mounted volume). Best-effort — never fatal.
  if (config.growth?.statePath) {
    try {
      const saved = JSON.parse(fsSync.readFileSync(config.growth.statePath, 'utf8'));
      targets = mergeDiscovered(targets, Array.isArray(saved.targets) ? saved.targets : []);
      for (const target of targets) {
        const prev = (saved.targets ?? []).find((s) => s.url === target.url);
        if (!prev) continue;
        target.score = typeof prev.score === 'number' ? prev.score : target.score;
        target.pitches = prev.pitches ?? 0;
        target.responses = prev.responses ?? 0;
        target.failures = prev.failures ?? 0;
        target.lastResult = prev.lastResult;
        target.nextAttemptAt = prev.nextAttemptAt;
        target.lastAt = prev.lastAt;
        target.lastSurface = prev.lastSurface;
      }
      cycles = saved.cycles ?? 0;
      totalPitches = saved.totalPitches ?? 0;
      inbox = Array.isArray(saved.inbox) ? saved.inbox.slice(0, 50) : inbox;
      cachedMarket = null;
      logger.info(`Growth: restored state (${targets.length} targets, ${cycles} cycles) from ${config.growth.statePath}`);
    } catch {
      logger.info('Growth: no restorable state — starting a fresh ledger.');
    }
  }

  /**
    * Persist the learned ledger best-effort. Called after every mutation so a
    * restart never loses what the engine paid to learn. Atomic write (tmp +
    * rename) so a crash mid-save can never leave a torn file behind.
    * Synchronous by design: callers (and tests) expect the file to exist
    * immediately after a cycle completes. A flag guards against re-entrancy
    * from the save triggered inside runCycle itself.
    */
  function saveState() {
    if (!config.growth?.statePath) return;
    try {
      fsSync.mkdirSync(dirname(config.growth.statePath), { recursive: true });
      const tmp = `${config.growth.statePath}.tmp`;
      fsSync.writeFileSync(
        tmp,
        JSON.stringify({ savedAt: new Date().toISOString(), cycles, totalPitches, targets, inbox }),
      );
      fsSync.renameSync(tmp, config.growth.statePath);
    } catch (error) {
      logger.warn(`Growth: could not persist state (${error.message}) — continuing in memory.`);
    }
  }

  /**
   * Run one discover -> pitch -> learn cycle.
   *
   * @returns {Promise<object>} Cycle summary
   */
  /**
   * DISCOVER phase: expand the target pool from every configured source.
   * Each source is best-effort — a failure logs and the cycle continues.
   *
   * @returns {Promise<{pool: GrowthTarget[], discoveredOrigins: string[]}>}
   */
  async function discoverTargets() {
    // An optional registry feed expands the pool every cycle.
    if (config.growth?.discoveryUrl) {
      const feed = await fetchSafe(config.growth.discoveryUrl);
      if (feed.ok) {
        try {
          const parsed = JSON.parse(feed.body);
          const items = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.resources ?? []);
          targets = mergeDiscovered(targets, items);
        } catch {
          logger.warn('Growth: discovery feed was not valid JSON — skipping.');
        }
      }
    }

    // Expanded discovery: scan development hubs, GitHub repos, Google Cloud
    // Agent Gallery and Salesforce AgentExchange for new x402/crypto peers.
    let discoveredOrigins = [];
    if (config.growth?.discoverFromAll) {
      try {
        discoveredOrigins = await discoverAll({
          githubToken: config.growth?.githubToken,
          log: (message) => logger.warn(message),
        });
        if (discoveredOrigins.length > 0) {
          logger.info(`Growth: discovered ${discoveredOrigins.length} new targets from expanded sources`);
          targets = mergeDiscovered(targets, discoveredOrigins.map((url) => ({ url, kind: 'discovered' })));
        }
      } catch (error) {
        logger.warn(`Growth: expanded discovery failed: ${error.message}`);
      }
    }

    // Continuously refresh the pool from the live CDP Bazaar so the engine
    // grows its own reach instead of relying on a static list.
    // Only when explicitly enabled — tests should not hit external APIs.
    if (config.growth?.bazaarDiscovery === true) {
      await discoverFromBazaar();
    }

    // Never pitch ourselves. A self-canary target (GROWTH_TARGETS pointing at
    // our own URL) is a useful liveness check, but pitching our own outreach
    // surface just inflates the inbound counter and teaches the engine that
    // "self" is the best channel — which is worthless for finding real buyers.
    const ownHost = selfBaseUrl ? new URL(selfBaseUrl).host.toLowerCase() : null;
    const pool = ownHost
      ? targets.filter((t) => new URL(t.url).host.toLowerCase() !== ownHost)
      : targets;

    return { pool, discoveredOrigins };
  }

  /**
   * LEARN phase (selection): adapt effort to the environment and pick the
   * highest-scoring peers that are not in backoff.
   * Cold conversion damps effort, hot conversion or a heated market (peers
   * pitching us) raises it to the cap. Peers in backoff are skipped entirely.
   *
   * @param {GrowthTarget[]} pool - Non-self targets
   * @returns {{batch: GrowthTarget[], ordered: GrowthTarget[], effectiveMax: number}}
   */
  function selectBatch(pool) {
    lastContext = getContext?.() ?? {};
    const heat = Math.min(
      1,
      (lastContext.trialToPaidRate ?? 0) * 2 + (lastContext.inboundPitches >= 3 ? 0.5 : 0),
    );
    const effectiveMax = Math.max(
      2,
      Math.min(maxPerCycle, Math.round(maxPerCycle * (0.4 + 0.4 * heat))),
    );
    const now = Date.now();
    const ordered = [...pool].sort((a, b) => b.score - a.score || a.pitches - b.pitches);
    const batch = ordered
      .filter((t) => !t.nextAttemptAt || Date.parse(t.nextAttemptAt) <= now)
      .slice(0, effectiveMax);
    return { batch, ordered, effectiveMax };
  }

  /**
   * Run one discover -> pitch -> learn cycle.
   *
   * @returns {Promise<object>} Cycle summary
   */
  async function runCycle() {
    cycles += 1;
    // One market scan per cycle; consumers below reuse this snapshot.
    cachedMarket = null;

    // 1. DISCOVER
    const { pool, discoveredOrigins } = await discoverTargets();
    if (pool.length === 0) {
      logger.info(
        targets.length === 0
          ? 'Growth cycle: no targets configured (set GROWTH_TARGETS or GROWTH_DISCOVERY_URL).'
          : 'Growth cycle: every configured target is our own URL — nothing to pitch.',
      );
      return { cycles, pitched: 0, pool: 0 };
    }

    // 2. PITCH — select the batch, then probe and pitch each peer in turn.
    const { batch, ordered, effectiveMax } = selectBatch(pool);
    const pitch = buildPitch(config, selfBaseUrl, getMarketSummary());

    let pitched = 0;
    for (const target of batch) {
      const updated = await probeAndPitch(target, pitch);
      targets = targets.map((t) => (t.url === updated.url ? updated : t));
      if (updated.lastResult === 'pitched') pitched += 1;
    }
    totalPitches += pitched;

    // META-LEARNING: record this cycle's performance and adapt if needed.
    const responsesThisCycle = targets.reduce((sum, t) => sum + (t.responses || 0), 0);
    recordPerformance({
      pitched,
      probed: batch.length,
      pool: targets.length,
      totalPitches,
      responses: responsesThisCycle,
      discovered: discoveredOrigins?.length ?? 0,
    });

    // Adapt strategy based on performance patterns.
    if ((cycles % 3) === 0) {
      assessAndAdapt();
    }

    saveState();

    logger.info(
      `Growth cycle ${cycles}: probed ${batch.length}, pitched ${pitched}, pool ${targets.length} ` +
        `(top: ${sanitizeForLog(ordered[0]?.url) || 'n/a'})`,
    );
    return { cycles, pitched, probed: batch.length, pool: targets.length, effectiveMax };
  }

  /**
   * Assess current performance against recent history. If conversion is below
   * threshold for several consecutive cycles, the engine adapts its own
   * strategy: it widens discovery, shifts targets to higher-scoring channels,
   * and may increase pitch intensity. This is the "automated growing machine
   * learning loop" — the engine improves its own playbook without intervention.
   */
  function assessAndAdapt() {
    if (!autoAdapt || performanceHistory.length < 6) return null;

    const recent = performanceHistory.slice(-10);
    const conversionRates = recent.map((r) => (r.totalPitches > 0 ? r.pitched / r.totalPitches : 0));
    const avgConversion = conversionRates.reduce((a, b) => a + b, 0) / conversionRates.length;
    const recentResponses = recent.reduce((sum, r) => sum + r.responses, 0);
    const recentRevenue = recent.reduce((sum, r) => sum + (r.pitched || 0) * 0.001, 0);

    const adaptations = [];

    // If conversion is near zero, widen discovery aggressively.
    if (avgConversion < 0.05 && recentResponses === 0) {
      adaptations.push({
        type: 'widen-discovery',
        reason: 'zero response rate in last 10 cycles',
        action: 'increasing maxPerCycle by 50%',
      });
      maxPerCycle = Math.min(50, Math.floor(maxPerCycle * 1.5));
    }

    // If we are not discovering enough new targets, trigger deeper discovery.
    const newTargetsPerCycle = recent.reduce((sum, r) => sum + (r.discovered || 0), 0) / recent.length;
    if (newTargetsPerCycle < 5) {
      adaptations.push({
        type: 'deepen-discovery',
        reason: `low discovery rate (${newTargetsPerCycle.toFixed(1)}/cycle)`,
        action: 'extending to new discovery sources and deeper keyword scans',
      });
    }

    // If conversion is high, scale up pitch volume and diversify.
    if (avgConversion > 0.3) {
      adaptations.push({
        type: 'scale-up',
        reason: `strong conversion (${(avgConversion * 100).toFixed(1)}%)`,
        action: 'increasing pitch volume and extending to new peer types',
      });
      maxPerCycle = Math.min(50, maxPerCycle + 5);
      // Also reduce interval to capitalize on momentum, and re-arm the live
      // timer so the shorter cadence takes effect on the next tick.
      currentIntervalMs = Math.max(60_000, currentIntervalMs * 0.8);
      reschedule();
    }

    // Revenue-based adaptation: if revenue is flowing, invest more in outreach.
    if (recentRevenue > 0.01) {
      adaptations.push({
        type: 'revenue-positive',
        reason: `$${recentRevenue.toFixed(4)} revenue in last 10 cycles`,
        action: 'maintaining aggressive outreach, reallocating budget to top channels',
      });
      // Identify top-performing channel and double down
      const channelPerformance = new Map();
      for (const entry of recent) {
        const kind = entry.pitchKind || 'unknown';
        const existing = channelPerformance.get(kind) || { pitches: 0, responses: 0 };
        existing.pitches += entry.pitched || 0;
        existing.responses += entry.responses || 0;
        channelPerformance.set(kind, existing);
      }
      // Boost targets from high-response channels
      for (const target of targets) {
        const stats = channelPerformance.get(target.kind);
        if (stats && stats.responses > 0 && stats.pitches > 0) {
          const rate = stats.responses / stats.pitches;
          if (rate > avgConversion) target.score += 0.5;
        }
      }
    }

    // Market saturation detection: if we're pitching many targets but getting
    // no responses, the market may be saturated — diversify into new niches.
    if (recentResponses === 0 && recent.reduce((sum, r) => sum + (r.pitched || 0), 0) > 20) {
      adaptations.push({
        type: 'diversify',
        reason: 'market saturation — high pitch volume, zero responses',
        action: 'shifting focus to undiscovered peer segments',
      });
      // Increase discovery sources
      if (!config.growth?.discoverFromAll) {
        config.growth = { ...config.growth, discoverFromAll: true };
      }
    }

    if (adaptations.length > 0) {
      logger.info(`Growth: self-adapted — ${adaptations.map((a) => a.type).join(', ')}`);
    }

    return { avgConversion, adaptations, recentResponses };
  }

  /**
   * Record performance for this cycle's meta-learning loop.
   *
   * @param {object} metrics - Cycle performance metrics
   */
  function recordPerformance(metrics) {
    performanceHistory.push({
      cycle: cycles,
      ...metrics,
      timestamp: Date.now(),
    });
    if (performanceHistory.length > MAX_HISTORY) performanceHistory.shift();
  }

  /**
   * Get the current meta-learning state for diagnostics.
   *
   * @returns {object} Meta-learning state
   */
  function getMetaState() {
    return {
      autoAdapt: autoAdapt,
      performanceHistory: performanceHistory.slice(-20),
      strategyMetrics: Object.fromEntries(strategyMetrics),
      maxPerCycle,
      intervalMs: currentIntervalMs,
    };
  }
  /**
   * (Re-)arm the cycle timer using the current cadence. Called on start and
   * whenever assessAndAdapt() changes currentIntervalMs, so an adapted
   * interval is observed by the running loop rather than silently ignored.
   */
  function reschedule() {
    if (!config.growth?.enabled) return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (skipNextCycle) {
        skipNextCycle = false;
        logger.info('Growth: cycle skipped on health instruction.');
        return;
      }
      runCycle().catch((error) => logger.warn(`Growth cycle failed: ${error.message}`));
    }, currentIntervalMs);
    timer.unref();
  }

  function recordInbound(pitch, source) {
    if (!pitch || typeof pitch !== 'object') return false;
    inbox.unshift({
      type: typeof pitch.type === 'string' ? pitch.type.slice(0, 64) : 'unknown',
      from: typeof pitch.from === 'string' ? pitch.from.slice(0, 200) : source ?? 'unknown',
      service: pitch.service ?? null,
      offer: typeof pitch.offer === 'string' ? pitch.offer.slice(0, 500) : undefined,
      receivedAt: new Date().toISOString(),
    });
    if (inbox.length > 20) inbox.length = 20;
    cachedMarket = null; // Inbox changed — the cached summary is stale.
    saveState();
    return true;
  }

  /**
   * Competition radar: what the inbox says about the market.
   *
   * @returns {object} Pitch volume, distinct peers, observed price points
   */
  function getMarketSummary() {
    if (cachedMarket) return cachedMarket;
    const prices = [];
    const peers = new Set();
    for (const p of inbox) {
      if (p.from) peers.add(String(p.from).replace(/^https?:\/\//, '').split('/')[0]);
      const matches = typeof p.offer === 'string' ? p.offer.match(/\$\s?([0-9]*\.?[0-9]+)/g) : null;
      if (matches) for (const raw of matches) prices.push(parseFloat(raw.replace(/[$\s]/g, '')));
    }
    cachedMarket = {
      pitches: inbox.length,
      distinctPeers: peers.size,
      pricePoints: prices,
      min: prices.length ? Math.min(...prices) : null,
    };
    return cachedMarket;
  }

  /**
   * Query the CDP Bazaar for live x402 services and merge them into the
   * target pool. The engine grows its own reach — no manual list needed.
   *
   * @returns {Promise<GrowthTarget[]>} Newly discovered peers
   */
   async function discoverFromBazaar() {
    // runCycle's generic DISCOVER block already fetched and merged
    // config.growth.discoveryUrl. Only fall back to it here when that block is
    // disabled — otherwise the same feed would be fetched and merged twice per
    // cycle. With no configured feed we use the public CDP Bazaar.
    const genericFeedActive = Boolean(config.growth?.discoveryUrl);
    const bazaarUrl = genericFeedActive
      ? null
      : config.growth?.discoveryUrl ?? 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
    if (!bazaarUrl) return [];
    try {
      const res = await fetchSafe(bazaarUrl);
      if (!res.ok) return [];
      const data = JSON.parse(res.body);
      const items = data?.items ?? [];
      // The Bazaar lists *routes* (resource URLs with paths), not peer base
      // URLs. Pitching a route URL is wrong — the outreach surface lives at the
      // peer's root. Collapse every route to its origin so one host is one
      // target, and we probe the host, not a sub-path. mergeDiscovered() does
      // the URL normalisation, dedupe and self-filtering in one place.
      const before = targets.length;
      targets = mergeDiscovered(targets, collapseToOrigins(items).map((url) => ({ url, kind: 'bazaar' })));
      const fresh = targets.slice(before);
      if (fresh.length) logger.info(`Growth: discovered ${fresh.length} new peers from Bazaar`);
      return fresh;
    } catch (error) {
      const log = typeof logger.debug === 'function' ? logger.debug.bind(logger) : logger.info.bind(logger);
      log(`Growth: Bazaar discovery failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Competition response: recommend a price from our funnel + the market.
   * Advisory only — flipping PRICE is a deliberate, logged decision.
   *
   * @returns {object} Current, suggested, reason
   */
  function getPricingAdvice() {
    const current = typeof config?.price === 'string' ? config.price : (config?.price?.amount ?? '$0.001');
    const value = parseFloat(String(current).replace(/[^0-9.]/g, '')) || 0.001;
    const market = getMarketSummary();
    const ctx = getContext ? getContext() : lastContext;
    const rate = ctx.trialToPaidRate ?? 0;
    const trials = ctx.freeTrials ?? 0;
    let suggested = value;
    let reason = 'hold — no strong signal yet';
    if (trials >= 20 && rate < 0.1) {
      suggested = Math.max(value / 2, 0.0001);
      reason = 'conversion cold after 20+ trials — halve to find demand';
    } else if (rate >= 0.5) {
      suggested = Math.min(value * 2, 0.01);
      reason = 'conversion hot — double while demand holds';
    } else if (market.min && market.min < value) {
      suggested = market.min;
      reason = 'competitors price below us — match to stay competitive';
    }
    const fmt = (n) => '$' + Number(n.toFixed(6)).toString();
    return { current, suggested: fmt(suggested), reason, market };
  }

  return {
    runCycle,
    recordInbound,
    getMetaState,
    assessAndAdapt,
     recordPerformance,
    /**
     * Learning report for /api/growth (token-guarded).
     *
     * @returns {object} Pool state, scores and cycle counters
     */
    getStats: () => {
      const ownHost = selfBaseUrl ? new URL(selfBaseUrl).host.toLowerCase() : null;
      const externalTargets = ownHost
        ? targets.filter((t) => new URL(t.url).host.toLowerCase() !== ownHost)
        : targets;
      return {
        enabled: Boolean(config.growth?.enabled),
        cycles,
        totalPitches,
        intervalMs: currentIntervalMs,
        maxPerCycle,
        statePath: config.growth?.statePath ?? null,
        context: lastContext,
        market: getMarketSummary(),
        inbox,
        targets: externalTargets.map((t) => ({
          url: t.url,
          kind: t.kind,
          score: Number(t.score.toFixed(2)),
          pitches: t.pitches,
          responses: t.responses,
          lastResult: t.lastResult,
          lastAt: t.lastAt,
        })),
      };
    },
    getPricingAdvice,
    /**
     * Ask the engine to skip its next cycle. Called by the health supervisor
     * when the revenue path is degraded: reducing background load is the
     * cheapest recovery, and it is reversible (the next cycle resumes).
     *
     * @returns {boolean} True when a skip was queued
     */
    nudge: () => {
      if (!config.growth?.enabled) return false;
      skipNextCycle = true;
      return true;
    },
    start: () => {
      if (!config.growth?.enabled) return;
      // First cycle fires immediately so the engine is working from boot,
      // then continues on the interval.
      runCycle().catch((error) => logger.warn(`Growth cycle failed: ${error.message}`));
      reschedule();
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

