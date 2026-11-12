// Cloudflare Access sits in front of the hosted app, and this is the second lock behind
// it: the Worker checks the signed token Access attaches to every request, so a mistake
// in the Access application cannot open the model route to anyone. The Worker refuses
// every request until the team domain and the application's AUD tag are set.
//
// Pure functions over WebCrypto (no Cloudflare types), so the offline suite can run them
// with a key it makes itself.

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AccessError";
    this.status = status;
  }
}

export type AccessConfig = { teamDomain: string; aud: string };
export type Jwk = { kid: string; kty: string; alg?: string; n: string; e: string };
export type FetchCerts = (teamDomain: string, fresh: boolean) => Promise<Jwk[]>;

const b64url = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

/** The token Access puts on a request: its header, or the cookie it sets in the browser. */
export function tokenFrom(headers: Headers): string | null {
  const h = headers.get("cf-access-jwt-assertion");
  if (h) return h;
  const cookie = headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

export async function verifyAccessJwt(token: string, cfg: AccessConfig, fetchCerts: FetchCerts, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ email?: string; sub?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError(403, "Not an Access token.");
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string[] | string; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string };
  try {
    header = json(parts[0]);
    payload = json(parts[1]);
  } catch {
    throw new AccessError(403, "Not an Access token.");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AccessError(403, "Unsupported Access token.");

  let keys = await fetchCerts(cfg.teamDomain, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchCerts(cfg.teamDomain, true); // Access rotates its keys; look once more before refusing
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AccessError(403, "Unknown Access signing key.");

  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]) as BufferSource, signed);
  if (!valid) throw new AccessError(403, "Access token signature does not match.");

  if (payload.iss !== `https://${cfg.teamDomain}`) throw new AccessError(403, "Access token is from another team.");
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(cfg.aud)) throw new AccessError(403, "Access token is for another application.");
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) throw new AccessError(403, "Access token has expired.");
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + 60) throw new AccessError(403, "Access token is not valid yet.");
  return { email: payload.email, sub: payload.sub };
}

/** Access's published keys, kept for ten minutes; `fresh` asks again. */
const certCache = new Map<string, { at: number; keys: Jwk[] }>();
export const fetchAccessCerts: FetchCerts = async (teamDomain, fresh) => {
  const hit = certCache.get(teamDomain);
  if (hit && !fresh && Date.now() - hit.at < 10 * 60_000) return hit.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessError(503, `Could not fetch Access's keys (${res.status}).`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  certCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
};

export type AccessEnv = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; BROLGA_DEV_NO_ACCESS?: string };

/**
 * Null when the request may go on; a Response when it may not. Fails closed: with the team
 * domain or the AUD tag unset, nothing gets in. The one way round is for `wrangler dev` on
 * this machine: a var in .dev.vars, honoured only for a request addressed to localhost.
 */
export async function checkAccess(request: Request, env: AccessEnv, fetchCerts: FetchCerts = fetchAccessCerts): Promise<Response | null> {
  const host = new URL(request.url).hostname;
  if (env.BROLGA_DEV_NO_ACCESS === "1" && (host === "localhost" || host === "127.0.0.1")) return null;
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!teamDomain || !aud) return new Response("Not available: sign-in is not configured.", { status: 503 });
  const token = tokenFrom(request.headers);
  if (!token) return new Response("Sign in required.", { status: 403 });
  try {
    await verifyAccessJwt(token, { teamDomain, aud }, fetchCerts);
    return null;
  } catch (err) {
    const status = err instanceof AccessError ? err.status : 403;
    return new Response("Sign in required.", { status });
  }
}
