import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey,
  };
}

export const KEYS = generateKeys();

export function jsonResponse(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createFetchStub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    const call = {
      method,
      url,
      origin: parsed.origin,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find((candidate) => {
      if ((candidate.method || 'GET') !== method) {
        return false;
      }
      if (candidate.url && candidate.url !== `${parsed.origin}${parsed.pathname}`) {
        return false;
      }
      if (candidate.path && candidate.path !== parsed.pathname) {
        return false;
      }
      if (candidate.match && !candidate.match(call)) {
        return false;
      }
      return true;
    });
    if (!route) {
      throw new Error(`Unexpected request ${method} ${url}`);
    }
    if (route.throws) {
      throw route.throws;
    }
    const response = typeof route.respond === 'function' ? route.respond(call) : route.respond;
    return jsonResponse(response.status, response.body);
  };
  return { fetch, calls };
}

export const APP = { id: '123456789', name: 'Example App', bundleId: 'com.example.app' };

export function version(id, versionString, appStoreState, createdDate) {
  return { type: 'appStoreVersions', id, attributes: { versionString, appStoreState, createdDate, platform: 'IOS' } };
}

export function phasedRelease(id, phasedReleaseState, currentDayNumber, totalPauseDuration = 0) {
  return {
    type: 'appStoreVersionPhasedReleases',
    id,
    attributes: { phasedReleaseState, currentDayNumber, startDate: '2026-10-20T00:00:00Z', totalPauseDuration },
  };
}

export function ascRoutes({
  state = 'ACTIVE',
  day = 3,
  totalPauseDuration = 0,
  patchedState = null,
  patchedDay,
  versions = [version('ver-230', '2.3.0', 'READY_FOR_SALE', '2026-10-18T10:00:00Z')],
  phased = { 'ver-230': phasedRelease('pr-230', state, day, totalPauseDuration) },
  patchStatus = 200,
  patchBody,
} = {}) {
  return [
    { path: `/v1/apps/${APP.id}`, respond: { status: 200, body: { data: { type: 'apps', id: APP.id, attributes: { name: APP.name, bundleId: APP.bundleId } } } } },
    { path: '/v1/apps', respond: { status: 200, body: { data: [{ type: 'apps', id: APP.id, attributes: { name: APP.name, bundleId: APP.bundleId } }] } } },
    { path: `/v1/apps/${APP.id}/appStoreVersions`, respond: { status: 200, body: { data: versions } } },
    {
      match: (call) => /^\/v1\/appStoreVersions\/[^/]+\/appStoreVersionPhasedRelease$/.test(call.path),
      respond: (call) => {
        const id = call.path.split('/')[3];
        return phased[id] ? { status: 200, body: { data: phased[id] } } : { status: 200, body: { data: null } };
      },
    },
    {
      method: 'PATCH',
      match: (call) => call.path.startsWith('/v1/appStoreVersionPhasedReleases/'),
      respond: (call) => {
        if (patchBody) {
          return { status: patchStatus, body: patchBody };
        }
        const target = call.body.data.attributes.phasedReleaseState;
        return {
          status: patchStatus,
          body: { data: phasedRelease(call.body.data.id, patchedState || target, patchedDay === undefined ? day : patchedDay, totalPauseDuration) },
        };
      },
    },
  ];
}

export function githubRoutes({ deploymentStatus = 201, statusStatus = 201, apiUrl = 'https://api.github.com' } = {}) {
  return [
    {
      method: 'POST',
      url: `${apiUrl}/repos/octo/app/deployments`,
      respond: { status: deploymentStatus, body: deploymentStatus < 300 ? { id: 42 } : { message: 'Resource not accessible by integration' } },
    },
    {
      method: 'POST',
      url: `${apiUrl}/repos/octo/app/deployments/42/statuses`,
      respond: { status: statusStatus, body: { id: 7 } },
    },
  ];
}

export function slackRoutes({ status = 200 } = {}) {
  return [{ method: 'POST', url: 'https://hooks.slack.test/services/T/B/X', respond: { status, body: status < 300 ? undefined : { error: 'invalid_token' } } }];
}

export const SLACK_URL = 'https://hooks.slack.test/services/T/B/X';

export function baseEnv(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phased-release-'));
  const outputFile = join(dir, 'output');
  const summaryFile = join(dir, 'summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const env = {
    'INPUT_COMMAND': 'status',
    'INPUT_ISSUER-ID': '69a6de70-0000-47e3-e053-5b8c7c11a4d1',
    'INPUT_KEY-ID': 'ABC123DEFG',
    'INPUT_PRIVATE-KEY': KEYS.privatePem,
    'INPUT_APP-ID': APP.id,
    'INPUT_BUNDLE-ID': '',
    'INPUT_VERSION': '',
    'INPUT_CRASH-FREE-RATE': '',
    'INPUT_MIN-CRASH-FREE-RATE': '99.5',
    'INPUT_DRY-RUN': 'false',
    'INPUT_GITHUB-TOKEN': 'ghs_test',
    'INPUT_DEPLOYMENT-ENVIRONMENT': 'appstore-phased-release',
    'INPUT_REQUIRE-HISTORY': 'false',
    'INPUT_SLACK-WEBHOOK-URL': '',
    'INPUT_NOTIFY-ON-HEALTHY': 'false',
    'INPUT_NOTIFY-ON-SKIP': 'false',
    'INPUT_API-BASE-URL': 'https://api.appstoreconnect.apple.com',
    'INPUT_GITHUB-API-URL': '',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'octo/app',
    GITHUB_RUN_ID: '1001',
    GITHUB_SHA: 'abc123',
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    ...overrides,
  };
  return env;
}

export function readOutputs(env) {
  const outputs = {};
  const lines = readFileSync(env.GITHUB_OUTPUT, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const collected = [];
      index += 1;
      while (index < lines.length && lines[index] !== heredoc[2]) {
        collected.push(lines[index]);
        index += 1;
      }
      outputs[heredoc[1]] = collected.join('\n');
    } else if (line.includes('=')) {
      const separator = line.indexOf('=');
      outputs[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return outputs;
}

export function readSummary(env) {
  return readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
}

export function captureIO() {
  const lines = [];
  return {
    lines,
    write: (text) => {
      lines.push(...text.split('\n').filter(Boolean));
    },
  };
}
