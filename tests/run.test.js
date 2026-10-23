import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/run.js';
import { createIO } from '../src/io.js';
import {
  createFetchStub, ascRoutes, githubRoutes, slackRoutes, baseEnv, readOutputs, readSummary, captureIO,
  version, phasedRelease, SLACK_URL,
} from './helpers.js';

async function execute({ env: overrides = {}, routes = ascRoutes(), extraRoutes = [] } = {}) {
  const env = baseEnv(overrides);
  const stub = createFetchStub([...routes, ...extraRoutes]);
  const capture = captureIO();
  const io = createIO({ env, write: capture.write });
  const code = await run({ env, fetch: stub.fetch, now: () => Date.parse('2026-10-23T12:00:00Z'), io });
  return {
    code,
    calls: stub.calls,
    outputs: readOutputs(env),
    summary: readSummary(env),
    lines: capture.lines,
    patches: stub.calls.filter((call) => call.method === 'PATCH'),
    slack: stub.calls.filter((call) => call.url === SLACK_URL),
    deployments: stub.calls.filter((call) => call.path.endsWith('/deployments')),
    statuses: stub.calls.filter((call) => call.path.endsWith('/statuses')),
  };
}

const APPLIED = [
  ['pause', 'ACTIVE', 'PAUSED', 'paused'],
  ['resume', 'PAUSED', 'ACTIVE', 'resumed'],
  ['complete', 'ACTIVE', 'COMPLETE', 'completed'],
  ['complete', 'PAUSED', 'COMPLETE', 'completed'],
];

for (const [command, from, to, outcome] of APPLIED) {
  test(`${command} from ${from} patches to ${to}`, async () => {
    const result = await execute({
      env: { 'INPUT_COMMAND': command },
      routes: ascRoutes({ state: from, day: 3 }),
      extraRoutes: githubRoutes(),
    });
    assert.equal(result.code, 0);
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0].body.data.attributes.phasedReleaseState, to);
    assert.equal(result.outputs['action-taken'], outcome);
    assert.equal(result.outputs['previous-state'], from);
    assert.equal(result.outputs.state, to);
    assert.equal(result.outputs.percentage, to === 'COMPLETE' ? '100' : '5');
    assert.equal(result.deployments.length, 1);
    assert.equal(result.statuses.length, 1);
  });
}

const SKIPPED = [
  ['pause', 'PAUSED'],
  ['pause', 'COMPLETE'],
  ['pause', 'INACTIVE'],
  ['resume', 'ACTIVE'],
  ['resume', 'COMPLETE'],
  ['resume', 'INACTIVE'],
  ['complete', 'COMPLETE'],
  ['complete', 'INACTIVE'],
];

for (const [command, state] of SKIPPED) {
  test(`${command} from ${state} is skipped without PATCH`, async () => {
    const result = await execute({ env: { 'INPUT_COMMAND': command }, routes: ascRoutes({ state, day: state === 'INACTIVE' ? null : 4 }) });
    assert.equal(result.code, 0);
    assert.equal(result.patches.length, 0);
    assert.equal(result.deployments.length, 0);
    assert.equal(result.outputs['action-taken'], 'skipped');
    assert.equal(result.outputs.state, state);
    assert.equal(result.outputs['previous-state'], state);
  });
}

test('status reports state, day and percentage without changes', async () => {
  const result = await execute({ routes: ascRoutes({ state: 'ACTIVE', day: 6 }) });
  assert.equal(result.code, 0);
  assert.equal(result.patches.length, 0);
  assert.deepEqual(
    { ...result.outputs },
    {
      'app-id': '123456789', version: '2.3.0', state: 'ACTIVE', day: '6', percentage: '50',
      'previous-state': 'ACTIVE', 'action-taken': 'none', reason: 'Phased release is ACTIVE',
    },
  );
});

test('status for INACTIVE reports empty day and 0 percent', async () => {
  const result = await execute({ routes: ascRoutes({ state: 'INACTIVE', day: null }) });
  assert.equal(result.outputs.day, '');
  assert.equal(result.outputs.percentage, '0');
});

