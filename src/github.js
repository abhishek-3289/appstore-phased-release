const DESCRIPTION_LIMIT = 140;

function truncate(text, limit = DESCRIPTION_LIMIT) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

async function githubRequest({ fetch, apiUrl, token, method, path, body }) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = json?.message ? `: ${json.message}` : '';
    throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}${message}`);
  }
  return json;
}

export async function recordDeployment({ fetch, apiUrl, token, repository, ref, environment, description, payload, logUrl }) {
  if (!token) {
    throw new Error('github-token is empty');
  }
  if (!repository || !ref) {
    throw new Error('GITHUB_REPOSITORY or GITHUB_SHA is not set');
  }
  const text = truncate(description);
  const deployment = await githubRequest({
    fetch,
    apiUrl,
    token,
    method: 'POST',
    path: `/repos/${repository}/deployments`,
    body: {
      ref,
      environment,
      description: text,
      task: 'deploy:phased-release',
      auto_merge: false,
      required_contexts: [],
      production_environment: true,
      transient_environment: false,
      payload,
    },
  });
  if (!deployment?.id) {
    throw new Error('GitHub did not return a deployment id');
  }
  const status = { state: 'success', description: text, environment };
  if (logUrl) {
    status.log_url = logUrl;
  }
  await githubRequest({
    fetch,
    apiUrl,
    token,
    method: 'POST',
    path: `/repos/${repository}/deployments/${deployment.id}/statuses`,
    body: status,
  });
  return deployment.id;
}
