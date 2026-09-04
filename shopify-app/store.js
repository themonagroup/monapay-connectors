import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function emptyData() {
  return { version: 1, shops: {}, orders: {}, webhooks: {}, transactions: {} };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class SecretBox {
  constructor(secret) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new Error('APP_SECRET_KEY phải có ít nhất 32 ký tự');
    }
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  encrypt(value) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Không thể mã hóa secret rỗng');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(envelope) {
    const [version, ivText, tagText, encryptedText, ...extra] = String(envelope || '').split('.');
    if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra.length) {
      throw new Error('Secret đã mã hóa không đúng định dạng');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function normalizeData(input) {
  const data = input && typeof input === 'object' ? input : emptyData();
  data.version ||= 1;
  data.shops ||= {};
  data.orders ||= {};
  data.webhooks ||= {};
  data.transactions ||= {};
  return data;
}

export class JsonStore {
  constructor(dataDir, { secretKey, lockTimeoutMs = 2_000, staleLockMs = 30_000 } = {}) {
    this.dataDir = resolve(dataDir);
    this.file = join(this.dataDir, 'store.json');
    this.lockFile = join(this.dataDir, '.store.lock');
    this.box = new SecretBox(secretKey);
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      return normalizeData(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyData();
      throw error;
    }
  }

  async acquireLock() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    for (;;) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(`${process.pid} ${Date.now()}\n`);
        return handle;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const lockStat = await stat(this.lockFile);
          if (Date.now() - lockStat.mtimeMs > this.staleLockMs) {
            await unlink(this.lockFile);
            continue;
          }
        } catch (lockError) {
          if (lockError.code === 'ENOENT') continue;
          throw lockError;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          const timeoutError = new Error('Data store đang bị khóa quá lâu');
          timeoutError.status = 503;
          throw timeoutError;
        }
        await delay(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  async persist(data) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = join(this.dataDir, `.store.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async mutate(operation) {
    const queued = this.writeQueue.then(async () => {
      const lock = await this.acquireLock();
      try {
        const data = await this.read();
        const result = await operation(data);
        await this.persist(data);
        return clone(result);
      } finally {
        await lock.close().catch(() => {});
        await unlink(this.lockFile).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  decodeShop(record) {
    if (!record) return null;
    const decoded = clone(record);
    if (decoded.accessTokenEnc) {
      decoded.accessToken = this.box.decrypt(decoded.accessTokenEnc);
      delete decoded.accessTokenEnc;
    }
    if (decoded.merchant?.clientSecretEnc) {
      decoded.merchant.clientSecret = this.box.decrypt(decoded.merchant.clientSecretEnc);
      delete decoded.merchant.clientSecretEnc;
    }
    if (decoded.merchant?.webhookSecretEnc) {
      decoded.merchant.webhookSecret = this.box.decrypt(decoded.merchant.webhookSecretEnc);
      delete decoded.merchant.webhookSecretEnc;
    }
    return decoded;
  }

  async saveShop(shop, record) {
    const saved = await this.mutate((data) => {
      const current = data.shops[shop] || {};
      const next = { ...current, ...clone(record) };
      if (Object.hasOwn(record, 'accessToken')) {
        next.accessTokenEnc = this.box.encrypt(record.accessToken);
        delete next.accessToken;
      }
      if (record.merchant) {
        next.merchant = { ...(current.merchant || {}), ...clone(record.merchant) };
        if (Object.hasOwn(record.merchant, 'clientSecret')) {
          next.merchant.clientSecretEnc = this.box.encrypt(record.merchant.clientSecret);
          delete next.merchant.clientSecret;
        }
        if (Object.hasOwn(record.merchant, 'webhookSecret')) {
          next.merchant.webhookSecretEnc = this.box.encrypt(record.merchant.webhookSecret);
          delete next.merchant.webhookSecret;
        }
      }
      next.updatedAt = new Date().toISOString();
      data.shops[shop] = next;
      return next;
    });
    return this.decodeShop(saved);
  }

  async getShop(shop) {
    const data = await this.read();
    return this.decodeShop(data.shops[shop]);
  }

  async getOrder(shop, orderId) {
    const data = await this.read();
    return clone(data.orders[`${shop}:${orderId}`] || null);
  }

  async saveOrder(shop, orderId, record) {
    return this.mutate((data) => {
      const key = `${shop}:${orderId}`;
      data.orders[key] ||= clone(record);
      return data.orders[key];
    });
  }

  async updateOrder(shop, orderId, patch) {
    return this.mutate((data) => {
      const key = `${shop}:${orderId}`;
      if (!data.orders[key]) return null;
      data.orders[key] = { ...data.orders[key], ...clone(patch), updatedAt: new Date().toISOString() };
      return data.orders[key];
    });
  }

  async hasWebhook(shop, webhookId) {
    const data = await this.read();
    return Boolean(data.webhooks[`${shop}:${webhookId}`]);
  }

  async markWebhook({ shop, webhookId, orderId, status = 'processed' }) {
    return this.mutate((data) => {
      data.webhooks[`${shop}:${webhookId}`] = {
        shop,
        orderId: orderId == null ? null : String(orderId),
        status,
        processedAt: new Date().toISOString(),
      };
      return data.webhooks[`${shop}:${webhookId}`];
    });
  }

  async findOrderForMona(payload) {
    const data = await this.read();
    const hintedShop = String(payload?.metadata?.shop || '').toLowerCase();
    const hintedOrderId = String(payload?.metadata?.order_id || '');
    if (hintedShop && hintedOrderId) {
      const exact = data.orders[`${hintedShop}:${hintedOrderId}`];
      if (exact) return clone(exact);
    }
    return clone(Object.values(data.orders).find((order) => (
      (payload?.checkout_id && order.checkoutId === String(payload.checkout_id))
      || (payload?.order_code && order.orderCode === String(payload.order_code))
    )) || null);
  }

  async hasTransaction(shop, transactionCode) {
    const data = await this.read();
    return Boolean(data.transactions[`${shop}:${transactionCode}`]);
  }

  async markPaid({ shop, orderId, transactionCode, payload }) {
    return this.mutate((data) => {
      const orderKey = `${shop}:${orderId}`;
      if (!data.orders[orderKey]) throw new Error('Không tìm thấy order trong data store');
      data.transactions[`${shop}:${transactionCode}`] ||= {
        shop,
        orderId: String(orderId),
        transactionCode,
        checkoutId: String(payload.checkout_id),
        paidAmount: Number(payload.paid_amount),
        processedAt: new Date().toISOString(),
      };
      data.orders[orderKey] = {
        ...data.orders[orderKey],
        status: 'paid',
        tags: ['monapay-paid'],
        transactionCode,
        paidAmount: Number(payload.paid_amount),
        paidAt: payload.paid_at || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return data.orders[orderKey];
    });
  }

  async deleteShop(shop) {
    return this.mutate((data) => {
      delete data.shops[shop];
      for (const key of Object.keys(data.orders)) if (key.startsWith(`${shop}:`)) delete data.orders[key];
      for (const key of Object.keys(data.webhooks)) if (key.startsWith(`${shop}:`)) delete data.webhooks[key];
      for (const key of Object.keys(data.transactions)) if (key.startsWith(`${shop}:`)) delete data.transactions[key];
      return true;
    });
  }
}
