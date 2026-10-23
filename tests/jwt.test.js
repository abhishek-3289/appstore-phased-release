import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createToken, loadPrivateKey, AUDIENCE, MAX_TOKEN_LIFETIME_SECONDS } from '../src/jwt.js';
import { KEYS } from './helpers.js';

function decode(token) {
  const [header, claims, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
    signature: Buffer.from(signature, 'base64url'),
    signingInput: `${header}.${claims}`,
  };
}

const NOW = Date.parse('2026-10-23T12:00:00Z');

test('token header uses ES256 with the key id', () => {
  const token = createToken({ issuerId: 'issuer-1', keyId: 'KEY123', privateKey: KEYS.privatePem, now: NOW });
  const { header } = decode(token);
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
});

test('token claims carry issuer, audience and a lifetime of at most 20 minutes', () => {
  const token = createToken({ issuerId: 'issuer-1', keyId: 'KEY123', privateKey: KEYS.privatePem, now: NOW });
  const { claims } = decode(token);
  assert.equal(claims.iss, 'issuer-1');
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.equal(claims.iat, Math.floor(NOW / 1000));
  assert.ok(claims.exp > claims.iat);
  assert.ok(claims.exp - claims.iat <= 1200);
});

test('requested lifetime is capped at 1200 seconds', () => {
  const token = createToken({ issuerId: 'i', keyId: 'k', privateKey: KEYS.privatePem, now: NOW, lifetimeSeconds: 7200 });
  const { claims } = decode(token);
  assert.equal(claims.exp - claims.iat, MAX_TOKEN_LIFETIME_SECONDS);
});

test('signature is a 64 byte raw R||S value that verifies as IEEE P1363', () => {
  const token = createToken({ issuerId: 'issuer-1', keyId: 'KEY123', privateKey: KEYS.privatePem, now: NOW });
  const { signature, signingInput } = decode(token);
  assert.equal(signature.length, 64);
  assert.equal(verify('sha256', Buffer.from(signingInput), { key: KEYS.publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
  assert.equal(verify('sha256', Buffer.from(`${signingInput}x`), { key: KEYS.publicKey, dsaEncoding: 'ieee-p1363' }, signature), false);
});

test('token is three base64url segments without padding', () => {
  const token = createToken({ issuerId: 'issuer-1', keyId: 'KEY123', privateKey: KEYS.privatePem, now: NOW });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('invalid key text fails without echoing the key', () => {
  const secret = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key-secret\n-----END PRIVATE KEY-----';
  assert.throws(() => loadPrivateKey(secret), (error) => {
    assert.match(error.message, /could not be parsed/);
    assert.doesNotMatch(error.message, /not-a-real-key-secret/);
    return true;
  });
});

test('RSA keys are rejected', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => loadPrivateKey(pem), /EC P-256/);
});

test('EC keys on other curves are rejected', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => loadPrivateKey(pem), /EC P-256/);
});
