// ============================================================================
// Outbound SSRF guard — shared by every module that fetches a URL supplied or
// influenced by an external party (peer registries, the task agent, the A2A
// proxy). Blocks loopback/private/link-local/metadata/reserved addresses and
// re-validates every redirect hop, so neither an attacker-supplied URL nor a
// 3xx response from a peer can steer an outbound request at internal
// infrastructure (e.g. the cloud metadata service at 169.254.169.254).
// ============================================================================

import dns from 'node:dns/promises';
import net from 'node:net';

/** Redirect hops re-validated before being followed. */
const MAX_REDIRECTS = 3;

/** Upper bound on the DNS resolution step, independent of the fetch's own timeout. */
const DNS_TIMEOUT_MS = 5000;

/**
 * @param {string} ip - Dotted-quad IPv4 address
 * @returns {number} 32-bit unsigned integer representation
 */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

/**
 * @param {string} ip - IPv4 address to test
 * @returns {boolean} True when the address is loopback/private/link-local/reserved
 */
function isBlockedIPv4(ip) {
  const value = ipv4ToInt(ip);
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) || // "this" network
    inRange('10.0.0.0', 8) || // RFC1918 private
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local, incl. cloud metadata (169.254.169.254)
    inRange('172.16.0.0', 12) || // RFC1918 private
    inRange('192.0.0.0', 24) || // IETF protocol assignments
    inRange('192.168.0.0', 16) || // RFC1918 private
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

/**
 * @param {string} ip - IPv6 address to test
 * @returns {boolean} True when the address is loopback/unique-local/link-local/multicast
 */
function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast ff00::/8
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isBlockedIPv4(v4Mapped[1]);
  return false;
}

// The test suite runs peer x402/agent services as real HTTP servers on
// 127.0.0.1 (see test/support/boot.js, growth.test.js, agent.test.js) and
// treats them as pitch/discovery/proxy targets exactly like a real deployment
// would treat a public peer — so loopback has to be reachable there, and only
// there. `NODE_ENV=test` is set by `npm test` alone; it is never a value a
// real deployment runs under (the Dockerfile hardcodes `production`), so this
// can only relax the guard inside the test run itself. Every other blocked
// range (link-local/metadata, RFC1918, etc.) stays blocked unconditionally.
const ALLOW_LOOPBACK = process.env.NODE_ENV === 'test';

/**
 * @param {string} ip - IP literal (v4 or v6) to test
 * @returns {boolean} True when the address is a loopback address (127.0.0.0/8, ::1)
 */
function isLoopback(ip) {
  const version = net.isIP(ip);
  if (version === 4) return ip.startsWith('127.');
  if (version === 6) return ip === '::1';
  return false;
}

/**
 * @param {string} ip - IP literal (v4 or v6) to test
 * @returns {boolean} True when the address must never be reached from this server
 */
function isBlockedIp(ip) {
  if (ALLOW_LOOPBACK && isLoopback(ip)) return false;
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return true; // Not a recognisable IP literal — fail closed.
}

/**
 * Reject any URL that is not a public http(s) address: wrong scheme, an IP
 * literal in a private/loopback/link-local/reserved range, or a hostname that
 * resolves to one. Safe to call on fully untrusted input.
 *
 * @param {string} rawUrl - Candidate URL
 * @returns {Promise<URL>} The parsed URL when it is safe to fetch
 * @throws {Error} With a message safe to surface to a caller
 */
export async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('Target address is not a public address');
    return url;
  }
  if (!ALLOW_LOOPBACK && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new Error('Target address is not a public address');
  }
  let addresses;
  try {
    // Bounded explicitly: dns.lookup() has no timeout of its own, and an
    // unresponsive/blackholed resolver could otherwise hang this check far
    // longer than the fetch it is meant to gate.
    addresses = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_TIMEOUT_MS)),
    ]);
  } catch {
    throw new Error('Target host could not be resolved');
  }
  if (addresses.length === 0) throw new Error('Target host could not be resolved');
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new Error('Target host resolves to a non-public address');
  }
  return url;
}

/**
 * Fetch a URL that may be attacker-influenced. Validates the target — and
 * every redirect hop, manually, before following it — so neither a crafted
 * literal nor a 3xx response from a peer can steer the request at internal
 * infrastructure. (DNS-rebinding between validation and connect is a residual
 * risk inherent to any resolve-then-fetch guard without a pinned-IP HTTP
 * client; this closes the practical, direct SSRF paths.)
 *
 * @param {string} url - Candidate URL
 * @param {RequestInit} [init] - Standard fetch options
 * @returns {Promise<Response>} The final, non-redirect response
 * @throws {Error} When the target (or a redirect target) is not public, or
 *   there are too many redirects
 */
export async function safeFetch(url, init = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertPublicHttpUrl(current);
    const response = await fetch(validated, { ...init, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, validated).toString();
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects');
}
