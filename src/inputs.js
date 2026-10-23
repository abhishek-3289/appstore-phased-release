export const COMMANDS = ['status', 'pause', 'resume', 'complete', 'guard'];

export const DEFAULT_API_BASE_URL = 'https://api.appstoreconnect.apple.com';
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_ENVIRONMENT = 'appstore-phased-release';
export const DEFAULT_MIN_CRASH_FREE_RATE = 99.5;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

export function getInput(env, name, defaultValue = '') {
  const value = env[`INPUT_${name.toUpperCase()}`];
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  return value.trim();
}

export function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false' || normalized === '') {
    return false;
  }
  throw new InputError(`${name} must be 'true' or 'false', got '${value}'`);
}

export function parsePercent(value, name) {
  const cleaned = String(value).trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new InputError(`${name} must be a number between 0 and 100, got '${value}'`);
  }
  const number = Number(cleaned);
  if (number < 0 || number > 100) {
    throw new InputError(`${name} must be between 0 and 100, got '${value}'`);
  }
  return number;
}

export function normalizePrivateKey(value) {
  if (!value.includes('\n') && value.includes('\\n')) {
    return value.replace(/\\n/g, '\n');
  }
  return value;
}

function trimTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

export function runUrl(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) {
    return '';
  }
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

export function readInputs(env) {
  const command = getInput(env, 'command', 'status').toLowerCase();
  if (!COMMANDS.includes(command)) {
    throw new InputError(`command must be one of ${COMMANDS.join(', ')}, got '${command}'`);
  }

  const issuerId = getInput(env, 'issuer-id');
  const keyId = getInput(env, 'key-id');
  const privateKey = normalizePrivateKey(getInput(env, 'private-key'));
  const missing = [
    ['issuer-id', issuerId],
    ['key-id', keyId],
    ['private-key', privateKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new InputError(`Missing required input(s): ${missing.join(', ')}`);
  }

  const appId = getInput(env, 'app-id');
  const bundleId = getInput(env, 'bundle-id');
  if (!appId && !bundleId) {
    throw new InputError('Either app-id or bundle-id must be provided');
  }
  if (appId && !/^\d+$/.test(appId)) {
    throw new InputError(`app-id must be the numeric Apple ID of the app, got '${appId}'`);
  }

  const rawCrashFreeRate = getInput(env, 'crash-free-rate');
  let crashFreeRate = null;
  if (command === 'guard' && !rawCrashFreeRate) {
    throw new InputError('crash-free-rate is required for command guard (Apple does not expose crash rates through the App Store Connect API)');
  }
  if (rawCrashFreeRate) {
    crashFreeRate = parsePercent(rawCrashFreeRate, 'crash-free-rate');
  }
  const minCrashFreeRate = parsePercent(
    getInput(env, 'min-crash-free-rate', String(DEFAULT_MIN_CRASH_FREE_RATE)),
    'min-crash-free-rate',
  );

  return {
    command,
    dryRun: parseBoolean(getInput(env, 'dry-run', 'false'), 'dry-run'),
    issuerId,
    keyId,
    privateKey,
    appId,
    bundleId,
    version: getInput(env, 'version'),
    crashFreeRate,
    minCrashFreeRate,
    githubToken: getInput(env, 'github-token'),
    deploymentEnvironment: getInput(env, 'deployment-environment', DEFAULT_ENVIRONMENT),
    requireHistory: parseBoolean(getInput(env, 'require-history', 'false'), 'require-history'),
    slackWebhookUrl: getInput(env, 'slack-webhook-url'),
    notifyOnHealthy: parseBoolean(getInput(env, 'notify-on-healthy', 'false'), 'notify-on-healthy'),
    notifyOnSkip: parseBoolean(getInput(env, 'notify-on-skip', 'false'), 'notify-on-skip'),
    apiBaseUrl: trimTrailingSlash(getInput(env, 'api-base-url', DEFAULT_API_BASE_URL)),
    githubApiUrl: trimTrailingSlash(getInput(env, 'github-api-url', env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL)),
    repository: env.GITHUB_REPOSITORY || '',
    sha: env.GITHUB_SHA || '',
    runUrl: runUrl(env),
  };
}
