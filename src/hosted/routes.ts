/** Requests that read or write state: the app's API, but not the briefing route, which opens its own scopes around the model call. */
export function needsScope(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  return !/^\/api\/investigate\/[^/]+\/brief\/?$/.test(pathname);
}
