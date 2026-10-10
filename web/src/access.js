// Confirms the request came through Cloudflare Access.
// Prefers ctx.access (set by Worker-level Access); otherwise verifies the
// Cf-Access-Jwt-Assertion header against the team's public keys.

let jwksCache = { domain: null, keys: null, fetchedAt: 0 };

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

async function getKeys(teamDomain) {
  const fresh = Date.now() - jwksCache.fetchedAt < 3600 * 1000;
  if (jwksCache.domain === teamDomain && jwksCache.keys && fresh) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { domain: teamDomain, keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyJwt(token, teamDomain, aud) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  if (header.alg !== 'RS256') return false;

  const jwk = (await getKeys(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return false;

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return auds.includes(aud) && payload.exp > now && payload.iss === `https://${teamDomain}`;
}

export async function isAuthorized(request, env, ctx) {
  if (ctx && ctx.access) return true;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    return await verifyJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  } catch {
    return false;
  }
}
