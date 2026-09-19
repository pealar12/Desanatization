// ============================================================================
// Configuration Loader
//
// Reads, validates and normalises all environment variables in one place.
// Every problem found is reported together (not just the first) so a bad
// Railway deploy can be fixed in a single pass.
// ============================================================================

/** Public x402 testnet facilitator. Works with eip155:84532 out of the box. */
export const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

/** Valid notification transports, validated against NOTIFICATION_TRANSPORT. */
export const NOTIFICATION_TRANSPORTS = Object.freeze(['none', 'webhook', 'smtp']);

/** EIP-55-agnostic EVM address check. */
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** CAIP-2 network identifier, e.g. `eip155:8453`. */
const CAIP2_PATTERN = /^[a-z0-9-]+:[a-zA-Z0-9-]+$/;

/** Dollar-string price, e.g. `$0.001`. */
const DOLLAR_PRICE_PATTERN = /^\$\d+(\.\d+)?$/;

/**
 * Legacy x402 v1 network names mapped to CAIP-2 identifiers.
 * v2 requires CAIP-2; accepting the aliases avoids silent misconfiguration.
 */
const LEGACY_NETWORK_ALIASES = {
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'base-goerli': 'eip155:84531',
  ethereum: 'eip155:1',
  mainnet: 'eip155:1',
  sepolia: 'eip155:11155111',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
};

/** Networks that move real value; the public testnet facilitator cannot serve them. */
export const MAINNET_NETWORKS = new Set(['eip155:1', 'eip155:8453', 'eip155:137', 'eip155:43114']);

/**
 * Thrown when configuration is invalid. Carries every problem discovered.
 */
export class ConfigError extends Error {
  /**
   * @param {string[]} problems - Human readable list of configuration problems
   */
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Parse an integer environment variable.
 *
 * @param {string|undefined} raw - Raw environment value
 * @param {string} name - Variable name (for error messages)
 * @param {{ min?: number, max?: number }} bounds - Inclusive bounds
 * @param {string[]} problems - Collector for validation errors
 * @param {number} fallback - Value used when the variable is unset
 * @returns {number} Parsed value
 */
function readInt(raw, name, bounds, problems, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(`${name} must be an integer (received "${raw}")`);
    return fallback;
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    problems.push(`${name} must be >= ${bounds.min} (received ${value})`);
    return fallback;
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    problems.push(`${name} must be <= ${bounds.max} (received ${value})`);
    return fallback;
  }
  return value;
}

/**
 * Parse a boolean environment variable.
 *
 * @param {string|undefined} raw - Raw environment value
 * @param {string} name - Variable name (for error messages)
 * @param {string[]} problems - Collector for validation errors
 * @param {boolean} fallback - Value used when the variable is unset
 * @returns {boolean} Parsed value
 */
function readBool(raw, name, problems, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const normalised = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
  problems.push(`${name} must be a boolean like true/false (received "${raw}")`);
  return fallback;
}

/**
 * Normalise a network identifier to CAIP-2, translating legacy v1 aliases.
 *
 * @param {string} raw - Raw network identifier
 * @param {string[]} problems - Collector for validation errors
 * @param {string[]} warnings - Collector for non-fatal warnings
 * @returns {string|undefined} CAIP-2 identifier when valid
 */
export function normaliseNetwork(raw, problems = [], warnings = []) {
  const value = String(raw || '').trim();
  if (!value) return undefined;

  const alias = LEGACY_NETWORK_ALIASES[value.toLowerCase()];
  if (alias) {
    warnings.push(`NETWORK="${value}" is a legacy x402 v1 name; using CAIP-2 "${alias}" instead.`);
    return alias;
  }

  if (!CAIP2_PATTERN.test(value)) {
    problems.push(
      `NETWORK must be a CAIP-2 identifier such as "eip155:84532" (received "${value}")`,
    );
    return undefined;
  }
  return value;
}

/**
 * Validate a price value. Accepts a dollar string (`$0.001`) or an explicit
 * asset amount object (JSON) for non-default tokens.
 *
 * @param {string} raw - Raw PRICE value
 * @param {string[]} problems - Collector for validation errors
 * @returns {string|{asset: string, amount: string}} Valid price
 */
