import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppStoreConnectClient, AppStoreApiError, errorDetails } from '../src/appstore.js';
import { findPhasedRelease } from '../src/run.js';
import { createFetchStub, ascRoutes, version, phasedRelease, APP } from './helpers.js';

const BASE = 'https://api.appstoreconnect.apple.com';

function client(routes) {
  const stub = createFetchStub(routes);
  return { stub, client: new AppStoreConnectClient({ baseUrl: BASE, token: 'jwt-token', fetch: stub.fetch }) };
}

test('requests carry the bearer token and target the API base URL', async () => {
  const { stub, client: api } = client(ascRoutes());
  await api.getApp(APP.id);
  assert.equal(stub.calls[0].origin, BASE);
  assert.equal(stub.calls[0].path, '/v1/apps/123456789');
  assert.equal(stub.calls[0].headers.Authorization, 'Bearer jwt-token');
});

test('bundle id is resolved through filter[bundleId]', async () => {
  const { stub, client: api } = client(ascRoutes());
  const app = await api.findAppByBundleId('com.example.app');
  assert.deepEqual(app, APP);
  assert.equal(stub.calls[0].path, '/v1/apps');
  assert.equal(stub.calls[0].query['filter[bundleId]'], 'com.example.app');
});

test('bundle id resolution requires an exact match', async () => {
  const { client: api } = client([
    { path: '/v1/apps', respond: { status: 200, body: { data: [{ type: 'apps', id: '1', attributes: { bundleId: 'com.example.app.widget' } }] } } },
  ]);
  await assert.rejects(api.findAppByBundleId('com.example.app'), /No app with bundle ID 'com.example.app'/);
});

test('versions are listed with platform and live state filters', async () => {
  const { stub, client: api } = client(ascRoutes());
  await api.listVersions(APP.id);
  const query = stub.calls[0].query;
  assert.equal(stub.calls[0].path, '/v1/apps/123456789/appStoreVersions');
  assert.equal(query['filter[platform]'], 'IOS');
  assert.equal(query['filter[appStoreState]'], 'READY_FOR_SALE,PENDING_DEVELOPER_RELEASE,PROCESSING_FOR_APP_STORE');
  assert.equal(query.limit, '10');
  assert.equal(query['filter[versionString]'], undefined);
});

test('a specific version uses filter[versionString] without the state filter', async () => {
  const { stub, client: api } = client(ascRoutes());
  await api.listVersions(APP.id, { version: '2.3.0', limit: 5 });
  const query = stub.calls[0].query;
  assert.equal(query['filter[versionString]'], '2.3.0');
  assert.equal(query['filter[appStoreState]'], undefined);
  assert.equal(query['filter[platform]'], 'IOS');
});

test('phased release attributes are mapped', async () => {
  const { stub, client: api } = client(ascRoutes({ state: 'PAUSED', day: 4, totalPauseDuration: 6 }));
  const release = await api.getPhasedRelease('ver-230');
  assert.equal(stub.calls[0].path, '/v1/appStoreVersions/ver-230/appStoreVersionPhasedRelease');
  assert.deepEqual(release, { id: 'pr-230', state: 'PAUSED', day: 4, startDate: '2026-10-20T00:00:00Z', totalPauseDuration: 6 });
});

test('missing phased release returns null for data null and for 404', async () => {
  const { client: api } = client([
    { path: '/v1/appStoreVersions/a/appStoreVersionPhasedRelease', respond: { status: 200, body: { data: null } } },
    { path: '/v1/appStoreVersions/b/appStoreVersionPhasedRelease', respond: { status: 404, body: { errors: [{ detail: 'not found' }] } } },
  ]);
  assert.equal(await api.getPhasedRelease('a'), null);
  assert.equal(await api.getPhasedRelease('b'), null);
});

