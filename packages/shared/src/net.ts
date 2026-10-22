// Where a server is (§9, §16.4): generated code (L3 skills) is only ever allowed on a private server, one only this
// machine or its own private network can reach.

import net from 'node:net';

/**
 * A host only this machine or its private network can reach: loopback, the private IPv4 ranges (RFC 1918),
 * link-local, and IPv6 loopback, unique-local and link-local. "0.0.0.0" binds every interface, so it is not one.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = net.isIP(h);
  if (kind === 4) {
    const [a = -1, b = -1] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (kind === 6) {
    if (h === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)?.[1];
    if (mapped) return isPrivateHost(mapped);
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  return false;
}