test('bundle id input resolves the app', async () => {
  const result = await execute({ env: { 'INPUT_APP-ID': '', 'INPUT_BUNDLE-ID': 'com.example.app' } });
  assert.equal(result.code, 0);
  assert.equal(result.outputs['app-id'], '123456789');
  assert.equal(result.calls[0].query['filter[bundleId]'], 'com.example.app');
});

test('the JWT is masked and the private key is never printed', async () => {
  const result = await execute();
  const mask = result.lines.find((line) => line.startsWith('::add-mask::'));
  assert.ok(mask);
  const token = mask.slice('::add-mask::'.length);
  assert.equal(result.calls[0].headers.Authorization, `Bearer ${token}`);
  const everything = result.lines.join('\n') + result.summary + JSON.stringify(result.outputs);
  assert.doesNotMatch(everything, /PRIVATE KEY/);
  assert.equal(result.lines.filter((line) => line.includes(token)).length, 1);
});

test('guard pauses an ACTIVE release below the threshold', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'guard', 'INPUT_CRASH-FREE-RATE': '98.7', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ state: 'ACTIVE', day: 3 }),
    extraRoutes: [...githubRoutes(), ...slackRoutes()],
  });
  assert.equal(result.code, 0);
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].body.data.attributes.phasedReleaseState, 'PAUSED');
  assert.equal(result.outputs['action-taken'], 'paused');
  assert.equal(result.outputs.reason, 'Unhealthy: crash-free rate 98.7% < minimum 99.5%');
  assert.equal(result.slack.length, 1);
  assert.match(result.slack[0].body.blocks[0].text.text, /Phased release paused/);
  assert.match(result.slack[0].body.blocks[0].text.text, /Unhealthy: crash-free rate 98.7%/);
});

test('guard above threshold reports healthy and does nothing', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'guard', 'INPUT_CRASH-FREE-RATE': '99.8', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ state: 'ACTIVE', day: 3 }),
    extraRoutes: slackRoutes(),
  });
  assert.equal(result.code, 0);
  assert.equal(result.patches.length, 0);
  assert.equal(result.deployments.length, 0);
  assert.equal(result.slack.length, 0);
  assert.equal(result.outputs['action-taken'], 'none');
  assert.match(result.outputs.reason, /^Healthy/);
});

test('guard healthy notifies only with notify-on-healthy', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'guard', 'INPUT_CRASH-FREE-RATE': '99.8', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL, 'INPUT_NOTIFY-ON-HEALTHY': 'true' },
    extraRoutes: slackRoutes(),
  });
  assert.equal(result.slack.length, 1);
  assert.match(result.slack[0].body.blocks[0].text.text, /Phased release healthy/);
});

test('guard with a custom threshold', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'guard', 'INPUT_CRASH-FREE-RATE': '99.2', 'INPUT_MIN-CRASH-FREE-RATE': '99' },
  });
  assert.equal(result.patches.length, 0);
  assert.equal(result.outputs['action-taken'], 'none');
});

test('guard below threshold on a PAUSED release is skipped', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'guard', 'INPUT_CRASH-FREE-RATE': '90' },
    routes: ascRoutes({ state: 'PAUSED', day: 2 }),
  });
  assert.equal(result.patches.length, 0);
  assert.equal(result.outputs['action-taken'], 'skipped');
});

test('guard without crash-free-rate fails before calling Apple', async () => {
  const result = await execute({ env: { 'INPUT_COMMAND': 'guard', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL }, extraRoutes: slackRoutes() });
  assert.equal(result.code, 1);
  assert.equal(result.calls.filter((call) => call.url.startsWith('https://api.appstoreconnect.apple.com')).length, 0);
  assert.ok(result.lines.some((line) => line.startsWith('::error::crash-free-rate is required')));
  assert.equal(result.slack.length, 1);
  assert.match(result.slack[0].body.blocks[0].text.text, /Phased release command failed/);
});

