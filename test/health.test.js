// ============================================================================
// Endpoint, Header & CORS Tests
//
// These run against the real application factory on an ephemeral port.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './support/boot.js';

describe('http endpoints', () => {
  test('GET / describes the service and how to pay', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/');
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.payments.protocol, 'x402');
      assert.equal(body.payments.version, 2);
      assert.equal(body.payments.network, 'eip155:84532');
      assert.equal(body.payments.price, '$0.001');
      assert.equal(body.endpoints.paid, 'POST /api/resource');
      assert.equal(body.paywallReady, true);
    } finally {
      await server.close();
    }
  });

  test('GET /health reports liveness without depending on the facilitator', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/health');
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.uptime, 'number');
      assert.equal(body.network, 'eip155:84532');
      assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await server.close();
    }
  });

  test('GET /ready reports readiness with the facilitator URL', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/ready');
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(body.status, 'ready');
      assert.equal(body.facilitator, 'https://x402.org/facilitator');
      assert.equal(body.payTo, '0x742d35Cc6634C0532925a3b844Bc9e7595f42b15');
    } finally {
      await server.close();
    }
  });

  test('GET /api/metrics exposes revenue counters and latency percentiles', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/metrics');
      assert.equal(response.status, 200);

      const body = await response.json();
      assert.equal(typeof body.totalRequests, 'number');
      assert.equal(typeof body.settledPayments, 'number');
      assert.equal(typeof body.paywallReady, 'boolean');
      assert.equal(typeof body.latencyMs.p50, 'number');
      assert.equal(body.errorRatePercent, 0);
    } finally {
      await server.close();
    }
  });

  test('METRICS_TOKEN protects the metrics endpoint when configured', async () => {
    const server = await startTestServer({ env: { METRICS_TOKEN: 'top-secret' } });
    try {
      const unauthorized = await server.fetch('/api/metrics');
      assert.equal(unauthorized.status, 401);

      const authorized = await server.fetch('/api/metrics', {
        headers: { Authorization: 'Bearer top-secret' },
      });
      assert.equal(authorized.status, 200);
    } finally {
      await server.close();
    }
  });

  test('unknown routes return a helpful JSON 404', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/does-not-exist');
      assert.equal(response.status, 404);

      const body = await response.json();
      assert.equal(body.error, 'Not found');
      assert.equal(body.method, 'GET');
      assert.match(body.hint, /GET \//);
      assert.ok(body.requestId);
    } finally {
      await server.close();
    }
  });

  test('malformed JSON bodies are rejected with 400', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/api/resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"broken":',
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'Malformed JSON body');
    } finally {
      await server.close();
    }
  });
});

describe('response headers', () => {
  test('applies hardening headers and never advertises Express', async () => {
    const server = await startTestServer();
    try {
      const response = await server.fetch('/health');

      assert.equal(response.headers.get('x-powered-by'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    } finally {
      await server.close();
    }
  });

  test('mints a request ID and honours a sane inbound one', async () => {
    const server = await startTestServer();
    try {
      const generated = await server.fetch('/health');
      assert.match(
        generated.headers.get('x-request-id'),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const forwarded = await server.fetch('/health', {
        headers: { 'X-Request-Id': 'trace-abc-123456' },
      });
      assert.equal(forwarded.headers.get('x-request-id'), 'trace-abc-123456');

      const hostile = await server.fetch('/health', { headers: { 'X-Request-Id': 'bad id!' } });
      assert.notEqual(hostile.headers.get('x-request-id'), 'bad id!');
    } finally {
      await server.close();
    }
  });
});

describe('cors', () => {
  test('allows configured origins and exposes the x402 protocol headers', async () => {
    const server = await startTestServer({
      env: { ALLOWED_ORIGINS: 'https://agent.example.com' },
    });
    try {
      const allowed = await server.fetch('/health', {
        headers: { Origin: 'https://agent.example.com' },
      });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://agent.example.com');
      assert.match(allowed.headers.get('access-control-expose-headers'), /PAYMENT-REQUIRED/);
      assert.match(allowed.headers.get('access-control-expose-headers'), /PAYMENT-RESPONSE/);
    } finally {
      await server.close();
    }
  });

  test('does not echo an unconfigured origin', async () => {
    const server = await startTestServer({
      env: { ALLOWED_ORIGINS: 'https://agent.example.com' },
    });
    try {
      const denied = await server.fetch('/health', { headers: { Origin: 'https://evil.example.com' } });
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    } finally {
      await server.close();
    }
  });

  test('answers preflight with the headers a browser buyer needs', async () => {
    const server = await startTestServer({ env: { ALLOWED_ORIGINS: '*' } });
    try {
      const preflight = await server.fetch('/api/resource', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'payment-signature',
        },
      });

      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.match(preflight.headers.get('access-control-allow-headers'), /PAYMENT-SIGNATURE/);
      assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
    } finally {
      await server.close();
    }
  });
});