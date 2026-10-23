import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const APP = { id: '123456789', name: 'Example App', bundleId: 'com.example.app' };

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
}

function appleError(response, status, code, detail) {
  send(response, status, { errors: [{ status: String(status), code, title: code, detail }] });
}

function checkToken(header, publicKey, nowSeconds) {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header || '');
  if (!match) {
    return 'Missing or malformed bearer token';
  }
  const [, encodedHeader, encodedClaims, encodedSignature] = match;
  const jwtHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString());
  if (jwtHeader.alg !== 'ES256' || jwtHeader.typ !== 'JWT' || !jwtHeader.kid) {
    return 'Token header must be {alg: ES256, kid, typ: JWT}';
  }
  if (claims.aud !== 'appstoreconnect-v1' || !claims.iss) {
    return 'Token claims must include iss and aud appstoreconnect-v1';
  }
  if (claims.exp - claims.iat > 1200 || claims.exp <= nowSeconds) {
    return 'Token lifetime must be at most 20 minutes and not expired';
  }
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64) {
    return 'Token signature must be raw R||S (64 bytes)';
  }
  if (publicKey && !verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) {
    return 'Token signature does not verify';
  }
  return null;
}

export function createMockServer({ publicKeyPem = '', state = 'ACTIVE', day = 3, totalPauseDuration = 0 } = {}) {
  const publicKey = publicKeyPem ? createPublicKey(publicKeyPem) : null;
  const phased = { id: 'pr-230', state, day, totalPauseDuration };
  const stats = { requests: 0, patches: 0, authFailures: 0 };

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/__stats') {
      send(response, 200, stats);
      return;
    }
    stats.requests += 1;
    const authError = checkToken(request.headers.authorization, publicKey, Math.floor(Date.now() / 1000));
    if (authError) {
      stats.authFailures += 1;
      appleError(response, 401, 'NOT_AUTHORIZED', authError);
      return;
    }

    const appData = { type: 'apps', id: APP.id, attributes: { name: APP.name, bundleId: APP.bundleId } };
    const phasedData = () => ({
      type: 'appStoreVersionPhasedReleases',
      id: phased.id,
      attributes: {
        phasedReleaseState: phased.state,
        currentDayNumber: phased.day,
        startDate: '2026-10-20T00:00:00Z',
        totalPauseDuration: phased.totalPauseDuration,
      },
    });

    if (request.method === 'GET' && url.pathname === '/v1/apps') {
      const bundleId = url.searchParams.get('filter[bundleId]');
      send(response, 200, { data: bundleId === APP.bundleId ? [appData] : [] });
      return;
    }
    if (request.method === 'GET' && url.pathname === `/v1/apps/${APP.id}`) {
      send(response, 200, { data: appData });
      return;
    }
    if (request.method === 'GET' && url.pathname === `/v1/apps/${APP.id}/appStoreVersions`) {
      if (url.searchParams.get('filter[platform]') !== 'IOS') {
        appleError(response, 400, 'PARAMETER_ERROR.REQUIRED', 'filter[platform] must be IOS');
        return;
      }
      const versions = [
        { type: 'appStoreVersions', id: 'ver-220', attributes: { versionString: '2.2.0', appStoreState: 'READY_FOR_SALE', createdDate: '2026-09-01T00:00:00Z' } },
        { type: 'appStoreVersions', id: 'ver-230', attributes: { versionString: '2.3.0', appStoreState: 'READY_FOR_SALE', createdDate: '2026-10-18T00:00:00Z' } },
      ];
      const wanted = url.searchParams.get('filter[versionString]');
      send(response, 200, { data: wanted ? versions.filter((v) => v.attributes.versionString === wanted) : versions });
      return;
    }
    const phasedMatch = /^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionPhasedRelease$/.exec(url.pathname);
    if (request.method === 'GET' && phasedMatch) {
      send(response, 200, { data: phasedMatch[1] === 'ver-230' ? phasedData() : null });
      return;
    }
    if (request.method === 'PATCH' && url.pathname === `/v1/appStoreVersionPhasedReleases/${phased.id}`) {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        stats.patches += 1;
        const body = JSON.parse(raw || '{}');
        const target = body?.data?.attributes?.phasedReleaseState;
        if (body?.data?.type !== 'appStoreVersionPhasedReleases' || body?.data?.id !== phased.id || !target) {
          appleError(response, 409, 'ENTITY_ERROR', 'Invalid phased release document');
          return;
        }
        phased.state = target;
        send(response, 200, { data: phasedData() });
      });
      return;
    }
    appleError(response, 404, 'NOT_FOUND', `No mock for ${request.method} ${url.pathname}`);
  });

  return { server, stats, phased };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT || 8787);
  const publicKeyPem = process.env.MOCK_PUBLIC_KEY_FILE ? readFileSync(process.env.MOCK_PUBLIC_KEY_FILE, 'utf8') : '';
  const { server } = createMockServer({
    publicKeyPem,
    state: process.env.MOCK_STATE || 'ACTIVE',
    day: Number(process.env.MOCK_DAY || 3),
    totalPauseDuration: Number(process.env.MOCK_PAUSE_DAYS || 0),
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`App Store Connect mock listening on http://127.0.0.1:${port}\n`);
  });
}
