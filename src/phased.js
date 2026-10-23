export const DAY_PERCENTAGES = { 1: 1, 2: 2, 3: 5, 4: 10, 5: 20, 6: 50, 7: 100 };
export const PAUSE_LIMIT_DAYS = 30;
export const PAUSE_WARNING_DAYS = 25;

const COMMAND_TARGETS = {
  pause: { from: ['ACTIVE'], to: 'PAUSED', outcome: 'paused' },
  resume: { from: ['PAUSED'], to: 'ACTIVE', outcome: 'resumed' },
  complete: { from: ['ACTIVE', 'PAUSED'], to: 'COMPLETE', outcome: 'completed' },
};

export function percentageFor(state, day) {
  if (state === 'COMPLETE') {
    return 100;
  }
  const number = Number(day);
  if (!Number.isInteger(number) || number < 1) {
    return 0;
  }
  if (number >= 7) {
    return 100;
  }
  return DAY_PERCENTAGES[number];
}

function skipReason(command, state) {
  if (state === 'INACTIVE') {
    return `Phased release has not started yet (INACTIVE); cannot ${command}`;
  }
  if (command === 'pause' && state === 'PAUSED') {
    return 'Phased release is already paused';
  }
  if (command === 'resume' && state === 'ACTIVE') {
    return 'Phased release is already active';
  }
  if (state === 'COMPLETE') {
    return `Phased release is already complete; cannot ${command}`;
  }
  return `Cannot ${command} a phased release in state ${state}`;
}

function formatRate(value) {
  return `${Number(value)}%`;
}

export function decide({ command, state, crashFreeRate = null, minCrashFreeRate = null }) {
  if (command === 'status') {
    return { change: null, outcome: 'none', reason: `Phased release is ${state}` };
  }

  if (command === 'guard') {
    const healthy = crashFreeRate >= minCrashFreeRate;
    const comparison = `crash-free rate ${formatRate(crashFreeRate)} ${healthy ? '>=' : '<'} minimum ${formatRate(minCrashFreeRate)}`;
    if (healthy) {
      const suffix = state === 'PAUSED' ? '; phased release stays PAUSED (guard never resumes)' : '';
      return { change: null, outcome: 'none', healthy: true, reason: `Healthy: ${comparison}${suffix}` };
    }
    if (state === 'ACTIVE') {
      return { change: 'PAUSED', outcome: 'paused', healthy: false, reason: `Unhealthy: ${comparison}` };
    }
    const why = skipReason('pause', state);
    return { change: null, outcome: 'skipped', healthy: false, reason: `Unhealthy: ${comparison}, but ${why.charAt(0).toLowerCase()}${why.slice(1)}` };
  }

  const target = COMMAND_TARGETS[command];
  if (!target) {
    throw new Error(`Unknown command '${command}'`);
  }
  if (target.from.includes(state)) {
    return { change: target.to, outcome: target.outcome, reason: `${command} requested while ${state}` };
  }
  return { change: null, outcome: 'skipped', reason: skipReason(command, state) };
}

export function pauseWarning(totalPauseDuration) {
  const days = Number(totalPauseDuration);
  if (!Number.isFinite(days) || days < PAUSE_WARNING_DAYS) {
    return null;
  }
  if (days >= PAUSE_LIMIT_DAYS) {
    return `Phased release has been paused for ${days} days in total; Apple allows at most ${PAUSE_LIMIT_DAYS} days of pauses`;
  }
  return `Phased release has been paused for ${days} of the ${PAUSE_LIMIT_DAYS} days Apple allows; ${PAUSE_LIMIT_DAYS - days} day(s) left`;
}

export function compareVersionStrings(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function sortNewestFirst(versions) {
  return [...versions].sort((a, b) => {
    if (a.createdDate && b.createdDate && a.createdDate !== b.createdDate) {
      return Date.parse(b.createdDate) - Date.parse(a.createdDate);
    }
    return compareVersionStrings(b.versionString, a.versionString);
  });
}

export function describeChange({ version, outcome, day, percentage }) {
  const dayText = day ? ` on day ${day}` : '';
  return `${version} ${outcome}${dayText} (${percentage}%)`;
}