export function normalisePrice(raw, problems = []) {
  const value = String(raw ?? '').trim();
  if (!value) return '$0.001';

  if (DOLLAR_PRICE_PATTERN.test(value)) return value;

  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed?.asset === 'string' && typeof parsed?.amount === 'string') {
        return parsed;
      }
      problems.push('PRICE object form requires string fields "asset" and "amount"');
    } catch (error) {
      problems.push(`PRICE is not valid JSON: ${error.message}`);
    }
    return '$0.001';
  }

  problems.push(
    'PRICE must be a dollar string such as "$0.001", or JSON {"asset":"0x…","amount":"1000"} ' +
      `(received "${value}")`,
  );
  return '$0.001';
}

/**
 * Parse ALLOWED_ORIGINS into a list. `*` means "reflect any origin".
 *
 * @param {string|undefined} raw - Comma separated origin list
 * @returns {string[]} Normalised origin list
 */
export function parseAllowedOrigins(raw) {
  return String(raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Parse FACILITATOR_AUTH_HEADERS — a JSON object of named request headers.
 *
 * @param {string|undefined} raw - JSON object string, e.g. '{"X-CDP-API-KEY-ID":"..."}'
 * @param {string[]} problems - Collector for validation errors
 * @returns {Record<string, string>|undefined} Header map when valid
 */
function parseAuthHeaders(raw, problems) {
  if (raw === undefined || String(raw).trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === 'string')
    ) {
      return parsed;
    }
    problems.push('FACILITATOR_AUTH_HEADERS must be a JSON object of string values');
  } catch {
    problems.push('FACILITATOR_AUTH_HEADERS is not valid JSON');
  }
  return undefined;
}

/**
 * Load and validate configuration.
 *
 * @param {Record<string, string|undefined>} [env] - Environment source (defaults to process.env)
 * @returns {Readonly<object>} Frozen, validated configuration
 * @throws {ConfigError} When one or more variables are invalid
 */
