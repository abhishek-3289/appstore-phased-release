import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, percentageFor, pauseWarning, sortNewestFirst, describeChange, compareVersionStrings } from '../src/phased.js';

test('day to percentage follows the Apple schedule', () => {
  const expected = { 1: 1, 2: 2, 3: 5, 4: 10, 5: 20, 6: 50, 7: 100 };
  for (const [day, percentage] of Object.entries(expected)) {
    assert.equal(percentageFor('ACTIVE', Number(day)), percentage, `day ${day}`);
    assert.equal(percentageFor('PAUSED', Number(day)), percentage, `paused day ${day}`);
  }
});

test('percentage edge cases', () => {
  assert.equal(percentageFor('COMPLETE', 3), 100);
  assert.equal(percentageFor('COMPLETE', null), 100);
  assert.equal(percentageFor('INACTIVE', null), 0);
  assert.equal(percentageFor('ACTIVE', 0), 0);
  assert.equal(percentageFor('ACTIVE', 9), 100);
  assert.equal(percentageFor('ACTIVE', '4'), 10);
});

const TRANSITIONS = [
  ['pause', 'ACTIVE', 'PAUSED', 'paused'],
  ['pause', 'PAUSED', null, 'skipped'],
  ['pause', 'COMPLETE', null, 'skipped'],
  ['pause', 'INACTIVE', null, 'skipped'],
  ['resume', 'PAUSED', 'ACTIVE', 'resumed'],
  ['resume', 'ACTIVE', null, 'skipped'],
  ['resume', 'COMPLETE', null, 'skipped'],
  ['resume', 'INACTIVE', null, 'skipped'],
  ['complete', 'ACTIVE', 'COMPLETE', 'completed'],
  ['complete', 'PAUSED', 'COMPLETE', 'completed'],
  ['complete', 'COMPLETE', null, 'skipped'],
  ['complete', 'INACTIVE', null, 'skipped'],
  ['status', 'ACTIVE', null, 'none'],
  ['status', 'PAUSED', null, 'none'],
  ['status', 'COMPLETE', null, 'none'],
  ['status', 'INACTIVE', null, 'none'],
];

for (const [command, state, change, outcome] of TRANSITIONS) {
  test(`${command} from ${state} -> ${outcome}`, () => {
    const decision = decide({ command, state });
    assert.equal(decision.change, change);
    assert.equal(decision.outcome, outcome);
    assert.ok(decision.reason.length > 0);
  });
}

test('skip reasons explain the state', () => {
  assert.equal(decide({ command: 'pause', state: 'PAUSED' }).reason, 'Phased release is already paused');
  assert.equal(decide({ command: 'resume', state: 'ACTIVE' }).reason, 'Phased release is already active');
  assert.match(decide({ command: 'complete', state: 'COMPLETE' }).reason, /already complete/);
  assert.match(decide({ command: 'resume', state: 'INACTIVE' }).reason, /has not started yet/);
});

const GUARD = [
  ['ACTIVE', 99.9, 99.5, null, 'none', true],
  ['ACTIVE', 99.5, 99.5, null, 'none', true],
  ['ACTIVE', 99.4, 99.5, 'PAUSED', 'paused', false],
  ['PAUSED', 98, 99.5, null, 'skipped', false],
  ['PAUSED', 99.9, 99.5, null, 'none', true],
  ['COMPLETE', 98, 99.5, null, 'skipped', false],
  ['COMPLETE', 99.9, 99.5, null, 'none', true],
  ['INACTIVE', 98, 99.5, null, 'skipped', false],
];

for (const [state, rate, min, change, outcome, healthy] of GUARD) {
  test(`guard ${state} at ${rate}% (min ${min}%) -> ${outcome}`, () => {
    const decision = decide({ command: 'guard', state, crashFreeRate: rate, minCrashFreeRate: min });
    assert.equal(decision.change, change);
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.healthy, healthy);
  });
}

test('guard reasons include the comparison', () => {
  assert.equal(decide({ command: 'guard', state: 'ACTIVE', crashFreeRate: 99.1, minCrashFreeRate: 99.5 }).reason, 'Unhealthy: crash-free rate 99.1% < minimum 99.5%');
  assert.equal(decide({ command: 'guard', state: 'ACTIVE', crashFreeRate: 99.8, minCrashFreeRate: 99.5 }).reason, 'Healthy: crash-free rate 99.8% >= minimum 99.5%');
  assert.match(decide({ command: 'guard', state: 'PAUSED', crashFreeRate: 99.8, minCrashFreeRate: 99.5 }).reason, /stays PAUSED/);
  assert.match(decide({ command: 'guard', state: 'PAUSED', crashFreeRate: 90, minCrashFreeRate: 99.5 }).reason, /but phased release is already paused/);
});

test('pause warning appears from 25 days and flags the 30 day limit', () => {
  assert.equal(pauseWarning(0), null);
  assert.equal(pauseWarning(24), null);
  assert.equal(pauseWarning(null), null);
  assert.match(pauseWarning(25), /25 of the 30 days Apple allows; 5 day\(s\) left/);
  assert.match(pauseWarning(29), /1 day\(s\) left/);
  assert.match(pauseWarning(30), /at most 30 days/);
});

test('versions sort newest first by createdDate', () => {
  const sorted = sortNewestFirst([
    { id: 'a', versionString: '2.4.0', createdDate: '2026-09-01T00:00:00Z' },
    { id: 'b', versionString: '2.3.0', createdDate: '2026-10-01T00:00:00Z' },
  ]);
  assert.deepEqual(sorted.map((v) => v.id), ['b', 'a']);
});

test('versions without createdDate sort by numeric version string', () => {
  const sorted = sortNewestFirst([
    { id: 'd', versionString: '2.9.1', createdDate: '' },
    { id: 'c', versionString: '2.10.0', createdDate: '' },
    { id: 'e', versionString: '2.9', createdDate: '' },
  ]);
  assert.deepEqual(sorted.map((v) => v.id), ['c', 'd', 'e']);
  assert.ok(compareVersionStrings('2.10.0', '2.9.1') > 0);
  assert.equal(compareVersionStrings('1.0', '1.0.0'), 0);
});

test('change description matches deployment format', () => {
  assert.equal(describeChange({ version: '2.3.0', outcome: 'paused', day: 3, percentage: 5 }), '2.3.0 paused on day 3 (5%)');
  assert.equal(describeChange({ version: '2.3.0', outcome: 'completed', day: null, percentage: 100 }), '2.3.0 completed (100%)');
});
