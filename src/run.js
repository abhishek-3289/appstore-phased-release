import { readInputs, getInput } from './inputs.js';
import { createToken } from './jwt.js';
import { AppStoreConnectClient } from './appstore.js';
import { decide, percentageFor, pauseWarning, sortNewestFirst, describeChange } from './phased.js';
import { recordDeployment } from './github.js';
import { buildSlackPayload, sendSlack, shouldNotify } from './slack.js';
import { createIO } from './io.js';

const VERBS = { PAUSED: 'pause', ACTIVE: 'resume', COMPLETE: 'complete' };

export async function findPhasedRelease(client, appId, version) {
  const versions = await client.listVersions(appId, { version, limit: version ? 5 : 10 });
  if (version && versions.length === 0) {
    throw new Error(`Version ${version} was not found for app ${appId} on platform IOS`);
  }
  for (const candidate of sortNewestFirst(versions)) {
    const phasedRelease = await client.getPhasedRelease(candidate.id);
    if (phasedRelease) {
      return { version: candidate, phasedRelease };
    }
  }
  if (version) {
    throw new Error(`Version ${version} does not have a phased release configured`);
  }
  return null;
}

function merge(previous, updated, fallbackState) {
  const next = { ...previous, state: fallbackState };
  for (const [key, value] of Object.entries(updated || {})) {
    if (value !== null && value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function summaryTable(report) {
  const rows = [
    ['App', report.appLabel],
    ['Version', report.version],
    ['State', report.state],
    ['Previous state', report.previousState],
    ['Day', report.day],
    ['Rollout', report.percentage === '' ? '' : `${report.percentage}%`],
    ['Total pause days', report.totalPauseDuration],
    ['Command', report.command],
    ['Dry run', report.dryRun ? 'yes' : 'no'],
    ['Action taken', report.actionTaken],
    ['Reason', report.reason],
  ];
  if (report.warning) {
    rows.push(['Warning', report.warning]);
  }
  const body = rows.map(([name, value]) => `| ${name} | ${escapeCell(value)} |`).join('\n');
  return `### App Store phased release\n\n| | |\n|:--|:--|\n${body}\n`;
}

function appLabel(app) {
  if (!app) {
    return '';
  }
  const name = app.name || app.id;
  return app.bundleId ? `${name} (${app.bundleId})` : name;
}

async function notify({ io, fetch, url, kind, notifyOnHealthy, notifyOnSkip, details }) {
  if (!url || !shouldNotify({ kind, notifyOnHealthy, notifyOnSkip })) {
    return false;
  }
  try {
    await sendSlack({ fetch, url, payload: buildSlackPayload({ kind, ...details }) });
    return true;
  } catch (error) {
    io.warning(`Slack notification failed: ${error.message}`);
    return false;
  }
}

export async function run({ env = process.env, fetch = globalThis.fetch, now = () => Date.now(), io = createIO({ env }) } = {}) {
  let config = null;
  let app = null;
  let versionString = '';
  let state = '';
  let day = null;
  let percentage = null;
  try {
    config = readInputs(env);
    const token = createToken({ issuerId: config.issuerId, keyId: config.keyId, privateKey: config.privateKey, now: now() });
    io.mask(token);
    const client = new AppStoreConnectClient({ baseUrl: config.apiBaseUrl, token, fetch });

    app = config.appId ? await client.getApp(config.appId) : await client.findAppByBundleId(config.bundleId);
    io.info(`App: ${appLabel(app)} [${app.id}]`);

    const target = await findPhasedRelease(client, app.id, config.version);
    if (!target) {
      const reason = 'No iOS version in READY_FOR_SALE, PENDING_DEVELOPER_RELEASE or PROCESSING_FOR_APP_STORE has a phased release';
      io.warning(reason);
      const report = {
        appLabel: appLabel(app), version: '', state: 'NONE', previousState: 'NONE', day: '', percentage: '',
        totalPauseDuration: '', command: config.command, dryRun: config.dryRun, actionTaken: 'skipped', reason, warning: null,
      };
      writeOutputs(io, app, report);
      io.summary(summaryTable(report));
      if (!config.dryRun) {
        await notify({
          io, fetch, url: config.slackWebhookUrl, kind: 'skipped', notifyOnHealthy: config.notifyOnHealthy, notifyOnSkip: config.notifyOnSkip,
          details: { app, version: '', state: 'NONE', day: null, percentage: null, reason, runUrl: config.runUrl },
        });
      }
      return 0;
    }

    const { version, phasedRelease } = target;
    versionString = version.versionString;
    const previousState = phasedRelease.state;
    io.info(`Version ${versionString} (${version.appStoreState}): phased release ${previousState}, day ${phasedRelease.day ?? 'n/a'}`);

    const decision = decide({
      command: config.command,
      state: previousState,
      crashFreeRate: config.crashFreeRate,
      minCrashFreeRate: config.minCrashFreeRate,
    });

    let current = phasedRelease;
    let actionTaken = decision.outcome;
    let reason = decision.reason;
    let applied = false;
    if (decision.change && config.dryRun) {
      actionTaken = 'none';
      reason = `Dry run: would ${VERBS[decision.change]} the phased release (${decision.reason})`;
    } else if (decision.change) {
      const updated = await client.setPhasedReleaseState(phasedRelease.id, decision.change);
      current = merge(phasedRelease, updated, decision.change);
      applied = true;
    }

    state = current.state;
    day = current.day;
    percentage = percentageFor(state, day);
    const warning = pauseWarning(current.totalPauseDuration);
    if (warning) {
      io.warning(warning);
    }
    io.info(`${actionTaken}: ${reason}`);

    const report = {
      appLabel: appLabel(app), version: versionString, state, previousState, day: day ?? '', percentage,
      totalPauseDuration: current.totalPauseDuration ?? '', command: config.command, dryRun: config.dryRun, actionTaken, reason, warning,
    };
    writeOutputs(io, app, report);
    io.summary(summaryTable(report));

    const details = { app, version: versionString, state, day, percentage, reason, warning, runUrl: config.runUrl };
    let kind = null;
    if (applied) {
      kind = actionTaken;
    } else if (!config.dryRun && actionTaken === 'skipped') {
      kind = 'skipped';
    } else if (!config.dryRun && decision.healthy === true) {
      kind = 'guard-healthy';
    }
    if (kind) {
      await notify({ io, fetch, url: config.slackWebhookUrl, kind, notifyOnHealthy: config.notifyOnHealthy, notifyOnSkip: config.notifyOnSkip, details });
    }

    if (applied) {
      const description = describeChange({ version: versionString, outcome: actionTaken, day, percentage });
      try {
        const id = await recordDeployment({
          fetch,
          apiUrl: config.githubApiUrl,
          token: config.githubToken,
          repository: config.repository,
          ref: config.sha,
          environment: config.deploymentEnvironment,
          description,
          logUrl: config.runUrl,
          payload: {
            appId: app.id, bundleId: app.bundleId, version: versionString, command: config.command,
            previousState, state, day, percentage, reason,
          },
        });
        io.info(`Recorded deployment ${id} in environment ${config.deploymentEnvironment}: ${description}`);
      } catch (error) {
        const message = `Could not record deployment history: ${error.message}`;
        if (config.requireHistory) {
          throw new Error(`${message} (the phased release change was already applied)`);
        }
        io.warning(message);
      }
    }
    return 0;
  } catch (error) {
    io.error(error.message);
    io.setOutput('reason', error.message);
    const url = config?.slackWebhookUrl || getInput(env, 'slack-webhook-url');
    await notify({
      io, fetch, url, kind: 'failed',
      details: {
        app: app || { id: getInput(env, 'app-id'), bundleId: getInput(env, 'bundle-id') },
        version: versionString || getInput(env, 'version'),
        state, day, percentage, reason: error.message,
        runUrl: config?.runUrl || '',
      },
    });
    return 1;
  }
}

function writeOutputs(io, app, report) {
  io.setOutput('app-id', app.id);
  io.setOutput('version', report.version);
  io.setOutput('state', report.state);
  io.setOutput('day', report.day);
  io.setOutput('percentage', report.percentage);
  io.setOutput('previous-state', report.previousState);
  io.setOutput('action-taken', report.actionTaken);
  io.setOutput('reason', report.reason);
}
