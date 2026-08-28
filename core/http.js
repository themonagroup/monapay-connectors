export class PlatformApiError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message, { cause });
    this.name = 'PlatformApiError';
    this.status = status;
    this.body = body;
  }
}

export function required(env, key) {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`Thiếu biến môi trường ${key}`);
  }
  return String(value).trim();
}

export function safeBaseUrl(value, key) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} phải là URL hợp lệ`);
  }
  const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`${key} phải dùng HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${key} không được chứa credentials`);
  return url.toString().replace(/\/$/, '');
}

export async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_500,
  headers,
  ...init
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Node.js 18+ với fetch built-in là bắt buộc');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new PlatformApiError(`API nền tảng trả HTTP ${response.status}`, {
        status: response.status,
        body,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof PlatformApiError) throw error;
    const message = error?.name === 'AbortError' ? `API nền tảng timeout sau ${timeoutMs}ms` : 'Không gọi được API nền tảng';
    throw new PlatformApiError(message, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
