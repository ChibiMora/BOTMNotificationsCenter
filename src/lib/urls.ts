/** §3.1 path rule: exactly one leading '/', no scheme/host, '//', backslash, '?', '#', '..' segment, whitespace, control or
 *  Unicode format chars (\p{Cf}: bidi, zero-width). A percent-encoded dot segment (%2e / %2E decoding to '.' or '..') is
 *  rejected too, as is a literal '.' segment: WHATWG URL parsing resolves each as a real dot segment.
 *  Length limits are the caller's rule. */
export function validatePath(p: string): boolean {
  if (!p.startsWith('/') || p.includes('//') || /[\\?#\s\p{Cc}\p{Cf}]/u.test(p)) return false;
  return !p.split('/').some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg));
}
/** Compose a stored path with a configured base URL (config.assetBaseUrl / config.siteBaseUrl). */
export const toUrl = (base: string, path: string) => base.replace(/\/+$/, '') + path;
