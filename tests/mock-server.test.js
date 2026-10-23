import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { run } from '../src/run.js';
import { createIO } from '../src/io.js';
import { createMockServer } from './mock-server.js';
import { baseEnv, readOutputs, captureIO, KEYS } from './helpers.js';

async function withServer(options, callback) {
  const publicKeyPem = KEYS.publicKey.export({ type: 'spki', format: 'pem' });
  const mock = createMockServer({ publicKeyPem, ...options });
  mock.server.listen(0, '127.0.0.1');
  await once(mock.server, 'listening');
  const { port } = mock.server.address();
  try {
    await callback({ ...mock, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    mock.server.close();
  }
}

async function runAgainst(baseUrl, overrides) {
  const env = baseEnv({ 'INPUT_API-BASE-URL': baseUrl, 'INPUT_GITHUB-TOKEN': '', ...overrides });
  const capture = captureIO();
  const code = await run({ env, io: createIO({ env, write: capture.write }) });
  return { code, outputs: readOutputs(env), lines: capture.lines };
}

test('dry-run against the mock server reports and never PATCHes', async () => {
  await withServer({}, async ({ baseUrl, stats }) => {
    const result = await runAgainst(baseUrl, { 'INPUT_COMMAND': 'pause', 'INPUT_DRY-RUN': 'true', 'INPUT_APP-ID': '', 'INPUT_BUNDLE-ID': 'com.example.app' });
    assert.equal(result.code, 0);
    assert.equal(result.outputs.version, '2.3.0');
    assert.equal(result.outputs.state, 'ACTIVE');
    assert.equal(result.outputs.day, '3');
    assert.equal(result.outputs.percentage, '5');
    assert.equal(result.outputs['action-taken'], 'none');
    assert.equal(stats.patches, 0);
    assert.equal(stats.authFailures, 0);
  });
});

test('real pause against the mock server changes state', async () => {
  await withServer({}, async ({ baseUrl, stats, phased }) => {
    const result = await runAgainst(baseUrl, { 'INPUT_COMMAND': 'pause' });
    assert.equal(result.code, 0);
    assert.equal(result.outputs['action-taken'], 'paused');
    assert.equal(stats.patches, 1);
    assert.equal(phased.state, 'PAUSED');
  });
});

test('a token signed by another key is rejected and surfaced', async () => {
  await withServer({}, async ({ baseUrl, stats }) => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const result = await runAgainst(baseUrl, { 'INPUT_PRIVATE-KEY': other });
    assert.equal(result.code, 1);
    assert.equal(stats.authFailures, 1);
    assert.match(result.outputs.reason, /HTTP 401: Token signature does not verify/);
  });
});
