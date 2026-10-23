export const LIVE_STATES = ['READY_FOR_SALE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_APP_STORE'];

export class AppStoreApiError extends Error {
  constructor(method, path, status, details) {
    const suffix = details.length > 0 ? `: ${details.join('; ')}` : '';
    super(`App Store Connect API ${method} ${path} failed with HTTP ${status}${suffix}`);
    this.name = 'AppStoreApiError';
    this.status = status;
    this.details = details;
  }
}

export function errorDetails(body) {
  if (!body || !Array.isArray(body.errors)) {
    return [];
  }
  return body.errors
    .map((error) => error.detail || error.title || error.code)
    .filter(Boolean);
}

function toPhasedRelease(data) {
  if (!data) {
    return null;
  }
  const attributes = data.attributes || {};
  return {
    id: data.id,
    state: attributes.phasedReleaseState || null,
    day: attributes.currentDayNumber ?? null,
    startDate: attributes.startDate || null,
    totalPauseDuration: attributes.totalPauseDuration ?? null,
  };
}

function toVersion(data) {
  const attributes = data.attributes || {};
  return {
    id: data.id,
    versionString: attributes.versionString || '',
    appStoreState: attributes.appStoreState || attributes.appVersionState || '',
    createdDate: attributes.createdDate || '',
  };
}

function toApp(data) {
  const attributes = data.attributes || {};
  return {
    id: data.id,
    name: attributes.name || '',
    bundleId: attributes.bundleId || '',
  };
}

export class AppStoreConnectClient {
  constructor({ baseUrl, token, fetch, timeoutMs = 30000 }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query, body, allowNotFound = false } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query || {})) {
      url.searchParams.set(name, value);
    }
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    const init = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await this.fetch(url.toString(), init);
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new AppStoreApiError(method, path, response.status, errorDetails(json));
    }
    return json;
  }

  async getApp(appId) {
    const json = await this.request('GET', `/v1/apps/${encodeURIComponent(appId)}`);
    return toApp(json.data);
  }

  async findAppByBundleId(bundleId) {
    const json = await this.request('GET', '/v1/apps', { query: { 'filter[bundleId]': bundleId, limit: '10' } });
    const match = (json?.data || []).map(toApp).find((app) => app.bundleId === bundleId);
    if (!match) {
      throw new Error(`No app with bundle ID '${bundleId}' is visible to this API key`);
    }
    return match;
  }

  async listVersions(appId, { version = '', limit = 10 } = {}) {
    const query = { 'filter[platform]': 'IOS', limit: String(limit) };
    if (version) {
      query['filter[versionString]'] = version;
    } else {
      query['filter[appStoreState]'] = LIVE_STATES.join(',');
    }
    const json = await this.request('GET', `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions`, { query });
    return (json?.data || []).map(toVersion);
  }

  async getPhasedRelease(versionId) {
    const json = await this.request(
      'GET',
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionPhasedRelease`,
      { allowNotFound: true },
    );
    return toPhasedRelease(json?.data);
  }

  async setPhasedReleaseState(phasedReleaseId, state) {
    const json = await this.request('PATCH', `/v1/appStoreVersionPhasedReleases/${encodeURIComponent(phasedReleaseId)}`, {
      body: {
        data: {
          type: 'appStoreVersionPhasedReleases',
          id: phasedReleaseId,
          attributes: { phasedReleaseState: state },
        },
      },
    });
    return toPhasedRelease(json?.data);
  }
}
