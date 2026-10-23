const HEADLINES = {
  paused: ':double_vertical_bar: Phased release paused',
  resumed: ':arrow_forward: Phased release resumed',
  completed: ':white_check_mark: Phased release completed, released to all users',
  'guard-healthy': ':large_green_circle: Phased release healthy',
  skipped: ':fast_forward: Phased release command skipped',
  failed: ':x: Phased release command failed',
};

export const NOTIFICATION_KINDS = Object.keys(HEADLINES);

export function shouldNotify({ kind, notifyOnHealthy = false, notifyOnSkip = false }) {
  if (kind === 'guard-healthy') {
    return notifyOnHealthy;
  }
  if (kind === 'skipped') {
    return notifyOnSkip;
  }
  return NOTIFICATION_KINDS.includes(kind);
}

export function buildSlackPayload({ kind, app, version, state, day, percentage, reason, warning, runUrl }) {
  const headline = HEADLINES[kind] || `Phased release: ${kind}`;
  const appLabel = app?.name ? `${app.name}${app.bundleId ? ` (${app.bundleId})` : ''}` : app?.bundleId || app?.id || 'unknown app';
  const fields = [
    `*App:* ${appLabel}`,
    `*Version:* ${version || 'unknown'}`,
    `*State:* ${state || 'unknown'}`,
    `*Day:* ${day ?? 'n/a'}`,
    `*Rollout:* ${percentage ?? 'n/a'}%`,
  ];
  const lines = [`*${headline}*`, fields.join('  |  ')];
  if (reason) {
    lines.push(`*Reason:* ${reason}`);
  }
  if (warning) {
    lines.push(`*Warning:* ${warning}`);
  }
  if (runUrl) {
    lines.push(`<${runUrl}|View workflow run>`);
  }
  const text = `${headline}: ${appLabel} ${version || ''}`.trim();
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  };
}

export async function sendSlack({ fetch, url, payload }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Slack webhook returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }
}