for (const command of ['pause', 'resume', 'complete']) {
  test(`dry-run ${command} never PATCHes`, async () => {
    const state = command === 'resume' ? 'PAUSED' : 'ACTIVE';
    const result = await execute({
      env: { 'INPUT_COMMAND': command, 'INPUT_DRY-RUN': 'true', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
      routes: ascRoutes({ state }),
      extraRoutes: [...githubRoutes(), ...slackRoutes()],
    });
    assert.equal(result.code, 0);
    assert.equal(result.patches.length, 0);
    assert.equal(result.deployments.length, 0);
    assert.equal(result.slack.length, 0);
    assert.equal(result.outputs['action-taken'], 'none');
    assert.equal(result.outputs.state, state);
    assert.match(result.outputs.reason, new RegExp(`^Dry run: would ${command} the phased release`));
  });
}

test('dry-run guard below threshold never PATCHes', async () => {
  const result = await execute({ env: { 'INPUT_COMMAND': 'guard', 'INPUT_DRY-RUN': 'true', 'INPUT_CRASH-FREE-RATE': '97' } });
  assert.equal(result.patches.length, 0);
  assert.match(result.outputs.reason, /^Dry run: would pause the phased release \(Unhealthy/);
});

test('deployment records the change with description and status', async () => {
  const result = await execute({ env: { 'INPUT_COMMAND': 'pause' }, routes: ascRoutes({ state: 'ACTIVE', day: 3 }), extraRoutes: githubRoutes() });
  const deployment = result.deployments[0];
  assert.equal(deployment.url, 'https://api.github.com/repos/octo/app/deployments');
  assert.equal(deployment.headers.Authorization, 'Bearer ghs_test');
  assert.equal(deployment.body.ref, 'abc123');
  assert.equal(deployment.body.environment, 'appstore-phased-release');
  assert.equal(deployment.body.description, '2.3.0 paused on day 3 (5%)');
  assert.equal(deployment.body.auto_merge, false);
  assert.deepEqual(deployment.body.required_contexts, []);
  assert.equal(deployment.body.payload.previousState, 'ACTIVE');
  assert.equal(deployment.body.payload.state, 'PAUSED');
  const status = result.statuses[0];
  assert.equal(status.url, 'https://api.github.com/repos/octo/app/deployments/42/statuses');
  assert.equal(status.body.state, 'success');
  assert.equal(status.body.description, '2.3.0 paused on day 3 (5%)');
  assert.equal(status.body.log_url, 'https://github.com/octo/app/actions/runs/1001');
});

test('deployment uses github-api-url and custom environment', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'resume', 'INPUT_GITHUB-API-URL': 'http://127.0.0.1:9999', 'INPUT_DEPLOYMENT-ENVIRONMENT': 'ios-production' },
    routes: ascRoutes({ state: 'PAUSED', day: 5 }),
    extraRoutes: githubRoutes({ apiUrl: 'http://127.0.0.1:9999' }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.deployments[0].body.environment, 'ios-production');
  assert.equal(result.deployments[0].body.description, '2.3.0 resumed on day 5 (20%)');
});

test('deployment failure only warns by default', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause' },
    extraRoutes: githubRoutes({ deploymentStatus: 403 }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.outputs['action-taken'], 'paused');
  assert.ok(result.lines.some((line) => line.startsWith('::warning::Could not record deployment history') && line.includes('HTTP 403')));
});

test('deployment network errors only warn by default', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause' },
    extraRoutes: [{ method: 'POST', match: (call) => call.path.endsWith('/deployments'), throws: new TypeError('fetch failed') }],
  });
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.includes('Could not record deployment history: fetch failed')));
});

test('missing github token only warns', async () => {
  const result = await execute({ env: { 'INPUT_COMMAND': 'pause', 'INPUT_GITHUB-TOKEN': '' } });
  assert.equal(result.code, 0);
  assert.equal(result.deployments.length, 0);
  assert.ok(result.lines.some((line) => line.includes('github-token is empty')));
});

