// The browser's side of Web Push, for tests: a subscription's keys, decryption of what the
// push service would deliver (RFC 8291), and a check of the sender's VAPID signature.
const enc = new TextEncoder();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));

export async function fakeBrowser(endpoint = 'https://push.example.com/send/abc') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) } },
    async decrypt(body) {
      body = new Uint8Array(body);
      const salt = body.slice(0, 16);
      const idlen = body[20];
      const asPublic = body.slice(21, 21 + idlen);
      const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, kp.privateKey, 256));
      const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...pub, ...asPublic]);
      const ikm = await hkdf(auth, shared, info, 32);
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      if (plain[end] !== 2) throw new Error('missing last-record delimiter');
      return new TextDecoder().decode(plain.slice(0, end));
    },
  };
}

// Returns the JWT claims when the Authorization header is validly signed by its own key.
export async function checkVapid(authorization) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  if (!m) throw new Error(`bad Authorization: ${authorization}`);
  const [head, claims, sig] = m[1].split('.');
  const key = await crypto.subtle.importKey('raw', Buffer.from(m[2], 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64url'), enc.encode(`${head}.${claims}`));
  if (!ok) throw new Error('bad VAPID signature');
  return JSON.parse(Buffer.from(claims, 'base64url').toString());
}
