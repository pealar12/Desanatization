// ============================================================================
// Configuration Validation Tests
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError,
  describeConfig,
  loadConfig,
  MAINNET_NETWORKS,
  normaliseNetwork,
  normalisePrice,
  parseAllowedOrigins,
} from '../config.js';

/** Minimal valid environment. */
const baseEnv = {
  NODE_ENV: 'test',
  PAY_TO_ADDRESS: '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15',
};

/**
 * Run a function and return the error it threw.
 * (assert.throws() validates but does not return the error object.)
 *
 * @param {Function} fn - Function expected to throw
 * @returns {Error} The captured error
 */
function captureThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('Expected the function to throw, but it returned normally');
}

describe('config', () => {
  test('rejects a missing PAY_TO_ADDRESS', () => {
    const error = captureThrow(() => loadConfig({ NODE_ENV: 'test' }));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /PAY_TO_ADDRESS is required/);
  });

  test('rejects a malformed wallet address', () => {
    const error = captureThrow(() =>
      loadConfig({ ...baseEnv, PAY_TO_ADDRESS: '0x742d35Cc6634C0532925a3b844Bc9e7595f42b1' }),
    );
    assert.match(error.message, /42-character EVM address/);
  });

  test('reports every problem at once instead of only the first', () => {
    const error = captureThrow(() =>
      loadConfig({ PAY_TO_ADDRESS: 'nope', NETWORK: 'not-a-network', PRICE: 'free', PORT: 'abc' }),
    );
    assert.ok(error.problems.length >= 4, `expected >= 4 problems, got ${error.problems.length}`);
    for (const fragment of ['PAY_TO_ADDRESS', 'NETWORK', 'PRICE', 'PORT']) {
      assert.match(error.message, new RegExp(fragment));
    }
  });

  test('defaults to the public testnet facilitator and Base Sepolia', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.facilitator.url, 'https://x402.org/facilitator');
    assert.equal(config.network, 'eip155:84532');
    assert.equal(config.price, '$0.001');
    assert.equal(config.scheme, 'exact');
    assert.equal(config.resource.path, '/api/resource');
  });

  test('translates legacy x402 v1 network names to CAIP-2 and warns', () => {
    const config = loadConfig({ ...baseEnv, NETWORK: 'base-sepolia' });
    assert.equal(config.network, 'eip155:84532');
    assert.match(config.warnings.join(' '), /legacy x402 v1 name/);
  });

  test('normaliseNetwork accepts CAIP-2 and rejects junk', () => {
    const problems = [];
    assert.equal(normaliseNetwork('eip155:8453', problems), 'eip155:8453');
    assert.equal(problems.length, 0);

    const bad = [];
    assert.equal(normaliseNetwork('base-mainnet-typo', bad), undefined);
    assert.match(bad[0], /CAIP-2/);
  });

  test('normalisePrice accepts dollar strings and asset amounts', () => {
    assert.equal(normalisePrice('$0.05'), '$0.05');
    assert.deepEqual(normalisePrice('{"asset":"0xabc","amount":"5000"}'), { asset: '0xabc', amount: '5000' });

    const problems = [];
    normalisePrice('1000000', problems);
    assert.match(problems[0], /dollar string/);
  });

  test('parseAllowedOrigins splits and trims, and preserves the wildcard', () => {
    assert.deepEqual(parseAllowedOrigins('https://a.com, https://b.com'), ['https://a.com', 'https://b.com']);
    assert.deepEqual(parseAllowedOrigins('*'), ['*']);
    assert.deepEqual(parseAllowedOrigins(undefined), []);
  });

  test('strictStartup defaults on in production and off elsewhere', () => {
    assert.equal(
      loadConfig({ ...baseEnv, NODE_ENV: 'production', METRICS_TOKEN: 'prod-secret' }).strictStartup,
      true,
    );
    assert.equal(loadConfig({ ...baseEnv, NODE_ENV: 'development' }).strictStartup, false);
  });

  test('production requires METRICS_TOKEN', () => {
    const error = captureThrow(() => loadConfig({ ...baseEnv, NODE_ENV: 'production' }));
    assert.match(error.message, /METRICS_TOKEN is required/);
  });

  test('production refuses a localhost facilitator', () => {
    const error = captureThrow(() =>
      loadConfig({ ...baseEnv, NODE_ENV: 'production', FACILITATOR_URL: 'http://localhost:3001' }),
    );
    assert.match(error.message, /localhost/);
  });

  test('refuses mainnet network paired with the testnet facilitator', () => {
    const error = captureThrow(() => loadConfig({ ...baseEnv, NETWORK: 'eip155:8453' }));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /can never settle/);
  });

  test('describeConfig never leaks secrets', () => {
    const config = loadConfig({
      ...baseEnv,
      FACILITATOR_AUTH_HEADER: 'Bearer super-secret',
      METRICS_TOKEN: 'metrics-secret',
    });
    const described = JSON.stringify(describeConfig(config));
    assert.equal(described.includes('super-secret'), false);
    assert.equal(described.includes('metrics-secret'), false);
  });

  test('config is frozen so it cannot be mutated at runtime', () => {
    const config = loadConfig(baseEnv);
    assert.equal(Object.isFrozen(config), true);
  });
});

