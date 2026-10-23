import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInputs, parsePercent, parseBoolean, normalizePrivateKey, InputError } from '../src/inputs.js';
import { baseEnv, KEYS } from './helpers.js';

test('defaults are applied', () => {
  const env = baseEnv({ 'INPUT_COMMAND': '', 'INPUT_DEPLOYMENT-ENVIRONMENT': '', 'INPUT_MIN-CRASH-FREE-RATE': '', 'INPUT_API-BASE-URL': '' });
  const config = readInputs(env);
  assert.equal(config.command, 'status');
  assert.equal(config.dryRun, false);
  assert.equal(config.deploymentEnvironment, 'appstore-phased-release');
  assert.equal(config.minCrashFreeRate, 99.5);
  assert.equal(config.apiBaseUrl, 'https://api.appstoreconnect.apple.com');
  assert.equal(config.githubApiUrl, 'https://api.github.com');
  assert.equal(config.runUrl, 'https://github.com/octo/app/actions/runs/1001');
});

test('inputs are read from INPUT_ names with dashes kept', () => {
  const env = baseEnv({ 'INPUT_COMMAND': 'Pause', 'INPUT_DRY-RUN': 'TRUE', 'INPUT_GITHUB-API-URL': 'http://localhost:9/' });
  const config = readInputs(env);
  assert.equal(config.command, 'pause');
  assert.equal(config.dryRun, true);
  assert.equal(config.githubApiUrl, 'http://localhost:9');
});

test('unknown command is rejected', () => {
  assert.throws(() => readInputs(baseEnv({ 'INPUT_COMMAND': 'halt' })), /command must be one of status, pause, resume, complete, guard/);
});

test('missing credentials are listed', () => {
  assert.throws(
    () => readInputs(baseEnv({ 'INPUT_ISSUER-ID': '', 'INPUT_PRIVATE-KEY': '' })),
    (error) => error instanceof InputError && /issuer-id, private-key/.test(error.message),
  );
});

test('app-id or bundle-id is required and app-id must be numeric', () => {
  assert.throws(() => readInputs(baseEnv({ 'INPUT_APP-ID': '' })), /Either app-id or bundle-id/);
  assert.throws(() => readInputs(baseEnv({ 'INPUT_APP-ID': 'com.example.app' })), /numeric Apple ID/);
  const config = readInputs(baseEnv({ 'INPUT_APP-ID': '', 'INPUT_BUNDLE-ID': 'com.example.app' }));
  assert.equal(config.bundleId, 'com.example.app');
});

test('guard requires crash-free-rate', () => {
  assert.throws(() => readInputs(baseEnv({ 'INPUT_COMMAND': 'guard' })), /crash-free-rate is required for command guard/);
});

test('guard accepts crash-free-rate with a percent sign', () => {
  const config = readInputs(baseEnv({ 'INPUT_COMMAND': 'guard', 'INPUT_CRASH-FREE-RATE': '99.81%' }));
  assert.equal(config.crashFreeRate, 99.81);
});

test('percent parsing validates range and format', () => {
  assert.equal(parsePercent('100', 'x'), 100);
  assert.equal(parsePercent('0', 'x'), 0);
  assert.throws(() => parsePercent('100.1', 'x'), /between 0 and 100/);
  assert.throws(() => parsePercent('-1', 'x'), /number between 0 and 100/);
  assert.throws(() => parsePercent('abc', 'x'), /number between 0 and 100/);
});

test('booleans are strict', () => {
  assert.equal(parseBoolean('true', 'x'), true);
  assert.equal(parseBoolean('False', 'x'), false);
  assert.throws(() => parseBoolean('yes', 'x'), /must be 'true' or 'false'/);
  assert.throws(() => readInputs(baseEnv({ 'INPUT_DRY-RUN': 'maybe' })), /dry-run must be/);
});

test('private key with escaped newlines is normalized', () => {
  const escaped = KEYS.privatePem.trim().replace(/\n/g, '\\n');
  assert.equal(normalizePrivateKey(escaped), KEYS.privatePem.trim());
  assert.equal(normalizePrivateKey(KEYS.privatePem), KEYS.privatePem);
});