test('deployment failure fails the run with require-history and notifies', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_REQUIRE-HISTORY': 'true', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    extraRoutes: [...githubRoutes({ statusStatus: 500 }), ...slackRoutes()],
  });
  assert.equal(result.code, 1);
  assert.equal(result.patches.length, 1);
  assert.match(result.outputs.reason, /Could not record deployment history.*already applied/);
  assert.equal(result.slack.length, 2);
  assert.match(result.slack[0].body.blocks[0].text.text, /Phased release paused/);
  assert.match(result.slack[1].body.blocks[0].text.text, /Phased release command failed/);
});

test('Slack payload includes app, version, state, day, percent and run URL', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ state: 'ACTIVE', day: 4 }),
    extraRoutes: [...githubRoutes(), ...slackRoutes()],
  });
  const payload = result.slack[0].body;
  assert.equal(result.slack[0].headers['Content-Type'], 'application/json');
  assert.equal(payload.text, ':double_vertical_bar: Phased release paused: Example App (com.example.app) 2.3.0');
  const text = payload.blocks[0].text.text;
  assert.match(text, /\*App:\* Example App \(com\.example\.app\)/);
  assert.match(text, /\*Version:\* 2\.3\.0/);
  assert.match(text, /\*State:\* PAUSED/);
  assert.match(text, /\*Day:\* 4/);
  assert.match(text, /\*Rollout:\* 10%/);
  assert.match(text, /<https:\/\/github\.com\/octo\/app\/actions\/runs\/1001\|View workflow run>/);
});

test('resume and complete send their own Slack headline', async () => {
  const resumed = await execute({
    env: { 'INPUT_COMMAND': 'resume', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ state: 'PAUSED' }),
    extraRoutes: [...githubRoutes(), ...slackRoutes()],
  });
  assert.match(resumed.slack[0].body.text, /Phased release resumed/);
  const completed = await execute({
    env: { 'INPUT_COMMAND': 'complete', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    extraRoutes: [...githubRoutes(), ...slackRoutes()],
  });
  assert.match(completed.slack[0].body.text, /Phased release completed/);
  assert.match(completed.slack[0].body.blocks[0].text.text, /\*Rollout:\* 100%/);
});

test('skipped commands notify only with notify-on-skip', async () => {
  const quiet = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ state: 'PAUSED' }),
    extraRoutes: slackRoutes(),
  });
  assert.equal(quiet.slack.length, 0);
  const loud = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL, 'INPUT_NOTIFY-ON-SKIP': 'true' },
    routes: ascRoutes({ state: 'PAUSED' }),
    extraRoutes: slackRoutes(),
  });
  assert.equal(loud.slack.length, 1);
  assert.match(loud.slack[0].body.blocks[0].text.text, /command skipped[\s\S]*already paused/);
});

test('status never notifies Slack', async () => {
  const result = await execute({ env: { 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL, 'INPUT_NOTIFY-ON-SKIP': 'true', 'INPUT_NOTIFY-ON-HEALTHY': 'true' }, extraRoutes: slackRoutes() });
  assert.equal(result.slack.length, 0);
});

test('Slack webhook failure only warns', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    extraRoutes: [...githubRoutes(), ...slackRoutes({ status: 500 })],
  });
  assert.equal(result.code, 0);
  assert.ok(result.lines.some((line) => line.startsWith('::warning::Slack notification failed')));
});

test('Apple errors fail the run, surface details and notify Slack', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ patchStatus: 409, patchBody: { errors: [{ status: '409', code: 'ENTITY_ERROR', title: 'Invalid', detail: 'Total pause duration exceeded.' }] } }),
    extraRoutes: slackRoutes(),
  });
  assert.equal(result.code, 1);
  assert.equal(result.deployments.length, 0);
  assert.ok(result.lines.some((line) => line === '::error::App Store Connect API PATCH /v1/appStoreVersionPhasedReleases/pr-230 failed with HTTP 409: Total pause duration exceeded.'));
  assert.match(result.outputs.reason, /Total pause duration exceeded/);
  assert.equal(result.slack.length, 1);
  const text = result.slack[0].body.blocks[0].text.text;
  assert.match(text, /Phased release command failed/);
  assert.match(text, /\*Version:\* 2\.3\.0/);
  assert.match(text, /Total pause duration exceeded/);
});

