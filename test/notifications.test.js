// ============================================================================
// Outbound Notification System
//
// The notifier is dependency-free and must never block the revenue path, so
// every transport is plain HTTP and every call is fire-and-forget. These tests
// pin the durable first-purchase milestone and the transport dispatch.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNotifier, NOTIFICATION_EVENT, TRANSPORTS } from '../notifications.js';

const BASE_CONFIG = {
  network: 'eip155:84532',
  price: '$0.001',
  resource: { serviceName: 'Desanatization' },
  notifications: { transport: 'none' },
};

describe('notification transports', () => {
  test('TRANSPORTS lists the three known channels', () => {
    assert.deepEqual([...TRANSPORTS], ['none', 'webhook', 'smtp']);
  });

  test('notify fires exactly once per milestone and persists it durably', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-'));
    const statePath = path.join(tmp, 'state.json');
    const received = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      received.push({ url: String(url), body: init.body });
      return Promise.resolve({ ok: true, status: 200, text: async () => '' });
    };
    try {
      const notifier = createNotifier(
        { ...BASE_CONFIG, notifications: { transport: 'webhook', webhookUrl: 'https://hooks.example/notify', statePath } },
        { info() {}, warn() {}, error() {} },
      );

      await notifier.notifyFirstPurchase({ amount: '1000', asset: '0xabc', payer: '0xpay', network: 'eip155:84532', transaction: '0xtx' });
      await notifier.notifyFirstPurchase({ amount: '1000', asset: '0xabc', payer: '0xpay', network: 'eip155:84532', transaction: '0xtx' });
      assert.equal(received.length, 1, 'first purchase fires exactly once');
      const envelope = JSON.parse(received[0].body);
      assert.equal(envelope.event, 'firstPurchase');
      assert.equal(envelope.data.payment.transaction, '0xtx');

      // Durability: a fresh notifier reading the same state file sees it fired.
      const restored = createNotifier(
        { ...BASE_CONFIG, notifications: { transport: 'webhook', webhookUrl: 'https://hooks.example/notify', statePath } },
        { info() {}, warn() {}, error() {} },
      );
      assert.equal(restored.getState().firstPurchaseFired, true);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('notify never throws when the channel is misconfigured', async () => {
    const notifier = createNotifier(
      { ...BASE_CONFIG, notifications: { transport: 'webhook' } },
      { info() {}, warn() {}, error() {} },
    );
    const ok = await notifier.notify(NOTIFICATION_EVENT.FIRST_PURCHASE, { message: 'hi' });
    assert.equal(ok, false);
  });

  test('notify dispatches to the webhook transport', async () => {
    const received = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      received.push({ url: String(url), body: init.body });
      return Promise.resolve({ ok: true, status: 200, text: async () => '' });
    };
    try {
      const notifier = createNotifier(
        { ...BASE_CONFIG, notifications: { transport: 'webhook', webhookUrl: 'https://hooks.example/notify' } },
        { info() {}, warn() {}, error() {} },
      );
      const ok = await notifier.notify(NOTIFICATION_EVENT.PAYMENT_SETTLED, { amount: '1000' });
      assert.equal(ok, true);
      assert.equal(received.length, 1);
      const envelope = JSON.parse(received[0].body);
      assert.equal(envelope.event, 'paymentSettled');
      assert.equal(envelope.source, 'Desanatization');
      assert.equal(envelope.network, 'eip155:84532');
      assert.equal(typeof envelope.at, 'string');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('notify dispatches to the smtp transport with an email envelope', async () => {
    const received = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      received.push({ url: String(url), body: init.body });
      return Promise.resolve({ ok: true, status: 200, text: async () => '' });
    };
    try {
      const notifier = createNotifier(
        {
          ...BASE_CONFIG,
          notifications: {
            transport: 'smtp',
            smtpUrl: 'https://api.example/v3/mail/send',
            from: 'you@example.com',
            to: 'owner@example.com',
          },
        },
        { info() {}, warn() {}, error() {} },
      );
      const ok = await notifier.notify(NOTIFICATION_EVENT.FIRST_PURCHASE, { message: 'First purchase received' });
      assert.equal(ok, true);
      const email = JSON.parse(received[0].body);
      assert.equal(email.to, 'owner@example.com');
      assert.equal(email.from, 'you@example.com');
      assert.match(email.subject, /First purchase received/);
      assert.equal(email.event, 'firstPurchase');
      assert.equal(typeof email.html, 'string');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('smtp transport requires url, from and to', async () => {
    const notifier = createNotifier(
      { ...BASE_CONFIG, notifications: { transport: 'smtp', smtpUrl: 'https://api.example' } },
      { info() {}, warn() {}, error() {} },
    );
    const ok = await notifier.notify(NOTIFICATION_EVENT.HEALTH, { message: 'x' });
    assert.equal(ok, false);
  });

  test('getState reports the configured channel', () => {
    const notifier = createNotifier(
      { ...BASE_CONFIG, notifications: { transport: 'webhook', webhookUrl: 'https://hooks.example/notify' } },
      { info() {}, warn() {}, error() {} },
    );
    const state = notifier.getState();
    assert.equal(state.transport, 'webhook');
    assert.equal(state.configured, true);
    assert.equal(state.firstPurchaseFired, false);
    assert.deepEqual(state.channels, { webhook: true, smtp: false });
  });
});