test('PATCH sends the JSON:API document', async () => {
  const { stub, client: api } = client(ascRoutes());
  const updated = await api.setPhasedReleaseState('pr-230', 'PAUSED');
  const call = stub.calls[0];
  assert.equal(call.method, 'PATCH');
  assert.equal(call.path, '/v1/appStoreVersionPhasedReleases/pr-230');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.deepEqual(call.body, { data: { type: 'appStoreVersionPhasedReleases', id: 'pr-230', attributes: { phasedReleaseState: 'PAUSED' } } });
  assert.equal(updated.state, 'PAUSED');
});

test('Apple error details are surfaced', async () => {
  const { client: api } = client([
    {
      method: 'PATCH',
      path: '/v1/appStoreVersionPhasedReleases/pr-1',
      respond: {
        status: 409,
        body: { errors: [
          { status: '409', code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', title: 'An attribute value is invalid.', detail: 'The phased release cannot be paused.' },
          { status: '409', code: 'STATE_ERROR', title: 'Second problem' },
        ] },
      },
    },
  ]);
  await assert.rejects(api.setPhasedReleaseState('pr-1', 'PAUSED'), (error) => {
    assert.ok(error instanceof AppStoreApiError);
    assert.equal(error.status, 409);
    assert.equal(error.message, 'App Store Connect API PATCH /v1/appStoreVersionPhasedReleases/pr-1 failed with HTTP 409: The phased release cannot be paused.; Second problem');
    return true;
  });
});

test('non JSON error bodies still report the status', async () => {
  const api = new AppStoreConnectClient({
    baseUrl: BASE,
    token: 't',
    fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }),
  });
  await assert.rejects(api.getApp('1'), /GET \/v1\/apps\/1 failed with HTTP 502$/);
});

test('errorDetails falls back to title and code', () => {
  assert.deepEqual(errorDetails({ errors: [{ title: 'T' }, { code: 'C' }, {}] }), ['T', 'C']);
  assert.deepEqual(errorDetails(null), []);
});

test('version selection picks the newest version that has a phased release', async () => {
  const versions = [
    version('ver-220', '2.2.0', 'READY_FOR_SALE', '2026-09-01T00:00:00Z'),
    version('ver-240', '2.4.0', 'PROCESSING_FOR_APP_STORE', '2026-10-21T00:00:00Z'),
    version('ver-230', '2.3.0', 'PENDING_DEVELOPER_RELEASE', '2026-10-10T00:00:00Z'),
  ];
  const phased = { 'ver-230': phasedRelease('pr-230', 'INACTIVE', null), 'ver-220': phasedRelease('pr-220', 'COMPLETE', 7) };
  const { stub, client: api } = client(ascRoutes({ versions, phased }));
  const target = await findPhasedRelease(api, APP.id, '');
  assert.equal(target.version.versionString, '2.3.0');
  assert.equal(target.phasedRelease.state, 'INACTIVE');
  const looked = stub.calls.filter((call) => call.path.endsWith('/appStoreVersionPhasedRelease')).map((call) => call.path.split('/')[3]);
  assert.deepEqual(looked, ['ver-240', 'ver-230']);
});

test('version selection returns null when no version has a phased release', async () => {
  const { client: api } = client(ascRoutes({ phased: {} }));
  assert.equal(await findPhasedRelease(api, APP.id, ''), null);
});

test('specific version that does not exist fails', async () => {
  const { client: api } = client(ascRoutes({ versions: [] }));
  await assert.rejects(findPhasedRelease(api, APP.id, '9.9.9'), /Version 9.9.9 was not found/);
});

test('specific version without phased release fails', async () => {
  const { client: api } = client(ascRoutes({ phased: {} }));
  await assert.rejects(findPhasedRelease(api, APP.id, '2.3.0'), /does not have a phased release/);
});

test('specific version is selected', async () => {
  const versions = [version('ver-221', '2.2.1', 'READY_FOR_SALE', '2026-09-20T00:00:00Z')];
  const phased = { 'ver-221': phasedRelease('pr-221', 'ACTIVE', 5) };
  const { stub, client: api } = client(ascRoutes({ versions, phased }));
  const target = await findPhasedRelease(api, APP.id, '2.2.1');
  assert.equal(target.phasedRelease.id, 'pr-221');
  assert.equal(stub.calls[0].query['filter[versionString]'], '2.2.1');
});
