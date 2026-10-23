import { createPrivateKey, sign } from 'node:crypto';

export const AUDIENCE = 'appstoreconnect-v1';
export const MAX_TOKEN_LIFETIME_SECONDS = 1200;
export const TOKEN_LIFETIME_SECONDS = 1140;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function loadPrivateKey(pem) {
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('private-key could not be parsed; pass the full contents of the AuthKey_XXXXXXXXXX.p8 file including the BEGIN/END lines');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('private-key must be an EC P-256 key (the .p8 file downloaded from App Store Connect)');
  }
  return key;
}

export function createToken({ issuerId, keyId, privateKey, now = Date.now(), lifetimeSeconds = TOKEN_LIFETIME_SECONDS }) {
  const key = loadPrivateKey(privateKey);
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.min(lifetimeSeconds, MAX_TOKEN_LIFETIME_SECONDS);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const claims = { iss: issuerId, iat, exp, aud: AUDIENCE };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}
