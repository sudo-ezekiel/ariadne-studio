// The studio has no login because it is one person's tool on their own
// computer. A web page open in the same browser is not that person, though, and
// it can reach 127.0.0.1: a plain POST needs no permission from the server, and
// a site that re-points its own name at this address can read answers too. The
// API drives a phone and hands out screenshots, so it answers only to this
// computer's own pages.

const LOOPBACK_NAME = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

function nameOf(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '');
}

/** True for an address only this computer can reach, the default. */
export function isLoopback(listenHost: string): boolean {
  return LOOPBACK_NAME.test(listenHost) || listenHost === '::1';
}

type Headers = { host?: string | undefined; origin?: string | undefined; 'sec-fetch-site'?: string | string[] | undefined };

/**
 * False for a request made by another site. `listenHost` is the address the
 * server listens on: someone who passed --host on purpose reaches it by another
 * name, so only there a request's Host may be anything.
 */
export function fromThisComputer(headers: Headers, listenHost: string): boolean {
  const host = headers.host ?? '';
  // A rebound name arrives here with that name as its Host.
  if (isLoopback(listenHost) && !LOOPBACK_NAME.test(nameOf(host))) return false;
  if ([headers['sec-fetch-site']].flat().join(',').includes('cross-site')) return false;
  if (!headers.origin) return true;
  let origin: URL;
  try {
    origin = new URL(headers.origin);
  } catch {
    return false;
  }
  return LOOPBACK_NAME.test(origin.hostname) || origin.host === host;
}
