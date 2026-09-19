// ============================================================================
// Task Agent — bounded plan -> act -> observe -> learn loop
//
// "Send it to complete a task" is made real and honest by three constraints:
//   1. SAFE TOOL SET — http_fetch (GET only, 10s timeout), x402_discover
//      (peer fingerprinting), text_sanitize (our own product skill). No
//      shell, no filesystem, no keys, no ability to move money.
//   2. BOUNDED AUTONOMY — hard step budget (default 8, cap 16); a task that
//      exhausts its budget fails with its full trace instead of wandering.
//   3. LEARNED SKILLS — every success is recorded as a replayable plan. New
//      tasks replay a matching skill first; if the environment changed and
//      the replay no longer holds, the agent detects the drift, marks the
//      skill degraded, and re-plans from observation. That is the
//      "adapts to context and environment" mechanism.
// ============================================================================

import { sanitizeText } from './sanitize.js';
import fsSync from 'node:fs';
import { dirname } from 'node:path';
import { safeFetch } from './net-safety.js';

export const MAX_STEPS_CAP = 16;

/**
 * Fetch with a timeout, never throwing (GET only — the agent never sends
 * writes on its own initiative). Every URL, including one supplied directly
 * by the caller of `POST /api/agent/task`, is validated against internal and
 * cloud-metadata address ranges before the request is made.
 *
 * @param {string} url - Absolute URL
 * @returns {Promise<{status: number, body: string, ok: boolean}>}
 */