export function loadConfig(env = process.env) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  // --- Required -----------------------------------------------------------
  const payToAddress = String(env.PAY_TO_ADDRESS || '').trim();
  if (!payToAddress) {
    problems.push('PAY_TO_ADDRESS is required — set it to your EVM wallet address (0x…)');
  } else if (!EVM_ADDRESS_PATTERN.test(payToAddress)) {
    problems.push(
      `PAY_TO_ADDRESS must be a 42-character EVM address starting with 0x (received "${payToAddress}")`,
    );
  }

  // --- Network ------------------------------------------------------------
  const network = normaliseNetwork(env.NETWORK || 'eip155:84532', problems, warnings);

  // --- Facilitator --------------------------------------------------------
  const facilitatorUrl = String(env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL).trim();
  try {
    const parsed = new URL(facilitatorUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      problems.push(`FACILITATOR_URL must use http or https (received "${facilitatorUrl}")`);
    }
    if (parsed.hostname === 'localhost' && isProduction) {
      problems.push('FACILITATOR_URL points at localhost, which cannot work in production.');
    }
  } catch {
    problems.push(`FACILITATOR_URL is not a valid URL (received "${facilitatorUrl}")`);
  }

  // A mainnet network pointed at the public TESTNET facilitator can never
  // settle a payment — the facilitator's supported list has no mainnet EVM
  // networks. That is not a warning; it is a config that earns nothing, so
  // refuse to boot on it (in every environment).
  if (facilitatorUrl.includes('x402.org') && network && MAINNET_NETWORKS.has(network)) {
    problems.push(
      `FACILITATOR_URL is the public TESTNET facilitator (x402.org) but NETWORK=${network} is a mainnet. ` +
        'That combination can never settle a payment. Use a production facilitator ' +
        '(e.g. https://api.cdp.coinbase.com/platform/v2/x402 with FACILITATOR_AUTH_HEADERS) ' +
        'or set NETWORK=eip155:84532 for the free testnet.',
    );
  }

  // Most production facilitators require an API credential. Booting a mainnet
  // without any credential is legal only for facilitators that need none, so
  // surface it as a loud warning rather than an error.
  if (
    network && MAINNET_NETWORKS.has(network) &&
    !env.FACILITATOR_AUTH_HEADER && !env.FACILITATOR_AUTH_HEADERS && !env.CDP_API_KEY_ID
  ) {
    warnings.push(
      `NETWORK=${network} is mainnet but no facilitator credential is set ` +
        '(CDP_API_KEY_ID/SECRET, FACILITATOR_AUTH_HEADER, or FACILITATOR_AUTH_HEADERS). ' +
        'If your facilitator requires an API key, verify calls will 401 and no payments will settle.',
    );
  }

  // CDP credential sanity: paired variables, no auth-mode ambiguity, and a
  // loud note when the credentials cannot apply to the configured facilitator.
  const cdpKeyId = String(env.CDP_API_KEY_ID || '').trim() || undefined;
  const cdpKeySecret = String(env.CDP_API_KEY_SECRET || '').trim() || undefined;
  if (Boolean(cdpKeyId) !== Boolean(cdpKeySecret)) {
    problems.push('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set together');
  }
  if (cdpKeyId && cdpKeySecret && (env.FACILITATOR_AUTH_HEADER || env.FACILITATOR_AUTH_HEADERS)) {
    problems.push(
      'Set either CDP_API_KEY_ID/CDP_API_KEY_SECRET (signed-JWT auth) or ' +
        'FACILITATOR_AUTH_HEADER/HEADERS (static auth) — not both.',
    );
  }
  if (cdpKeyId && cdpKeySecret && !facilitatorUrl.includes('api.cdp.coinbase.com')) {
    warnings.push(
      'CDP_API_KEY_ID/SECRET are set but FACILITATOR_URL is not the Coinbase CDP facilitator ' +
        '(api.cdp.coinbase.com) — the CDP credentials will be unused.',
    );
  }

  const price = normalisePrice(env.PRICE, problems);

  const config = {
    nodeEnv,
    isProduction,
    // Railway injects PORT at runtime (currently 8080). Local dev falls back
    // to 3000; production relies on the injected value.
    port: readInt(env.PORT, 'PORT', { min: 1, max: 65535 }, problems, 3000),
    host: env.HOST || '0.0.0.0',
    logLevel: env.LOG_LEVEL || 'info',
    trustProxy:
      env.TRUST_PROXY === undefined ? 1 : readBool(env.TRUST_PROXY, 'TRUST_PROXY', problems, true),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),

    facilitator: {
      url: facilitatorUrl,
      timeoutMs: readInt(
        env.FACILITATOR_TIMEOUT_MS,
        'FACILITATOR_TIMEOUT_MS',
        { min: 1000, max: 120000 },
        problems,
        20000,
      ),
      // Sent as `Authorization` on verify/settle/supported/bazaar calls.
      // Required by some production facilitators (e.g. Coinbase CDP).
      authHeader: String(env.FACILITATOR_AUTH_HEADER || '').trim() || undefined,
      // Some production facilitators need named headers instead of a Bearer
      // token. Provide them as a JSON object string.
      authHeaders: parseAuthHeaders(env.FACILITATOR_AUTH_HEADERS, problems),
      // Coinbase CDP: per-request signed-JWT auth from these two variables.
      cdp: {
        keyId: String(env.CDP_API_KEY_ID || '').trim() || undefined,
        keySecret: String(env.CDP_API_KEY_SECRET || '').trim() || undefined,
      },
    },

    network,
    price,
    payToAddress,
    scheme: 'exact',

    resource: {
      path: env.RESOURCE_PATH || '/api/resource',
       description: env.RESOURCE_DESCRIPTION || 'PII sanitization for AI agents',
      mimeType: env.RESOURCE_MIME_TYPE || 'application/json',
      serviceName: env.SERVICE_NAME || 'Desanatization',
    },

    // How long a signed payment authorisation stays valid, in seconds.
    maxTimeoutSeconds: readInt(
      env.PAYMENT_TIMEOUT_SECONDS,
      'PAYMENT_TIMEOUT_SECONDS',
      { min: 10, max: 86400 },
      problems,
      300,
    ),

    syncFacilitatorOnStart: readBool(
      env.SYNC_FACILITATOR_ON_START,
      'SYNC_FACILITATOR_ON_START',
      problems,
      true,
    ),

    // When true, the process exits if the facilitator cannot be reached at boot
    // (fail the deploy loudly instead of serving traffic that can never be paid).
    strictStartup: readBool(env.STRICT_STARTUP, 'STRICT_STARTUP', problems, isProduction),

    // Bearer token protecting /api/metrics, /api/revenue, /api/health/deep,
    // /api/insights, /api/growth, /api/notifications and the task agent
    // endpoints. Required in production: several of those (notably the task
    // agent's http_fetch tool) are outbound-request primitives that must
    // never be reachable by an unauthenticated caller.
    metricsToken: String(env.METRICS_TOKEN || '').trim() || undefined,

    rateLimit: {
      windowMs: readInt(env.RATE_LIMIT_WINDOW_MS, 'RATE_LIMIT_WINDOW_MS', { min: 1000 }, problems, 60_000),
      maxRequests: readInt(env.RATE_LIMIT_MAX_REQUESTS, 'RATE_LIMIT_MAX_REQUESTS', { min: 1 }, problems, 60),
    },

    // Outbound growth engine: self-learning. Enabled by default in production so
    // the service actively pitches peer x402 agents instead of waiting to be found.
    growth: {
      enabled: readBool(env.GROWTH_ENABLED, 'GROWTH_ENABLED', problems, isProduction),
      targets: env.GROWTH_TARGETS,
      // Seed targets: known x402 services actually running on Base mainnet —
      // i.e. peers that, by running the x402 protocol at all, have already
      // opted into machine-to-machine payment discovery. The engine discovers
      // more from the CDP Bazaar + GitHub every cycle, but a warm list gets
      // the first pitches out within minutes.
      //
      // Deliberately NOT included here: generic AI-provider/framework/SaaS
      // domains (model APIs, LangChain, Zapier, Cloudflare, Hugging Face,
      // consumer chat products, ...). None of those are x402 peers or have
      // consented to receive automated outreach, and probeAndPitch() will not
      // attempt a pitch against any target that lacks a positive x402/agent
      // signal — so listing them here would only produce unsolicited spam at
      // real companies' contact/API surfaces, never a sale.
      seedTargets: isProduction
        ? JSON.stringify([
            { url: 'https://x402.ottoai.services', kind: 'known-peer' },
            { url: 'https://api.onesource.io', kind: 'known-peer' },
            { url: 'https://stableenrich.dev', kind: 'known-peer' },
            { url: 'https://api.exa.ai', kind: 'known-peer' },
            { url: 'https://cheaptokens.ai', kind: 'known-peer' },
            { url: 'https://crypto.apitoll.cloud', kind: 'known-peer' },
            { url: 'https://kronossignals.com', kind: 'known-peer' },
            { url: 'https://stableupload.dev', kind: 'known-peer' },
            { url: 'https://laso.finance', kind: 'known-peer' },
            { url: 'https://api.bitrefill.com', kind: 'known-peer' },
          ])
        : undefined,
      bazaarDiscovery: isProduction,
      discoveryUrl: String(env.GROWTH_DISCOVERY_URL || '').trim() || undefined,
      // Expanded discovery: scan GitHub, Google Cloud Agent Gallery, and
      // Salesforce AgentExchange for new x402/crypto/AI-agent peers.
      discoverFromAll: readBool(
        env.GROWTH_DISCOVER_FROM_ALL,
        'GROWTH_DISCOVER_FROM_ALL',
        problems,
        true,
      ),
      githubToken: String(env.GITHUB_TOKEN || '').trim() || undefined,
      // Auto-detect public URL from hosting environment so the growth engine can
      // advertise itself in pitches. Railway exposes RAILWAY_STATIC_URL; fall back
      // to GROWTH_PUBLIC_URL / PUBLIC_URL; the growth engine in app.js falls back
      // to localhost:port.
      publicUrl: String(
        env.GROWTH_PUBLIC_URL || env.PUBLIC_URL || env.RAILWAY_STATIC_URL || '',
      ).trim().replace(/\/+$/, '') || undefined,
      intervalMs: readInt(env.GROWTH_INTERVAL_MS, 'GROWTH_INTERVAL_MS', { min: 15_000 }, problems, 2 * 60 * 60_000),
      maxPerCycle: readInt(env.GROWTH_MAX_PER_CYCLE, 'GROWTH_MAX_PER_CYCLE', { min: 1, max: 50 }, problems, 10),
      statePath: String(env.GROWTH_STATE_PATH || '').trim() || undefined,
      agentStatePath: String(env.GROWTH_AGENT_STATE_PATH || '').trim() || undefined,
      // Task agent self-review cadence (0 = off). The agent audits its own
      // recent outcomes and prunes dead skills on this interval, so the
      // library improves while the service is idle. Enabled in production
      // so the agent refines its outreach while the service runs.
      reviewIntervalMs: readInt(
        env.AGENT_REVIEW_INTERVAL_MS,
        'AGENT_REVIEW_INTERVAL_MS',
        { min: 0 },
        problems,
        isProduction ? 4 * 60 * 60_000 : 0,
      ),
    },

    // Outbound notifications: durable, operator-facing events (first purchase,
    // settlement, insights). Dependency-free — every transport is plain HTTP.
    notifications: {
      transport: String(env.NOTIFICATION_TRANSPORT || 'none').trim().toLowerCase(),
      webhookUrl: String(env.NOTIFICATION_WEBHOOK_URL || '').trim() || undefined,
      smtpUrl: String(env.NOTIFICATION_SMTP_URL || '').trim() || undefined,
      from: String(env.NOTIFICATION_FROM || '').trim() || undefined,
      to: String(env.NOTIFICATION_TO || '').trim() || undefined,
      statePath: String(env.NOTIFICATION_STATE_PATH || '').trim() || undefined,
    },
  };

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  // Outbound notifications: validate the transport choice before it reaches
  // the notifier, so a typo fails at boot instead of silently logging nothing.
  if (!NOTIFICATION_TRANSPORTS.includes(config.notifications.transport)) {
    problems.push(
      `NOTIFICATION_TRANSPORT must be one of ${NOTIFICATION_TRANSPORTS.join(', ')} (received "${config.notifications.transport}")`,
    );
  }
  if (config.notifications.transport === 'webhook' && !config.notifications.webhookUrl) {
    problems.push('NOTIFICATION_TRANSPORT=webhook requires NOTIFICATION_WEBHOOK_URL');
  }
  if (config.notifications.transport === 'smtp' && (!config.notifications.smtpUrl || !config.notifications.from || !config.notifications.to)) {
    problems.push(
      'NOTIFICATION_TRANSPORT=smtp requires NOTIFICATION_SMTP_URL, NOTIFICATION_FROM and NOTIFICATION_TO',
    );
  }

  // Several token-guarded endpoints are outbound-request primitives (notably
  // the task agent's http_fetch tool, and /api/growth which reveals the
  // outreach target list) — they must never be reachable by an anonymous
  // caller in production.
  if (config.isProduction && !config.metricsToken) {
    problems.push(
      'METRICS_TOKEN is required when NODE_ENV=production — it protects /api/metrics, /api/revenue, ' +
        '/api/health/deep, /api/insights, /api/growth, /api/notifications and the task agent endpoints ' +
        '(one of which can make outbound HTTP requests on request) from anonymous callers. ' +
        'Set METRICS_TOKEN to a random 32+ character value.',
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  config.warnings = Object.freeze(warnings);
  return Object.freeze(config);
}

/**
 * Build a loggable / servable summary of the effective configuration.
 * Never includes secrets (facilitator auth header, metrics token).
 *
 * @param {ReturnType<typeof loadConfig>} config - Loaded configuration
 * @returns {object} Redacted summary
 */
export function describeConfig(config) {
  return {
    environment: config.nodeEnv,
    network: config.network,
    price: config.price,
    payTo: config.payToAddress,
    scheme: config.scheme,
    resourcePath: config.resource.path,
    facilitator: {
      url: config.facilitator.url,
      timeoutMs: config.facilitator.timeoutMs,
      authenticated: Boolean(
        config.facilitator.authHeader || config.facilitator.authHeaders ||
          (config.facilitator.cdp?.keyId && config.facilitator.cdp?.keySecret),
      ),
      cdpAuth: Boolean(config.facilitator.cdp?.keyId && config.facilitator.cdp?.keySecret),
    },
    allowedOrigins: config.allowedOrigins.length > 0 ? config.allowedOrigins : ['<none>'],
    strictStartup: config.strictStartup,
    syncFacilitatorOnStart: config.syncFacilitatorOnStart,
  };
}