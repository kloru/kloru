/**
 * A path on this site, never another origin. Browsers strip tabs and newlines and treat
 * backslashes as slashes, so `/\t/evil.com` would leave the site: refuse those (raw or
 * percent-encoded), then resolve against a dummy origin and keep only the path and query.
 */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]|%(?:[01][0-9a-f]|7f|5c)/i.test(next)) return "/";
  try {
    const u = new URL(next, "https://console.invalid");
    if (u.origin !== "https://console.invalid") return "/";
    return u.pathname.startsWith("//") ? "/" : u.pathname + u.search;
  } catch {
    return "/";
  }
}