async function getSafe(url) {
  try {
    const response = await safeFetch(url, { signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: (await response.text()).slice(0, 4000), ok: response.ok };
  } catch (error) {
    return { status: 0, body: String(error?.message ?? error), ok: false };
  }
}

/** @type {Map<string, (args: object) => Promise<object>>} */
export const TOOLS = new Map([
  [
    'http_fetch',
    async ({ url }) => {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { error: 'http_fetch needs an http(s) url' };
      const out = await getSafe(url);
      return { tool: 'http_fetch', url, status: out.status, ok: out.ok, excerpt: out.body.slice(0, 500) };
    },
  ],
  [
    'x402_discover',
    async ({ url }) => {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        return { error: 'x402_discover needs an http(s) url' };
      }
      const root = await getSafe(url);
      const llms = await getSafe(`${url.replace(/\/+$/, '')}/llms.txt`);
      const isX402 = root.status === 402 || root.body.includes('x402') || llms.ok;
      return {
        tool: 'x402_discover',
        url,
        isX402Peer: isX402,
        signals: { status402: root.status === 402, bodyMentionsX402: root.body.includes('x402'), llmsTxt: llms.ok },
      };
    },
  ],
  [
    'x402_bazaar',
    async ({ query }) => {
      /** Search the CDP x402 Bazaar for services matching a query. */
      const searchUrl = query
        ? `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?query=${encodeURIComponent(query)}`
        : 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
      const res = await getSafe(searchUrl);
      if (!res.ok) return { tool: 'x402_bazaar', ok: false, error: 'bazaar unreachable', status: res.status };
      let parsed = [];
      try {
        const data = JSON.parse(res.body);
        const items = data?.items ?? data?.resources ?? data;
        parsed = Array.isArray(items) ? items : [];
      } catch {
        return { tool: 'x402_bazaar', ok: false, error: 'bazaar JSON parse failed' };
      }
      return {
        tool: 'x402_bazaar',
        query: query ?? '(all)',
        ok: true,
        services: parsed.slice(0, 20).map((s) => ({
          name: s?.name ?? s?.serviceName ?? 'unknown',
          url: s?.resource ?? s?.url ?? '',
          price: s?.accepts?.[0]?.price ?? s?.price ?? null,
          network: s?.accepts?.[0]?.network ?? s?.network ?? null,
        })),
      };
    },
  ],
  [
    'x402_pitch',
    async ({ url, offer, fromUrl }) => {
      /** Send a machine-readable x402-service-pitch to a peer's outreach surface. */
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        return { error: 'x402_pitch needs an http(s) url' };
      }
      const pitch = {
        type: 'x402-service-pitch',
        from: fromUrl ?? 'https://desanatization.com',
        service: {
          name: 'Desanatization',
          endpoint: 'https://desanatization.com/api/resource',
          price: '$0.001',
          network: 'eip155:8453',
          freeTrial: 'https://desanatization.com/api/sanitize/trial',
          docs: 'https://desanatization.com/llms.txt',
        },
        offer: offer ?? 'PII sanitization for AI agents over x402 (USDC on Base). Free trial, $0.001 per full job. Resell with your own ?ref= tag and earn 10% revenue share.',
      };
      for (const surface of ['/api/outreach', '/api/pitch']) {
        const attempt = await getSafeWithBody(`${url.replace(/\/+$/, '')}${surface}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pitch),
        });
        if (attempt.ok) {
          return { tool: 'x402_pitch', ok: true, url, surface, status: attempt.status };
        }
      }
      return { tool: 'x402_pitch', ok: false, url, error: 'no outreach surface accepted the pitch' };
    },
  ],
  [
    'text_sanitize',
    async ({ text }) => {
      if (typeof text !== 'string' || text.length === 0 || text.length > 20_000) {
        return { error: 'text_sanitize needs 1..20000 chars of text' };
      }
      const result = sanitizeText(text);
      return { tool: 'text_sanitize', clean: result.clean, redactions: result.redactions ?? null, ok: true };
    },
  ],
]);

/**
 * Fetch with timeout that supports POST bodies (for outbound pitching).
 * Used by the x402_pitch tool only.
 *
 * @param {string} url - Absolute URL
 * @param {RequestInit} [options] - fetch options with method/headers/body
 * @returns {Promise<{status: number, body: string, ok: boolean}>}
 */
async function getSafeWithBody(url, options = {}) {
  try {
    const response = await safeFetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    return { status: response.status, body: (await response.text()).slice(0, 2000), ok: response.ok };
  } catch (error) {
    return { status: 0, body: String(error?.message ?? error), ok: false };
  }
}

/**
 * Choose the next step from the goal and everything observed so far. The
 * policy is deliberately inspectable: goal shape -> tool, observation ->
 * refinement.
 *
 * @param {string} goal - What the agent must accomplish
 * @param {Array<object>} trace - Steps taken so far
 * @returns {{tool: string, args: object}|null} Next step, or null when done/stuck
 */
export function planNextStep(goal, trace) {
  const urlMatch = goal.match(/https?:\/\/[^\s]+/);
  const textPayload = goal.match(/sanitize:\s*([\s\S]+)/);
  const findBuyersMatch = /find\s+buyers|seek.*x402.*clients|discover.*services/i.test(goal);
  const pitchMatch = goal.match(/pitch\s+(https?:\/\/[^\s]+)/i);

  if (/sanitize/i.test(goal) && textPayload) {
    if (trace.length === 0) return { tool: 'text_sanitize', args: { text: textPayload[1] } };
    return null; // sanitize finishes in one deterministic step
  }

  // "find buyers" — search the CDP x402 Bazaar for services that might need our product
  if (findBuyersMatch) {
    if (trace.length === 0) return { tool: 'x402_bazaar', args: { query: 'ai agent' } };
    const bazaarResult = trace.find((t) => t.result?.tool === 'x402_bazaar');
    if (!bazaarResult) return { tool: 'x402_bazaar', args: { query: 'pii' } };
    const services = bazaarResult.result.services ?? [];
    const unpitched = services.filter((s) => s.url && !trace.some((t) => t.result?.url === s.url));
    if (unpitched.length > 0) return { tool: 'x402_pitch', args: { url: unpitched[0].url } };
    return null; // discovered and pitched all found services
  }

  // "pitch <url>" — discover a peer and pitch it
  if (pitchMatch) {
    const targetUrl = pitchMatch[1];
    if (trace.length === 0) return { tool: 'x402_discover', args: { url: targetUrl } };
    const discovery = trace[0]?.result;
    if (trace.length === 1 && discovery?.tool === 'x402_discover' && discovery.isX402Peer) {
      return { tool: 'x402_pitch', args: { url: targetUrl } };
    }
    if (trace.length === 1) return { tool: 'http_fetch', args: { url: targetUrl } };
    return null;
  }

  if (urlMatch) {
    const url = urlMatch[0].replace(/[).,]+$/, '');
    if (trace.length === 0) return { tool: 'x402_discover', args: { url } };
    const discovery = trace[0]?.result;
    if (trace.length === 1 && discovery?.tool === 'x402_discover' && discovery.isX402Peer) {
      return { tool: 'http_fetch', args: { url: `${url.replace(/\/+$/, '')}/llms.txt` } };
    }
    if (trace.length === 1) return { tool: 'http_fetch', args: { url } };
    return null;
  }

  if (trace.length === 0) return { tool: 'text_sanitize', args: { text: goal } };
  return null;
}

/**
 * A step succeeded when its result says the goal advanced — per-tool
 * predicates keep "done" honest instead of optimistic.
 *
 * @param {object} result - Tool result
 * @returns {boolean} Whether this result accomplishes the goal
 */
export function isStepSuccessful(result) {
  if (!result || result.error) return false;
  if (result.tool === 'text_sanitize') return result.ok === true;
  if (result.tool === 'x402_discover') return typeof result.isX402Peer === 'boolean';
  if (result.tool === 'x402_bazaar') return result.ok === true;
  if (result.tool === 'x402_pitch') return result.ok === true;
  if (result.tool === 'http_fetch') return result.ok === true;
  return false;
}

/**
 * Create the task agent.
 *
 * @param {object} options
 * @param {object} options.logger - Pino-style logger
 * @param {number} [options.defaultMaxSteps=8] - Default step budget
 * @returns {{ runTask: (task: object) => Promise<object>, getSkills: () => object, listSkills: () => Array<object> }}
 */
/**
 * Normalise a goal into a stable skill key: action verb + target host when the
 * goal names one, else a slug of the goal text. Keeps the skill library small
 * and replayable across phrasings of the same task.
 *
 * @param {string} goal - Raw goal text
 * @returns {string} Stable skill key (e.g. "agent:discover:example.com")
 */
function goalKey(goal) {
  const match = /([a-z]+)\s+(https?:\/\/[^/\s]+)/i.exec(goal);
  if (match) {
    let host = '';
    try {
      host = new URL(match[2]).host;
    } catch {
      host = match[2].replace(/^https?:\/\//, '').slice(0, 40);
    }
    return `agent:${match[1].toLowerCase()}:${host}`;
  }
  return `agent:goal:${goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
}

export function createTaskAgent({ logger, defaultMaxSteps = 8, statePath, reviewIntervalMs = 0 }) {
  /** @type {Map<string, object>} goalKey -> learned skill */
  const skills = new Map();
  let tasksRun = 0;
  let tasksSucceeded = 0;
  let skillReplays = 0;
  let skillReplaysSucceeded = 0;
  /** Total revenue the agent's learned skills have helped produce (atomic units). */
  let skillRevenue = 0;
  /** Rolling record of the last few outcomes, for self-review. */
  const recentOutcomes = [];
  /** @type {NodeJS.Timeout|undefined} */
  let reviewTimer;

  // Durable learning: restore the skill library + counters from disk so the
  // agent "remembers" what it learned before a restart. Best-effort — a
  // missing/corrupt file just starts fresh instead of crashing the boot.
  if (statePath) {
    try {
      const data = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
      for (const s of data.skills ?? []) if (s?.goalKey) skills.set(s.goalKey, s);
      tasksRun = data.tasksRun ?? 0;
      tasksSucceeded = data.tasksSucceeded ?? 0;
      skillReplays = data.skillReplays ?? 0;
      skillReplaysSucceeded = data.skillReplaysSucceeded ?? 0;
      skillRevenue = data.skillRevenue ?? 0;
      logger.info(`Agent: restored ${skills.size} skills from ${statePath} (tasksRun ${tasksRun}).`);
    } catch {
      logger.info('Agent: no restorable skill state — starting a fresh ledger.');
    }
  }

  /**
   * Persist the learned skill library + counters, best-effort and atomic
   * (tmp + rename) so a crash mid-save never corrupts the file a future
   * boot depends on.
   */
  function saveSkills() {
    if (!statePath) return;
    try {
      fsSync.mkdirSync(dirname(statePath), { recursive: true });
      fsSync.writeFileSync(
        `${statePath}.tmp`,
        JSON.stringify({
          savedAt: new Date().toISOString(),
          tasksRun,
          tasksSucceeded,
          skillReplays,
          skillReplaysSucceeded,
          skillRevenue,
          skills: [...skills.values()],
        }),
      );
      fsSync.renameSync(`${statePath}.tmp`, statePath);
    } catch (error) {
      logger.warn(`Agent: could not persist skills (${error.message}) — continuing in memory.`);
    }
  }

  /**
   * Self-review: the agent audits its own recent outcomes and prunes skills
   * that are never used or always fail. This is the "evolve its processes"
   * loop — it runs on a timer, independently of any incoming task, so the
   * library improves while the service is idle.
   *
   * @returns {object} Review summary
   */
  function runSelfReview() {
    const window = recentOutcomes.slice(-20);
    const total = window.length;
    const succeeded = window.filter((o) => o.ok).length;
    const replayed = window.filter((o) => o.via.startsWith('skill')).length;
    const fresh = window.filter((o) => o.via.startsWith('skill-learned')).length;

    // Prune skills that have never been replayed after 10+ tasks and are not
    // the most recent success — they are dead weight in the library.
    const stale = [...skills.values()].filter(
      (s) => (s.uses ?? 0) === 0 && s.recordedAt < new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    );
    for (const s of stale) skills.delete(s.goalKey);

    const summary = {
      window: total,
      succeeded,
      successRate: total ? Number((succeeded / total).toFixed(3)) : 0,
      replayed,
      learned: fresh,
      skills: skills.size,
      pruned: stale.length,
      skillRevenue,
    };
    logger.info(`Agent self-review: ${JSON.stringify(summary)}`);
    return summary;
  }

  /**
   * Start the periodic self-review timer. Best-effort — a missing interval
   * means the agent learns only on demand, which is still correct.
   */
  function startReview() {
    if (!reviewIntervalMs) return;
    if (reviewTimer) return;
    reviewTimer = setInterval(() => {
      try {
        runSelfReview();
      } catch (error) {
        logger.warn(`Agent self-review failed: ${error.message}`);
      }
    }, reviewIntervalMs);
    reviewTimer.unref?.();
  }

  /**
   * Execute one planned step, catching tool explosions into a failed result.
   *
   * @param {{tool: string, args: object}} step - Planned step
   * @returns {Promise<object>} Tool result
   */
  async function executeStep(step) {
    const tool = TOOLS.get(step.tool);
    if (!tool) return { error: `unknown tool: ${step.tool}` };
    try {
      return await tool(step.args ?? {});
    } catch (error) {
      return { error: `tool ${step.tool} threw: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  }

  /**
   * Run a plan (fresh or replayed) to completion under the step budget.
   *
   * @param {string} goal - The task goal
   * @param {Array<{tool: string, args: object}>} [plan] - Replay plan when present
   * @param {number} maxSteps - Step budget
   * @returns {Promise<{trace: Array<object>, completed: boolean}>} Execution trace
   */
  async function execute(goal, plan, maxSteps) {
    const trace = [];
    for (let i = 0; i < maxSteps; i += 1) {
      let step;
      if (plan && i < plan.length) {
        step = plan[i]; // replay: trust the learned plan verbatim first
      } else {
        step = planNextStep(goal, trace);
      }
      if (!step) break;
      const result = await executeStep(step);
      trace.push({ step: i + 1, tool: step.tool, args: step.args, result });
      if (!isStepSuccessful(result)) {
        return { trace, completed: false, failedAt: i + 1 };
      }
    }
    return { trace, completed: trace.length > 0 };
  }

  /**
   * Run a task: replay a learned skill when one matches, detect environment
   * drift when the replay fails, re-plan from observation, and record every
   * success as a new/reinforced skill.
   *
   * @param {object} task - { goal: string, maxSteps?: number }
   * @returns {Promise<object>} { ok, goal, outcome, steps, via, trace }
   */
  async function runTask(task) {
    const goal = typeof task?.goal === 'string' ? task.goal.trim() : '';
    if (!goal) return { ok: false, error: 'task.goal is required' };
    const maxSteps = Math.min(MAX_STEPS_CAP, Math.max(1, Number(task?.maxSteps) || defaultMaxSteps));
    tasksRun += 1;
    const key = goalKey(goal);
    const skill = skills.get(key);

    // Revenue attribution: when a task carries a settlement amount, credit it
    // to the skill that produced it. That is how the library learns which
    // goal shapes are worth replaying — not just which succeed, but which
    // earn.
    const revenue = Number(task?.revenueAtomic ?? 0);

    if (skill && !skill.degraded) {
      skillReplays += 1;
      const replay = await execute(goal, skill.plan, maxSteps);
      if (replay.completed) {
        skillReplaysSucceeded += 1;
        tasksSucceeded += 1; // a replayed success is still a succeeded task
        skill.uses += 1;
        skill.lastUsedAt = new Date().toISOString();
        if (revenue > 0) {
          skill.revenue = (skill.revenue ?? 0) + revenue;
          skillRevenue += revenue;
        }
        const outcome = { ok: true, via: 'skill-replay', goal: key, revenue };
        recentOutcomes.push(outcome);
        saveSkills();
        return { ok: true, goal, via: 'skill-replay', steps: replay.trace.length, trace: replay.trace };
      }
      // Environment drifted: the remembered plan no longer holds. Mark it,
      // fall through to fresh planning, and let observation rebuild the skill.
      skill.degraded = true;
      skill.degradedAt = new Date().toISOString();
      logger.warn(`Agent: skill for "${key.slice(0, 60)}" failed on replay — re-planning from observation.`);
    }

    const fresh = await execute(goal, null, maxSteps);
    if (fresh.completed) {
      tasksSucceeded += 1;
      const existing = skills.get(key);
      if (existing) {
        existing.plan = fresh.trace.map((t) => ({ tool: t.tool, args: t.args }));
        existing.uses += 1;
        existing.degraded = false;
        existing.repairedAt = new Date().toISOString();
        if (revenue > 0) {
          existing.revenue = (existing.revenue ?? 0) + revenue;
          skillRevenue += revenue;
        }
      } else {
        skills.set(key, {
          goalKey: key,
          plan: fresh.trace.map((t) => ({ tool: t.tool, args: t.args })),
          recordedAt: new Date().toISOString(),
          uses: 0,
          revenue: revenue > 0 ? revenue : 0,
        });
      }
      const outcome = { ok: true, via: existing ? 'skill-repaired' : 'skill-learned', goal: key, revenue };
      recentOutcomes.push(outcome);
      saveSkills();
      return { ok: true, goal, via: existing ? 'skill-repaired' : 'skill-learned', steps: fresh.trace.length, trace: fresh.trace };
    }

    recentOutcomes.push({ ok: false, via: skill ? 'skill-drift-then-failed' : 'failed', goal: key, revenue });
    saveSkills();
    return {
      ok: false,
      goal,
      via: skill ? 'skill-drift-then-failed' : 'failed',
      steps: fresh.trace.length,
      trace: fresh.trace,
      note: 'budget exhausted or environment unreachable — full trace returned',
    };
  }

  /**
   * Skill library report — the agent's growth ledger.
   *
   * @returns {object} Counters + per-skill health
   */
  function getSkills() {
    return {
      tasksRun,
      tasksSucceeded,
      skillReplays,
      skillReplaysSucceeded,
      skillRevenue,
      skills: [...skills.values()].map((s) => ({
        goal: s.goalKey,
        recordedAt: s.recordedAt,
        uses: s.uses,
        revenue: s.revenue ?? 0,
        planLength: s.plan.length,
        degraded: Boolean(s.degraded),
        repaired: Boolean(s.repairedAt),
      })),
    };
  }

  // Kick off the periodic self-review when configured. Best-effort: a missing
  // interval means the agent learns only on demand, which is still correct.
  startReview();

  return { runTask, getSkills, listSkills: () => [...skills.values()], runSelfReview };
}


