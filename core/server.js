import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { createPlatformAdapter } from './adapters.js';
import { loadConfig } from './config.js';
import { IdempotencyCache } from './idempotency.js';
import { createLogger } from './logger.js';
import { createWebhookProcessor } from './processor.js';

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
}

async function readRawBody(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error('Request body quá lớn');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createRequestHandler({ processor, bodyLimitBytes = 1_048_576 } = {}) {
  return async function requestHandler(request, response) {
    const url = new URL(request.url, 'http://connector.local');

    if (url.pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'cache-control': 'no-store' });
        response.end();
      } else {
        sendJson(response, 200, { status: 'ok' });
      }
      return;
    }

    if (url.pathname !== '/webhooks/monapay') {
      sendJson(response, 404, { success: false, message: 'Not found' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendJson(response, 405, { success: false, message: 'Method not allowed' });
      return;
    }

    try {
      const rawBody = await readRawBody(request, bodyLimitBytes);
      const result = await processor({ rawBody, headers: request.headers });
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(response, error.status || 500, {
        success: false,
        message: error.status === 413 ? error.message : 'Internal server error',
      });
    }
  };
}

export function createConnectorServer({ env = process.env, fetch = globalThis.fetch, logger = createLogger() } = {}) {
  const config = loadConfig(env);
  const adapter = createPlatformAdapter(config.platform, {
    env,
    fetch,
    timeoutMs: config.timeoutMs,
  });
  const processor = createWebhookProcessor({
    secret: config.secret,
    adapter,
    orderIdPattern: config.orderIdPattern,
    retryDelayMs: config.retryDelayMs,
    logger,
    idempotency: new IdempotencyCache({
      ttlMs: config.idempotencyTtlMs,
      maxEntries: config.idempotencyMaxEntries,
    }),
  });
  const server = http.createServer(createRequestHandler({
    processor,
    bodyLimitBytes: config.bodyLimitBytes,
  }));
  return { server, config, logger };
}

export function start(options = {}) {
  const { server, config, logger } = createConnectorServer(options);
  server.listen(config.port, config.host, () => {
    logger.info('connector_started', {
      platform: config.platform,
      host: config.host,
      port: config.port,
    });
  });
  const shutdown = (signal) => {
    logger.info('connector_stopping', { signal });
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    start();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'startup_failed', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