test('authentication errors are surfaced', async () => {
  const result = await execute({
    routes: [{ path: '/v1/apps/123456789', respond: { status: 401, body: { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.', detail: 'Provide a properly configured and signed bearer token, and make sure that it has not expired.' }] } } }],
  });
  assert.equal(result.code, 1);
  assert.match(result.outputs.reason, /HTTP 401: Provide a properly configured and signed bearer token/);
});

test('30 day pause warning is surfaced in log, summary and Slack', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'pause', 'INPUT_SLACK-WEBHOOK-URL': SLACK_URL },
    routes: ascRoutes({ state: 'ACTIVE', day: 4, totalPauseDuration: 27 }),
    extraRoutes: [...githubRoutes(), ...slackRoutes()],
  });
  assert.ok(result.lines.some((line) => line === '::warning::Phased release has been paused for 27 of the 30 days Apple allows; 3 day(s) left'));
  assert.match(result.summary, /\| Total pause days \| 27 \|/);
  assert.match(result.summary, /\| Warning \| Phased release has been paused for 27/);
  assert.match(result.slack[0].body.blocks[0].text.text, /\*Warning:\* Phased release has been paused for 27/);
});

test('no warning when pauses are well below the limit', async () => {
  const result = await execute({ routes: ascRoutes({ state: 'PAUSED', totalPauseDuration: 3 }) });
  assert.ok(!result.lines.some((line) => line.startsWith('::warning::')));
});

test('step summary contains a table of the run', async () => {
  const result = await execute({ env: { 'INPUT_COMMAND': 'pause' }, extraRoutes: githubRoutes() });
  assert.match(result.summary, /### App Store phased release/);
  assert.match(result.summary, /\| App \| Example App \(com\.example\.app\) \|/);
  assert.match(result.summary, /\| Version \| 2\.3\.0 \|/);
  assert.match(result.summary, /\| State \| PAUSED \|/);
  assert.match(result.summary, /\| Previous state \| ACTIVE \|/);
  assert.match(result.summary, /\| Rollout \| 5% \|/);
  assert.match(result.summary, /\| Action taken \| paused \|/);
});

test('no phased release is reported as skipped', async () => {
  const result = await execute({ env: { 'INPUT_COMMAND': 'pause' }, routes: ascRoutes({ phased: {} }) });
  assert.equal(result.code, 0);
  assert.equal(result.outputs['action-taken'], 'skipped');
  assert.equal(result.outputs.state, 'NONE');
  assert.equal(result.patches.length, 0);
});

test('a specific version input is honoured', async () => {
  const versions = [version('ver-221', '2.2.1', 'READY_FOR_SALE', '2026-09-20T00:00:00Z')];
  const phased = { 'ver-221': phasedRelease('pr-221', 'COMPLETE', 7) };
  const result = await execute({ env: { 'INPUT_VERSION': '2.2.1' }, routes: ascRoutes({ versions, phased }) });
  assert.equal(result.outputs.version, '2.2.1');
  assert.equal(result.outputs.state, 'COMPLETE');
  assert.equal(result.outputs.percentage, '100');
  const listCall = result.calls.find((call) => call.path.endsWith('/appStoreVersions'));
  assert.equal(listCall.query['filter[versionString]'], '2.2.1');
});

test('PATCH response values win over the previous state', async () => {
  const result = await execute({
    env: { 'INPUT_COMMAND': 'complete' },
    routes: ascRoutes({ state: 'ACTIVE', day: 2, patchedDay: null }),
    extraRoutes: githubRoutes(),
  });
  assert.equal(result.outputs.state, 'COMPLETE');
  assert.equal(result.outputs.day, '2');
  assert.equal(result.deployments[0].body.description, '2.3.0 completed on day 2 (100%)');
});
