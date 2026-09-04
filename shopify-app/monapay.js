import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class MonaPayApiError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'MonaPayApiError';
    this.status = status;
    this.body = body;
  }
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
}

function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyMonaWebhook(rawBody, headers, secret, {
  now = () => Math.floor(Date.now() / 1_000),
  toleranceSec = 300,
} = {}) {
  const timestampText = String(headerValue(headers, 'x-mona-timestamp') || '');
  const signatureText = String(headerValue(headers, 'x-mona-signature') || '');
  if (!/^\d+$/.test(timestampText)) return { ok: false, reason: 'invalid_timestamp' };
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now() - timestamp) > toleranceSec) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const match = /^(?:sha256=)?([a-f0-9]{64})$/i.exec(signatureText);
  if (!match) return { ok: false, reason: 'invalid_signature' };
  const expected = createHmac('sha256', secret)
    .update(`${timestampText}.`, 'utf8')
    .update(rawBody)
    .digest();
  const received = Buffer.from(match[1], 'hex');
  if (!equalBytes(expected, received)) return { ok: false, reason: 'invalid_signature' };
  try {
    return { ok: true, payload: JSON.parse(Buffer.from(rawBody).toString('utf8')) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

function unwrap(json) {
  if (json && typeof json === 'object' && Object.hasOwn(json, 'data')) return json.data;
  return json;
}

export class MonaPayClient {
  constructor({ baseUrl, clientId, clientSecret, fetch = globalThis.fetch, timeoutMs = 5_000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.loginPromise = null;
  }

  async request(method, path, { body, headers = {}, authenticated = true, retry = true } = {}) {
    if (authenticated) await this.ensureToken();
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (authenticated) requestHeaders.Authorization = `Bearer ${this.token}`;
    if (authenticated && method !== 'GET') requestHeaders['X-Client-Secret'] = this.clientSecret;
    let requestBody;
    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        signal: controller.signal,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });
    } catch (cause) {
      const message = cause?.name === 'AbortError'
        ? `MONA Pay timeout sau ${this.timeoutMs}ms`
        : 'Không gọi được MONA Pay';
      throw new MonaPayApiError(message, { cause });
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();
    let json = null;
    try {
      json = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new MonaPayApiError(`MONA Pay trả dữ liệu không phải JSON (HTTP ${response.status})`, {
        status: response.status,
      });
    }
    if (response.status === 401 && authenticated && retry) {
      this.token = null;
      this.tokenExpiresAt = 0;
      return this.request(method, path, { body, headers, authenticated, retry: false });
    }
    if (!response.ok || json?.success === false) {
      throw new MonaPayApiError(
        json?.message || (typeof json?.detail === 'string' ? json.detail : null) || `MONA Pay lỗi HTTP ${response.status}`,
        { status: response.status, body: json },
      );
    }
    return unwrap(json);
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const token = await this.request('POST', '/api/v1/oauth/token', {
        authenticated: false,
        body: {
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        },
      });
      if (!token?.access_token) throw new MonaPayApiError('MONA Pay không trả access_token');
      this.token = token.access_token;
      this.tokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in || 3600) - 60) * 1_000;
      return this.token;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async ensureToken() {
    if (!this.token || Date.now() >= this.tokenExpiresAt) await this.login();
  }

  me() {
    return this.request('GET', '/api/v1/client/me');
  }

  createCheckout(body, idempotencyKey) {
    return this.request('POST', '/api/v1/checkouts', {
      body,
      headers: { 'Idempotency-Key': idempotencyKey || randomUUID() },
    });
  }

  createWebhook(body) {
    return this.request('POST', '/api/v1/client-webhooks', { body });
  }

  updateWebhook(id, body) {
    return this.request('PUT', `/api/v1/client-webhooks/${encodeURIComponent(id)}`, { body });
  }
}