describe('go-live guards', () => {
  test('mainnet + CDP facilitator with named auth headers loads cleanly', () => {
    const config = loadConfig({
      ...baseEnv,
      NETWORK: 'eip155:8453',
      FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
      FACILITATOR_AUTH_HEADERS: JSON.stringify({
        'X-CDP-API-KEY-ID': 'id-123',
        'X-CDP-API-KEY-SECRET': 'secret-456',
      }),
    });
    assert.equal(config.network, 'eip155:8453');
    assert.deepEqual(config.facilitator.authHeaders, {
      'X-CDP-API-KEY-ID': 'id-123',
      'X-CDP-API-KEY-SECRET': 'secret-456',
    });
    assert.equal(config.facilitator.authHeader, undefined);
  });

  test('mainnet without any facilitator credential produces a loud warning', () => {
    const config = loadConfig({
      ...baseEnv,
      NETWORK: 'eip155:8453',
      FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
    });
    assert.ok(
      config.warnings.some((w) => /no facilitator credential/.test(w)),
      `expected auth warning, got: ${JSON.stringify(config.warnings)}`,
    );
  });

  test('malformed FACILITATOR_AUTH_HEADERS is a config error', () => {
    const error = captureThrow(() => loadConfig({ ...baseEnv, FACILITATOR_AUTH_HEADERS: 'not-json' }));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /FACILITATOR_AUTH_HEADERS/);
  });

  test('MAINNET_NETWORKS covers Base and Ethereum but not Base Sepolia', () => {
    assert.ok(MAINNET_NETWORKS.has('eip155:8453'));
    assert.ok(MAINNET_NETWORKS.has('eip155:1'));
    assert.ok(!MAINNET_NETWORKS.has('eip155:84532'));
  });

  test('CDP JWT credentials: mainnet + CDP facilitator loads cleanly and flags cdpAuth', () => {
    const config = loadConfig({
      ...baseEnv,
      NETWORK: 'eip155:8453',
      FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
      CDP_API_KEY_ID: '7cf18512-aaaa-bbbb-cccc-ddddeeeeffff',
      CDP_API_KEY_SECRET: Buffer.alloc(64, 7).toString('base64'),
    });
    assert.equal(config.facilitator.cdp.keyId, '7cf18512-aaaa-bbbb-cccc-ddddeeeeffff');
    assert.equal(config.facilitator.authHeader, undefined);
    assert.equal(config.facilitator.authHeaders, undefined);
    const described = describeConfig(config);
    assert.equal(described.facilitator.cdpAuth, true);
    assert.equal(described.facilitator.authenticated, true);
  });

  test('CDP variables must be paired', () => {
    const error = captureThrow(() => loadConfig({ ...baseEnv, CDP_API_KEY_ID: 'id-only' }));
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /must be set together/);
  });

  test('CDP credentials and static auth headers are mutually exclusive', () => {
    const error = captureThrow(() =>
      loadConfig({
        ...baseEnv,
        CDP_API_KEY_ID: 'id',
        CDP_API_KEY_SECRET: Buffer.alloc(64, 7).toString('base64'),
        FACILITATOR_AUTH_HEADER: 'Bearer static',
      }),
    );
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /not both/);
  });

  test('CDP credentials against a non-CDP facilitator warn that they are unused', () => {
    const config = loadConfig({
      ...baseEnv,
      CDP_API_KEY_ID: 'id',
      CDP_API_KEY_SECRET: Buffer.alloc(64, 7).toString('base64'),
    });
    assert.ok(config.warnings.some((w) => /will be unused/.test(w)));
  });

  test('describeConfig never leaks the CDP secret', () => {
    const secret = Buffer.alloc(64, 9).toString('base64');
    const config = loadConfig({
      ...baseEnv,
      FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
      CDP_API_KEY_ID: 'id-x',
      CDP_API_KEY_SECRET: secret,
    });
    assert.equal(JSON.stringify(describeConfig(config)).includes(secret), false);
  });
});