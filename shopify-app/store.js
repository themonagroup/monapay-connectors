import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const EMPTY = { shops: {}, orders: {}, webhooks: {} };

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = structuredClone(EMPTY);
    }
    this.data.shops ||= {};
    this.data.orders ||= {};
    this.data.webhooks ||= {};
    return this.data;
  }

  async persist() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async mutate(operation) {
    const queued = this.writeQueue.then(async () => {
      await this.load();
      const result = await operation(this.data);
      await this.persist();
      return result;
    });
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  async saveShop(shop, record) {
    return this.mutate((data) => {
      data.shops[shop] = { ...record, updatedAt: new Date().toISOString() };
      return data.shops[shop];
    });
  }

  async getShop(shop) {
    const data = await this.load();
    return data.shops[shop] || null;
  }

  async getOrder(shop, orderId) {
    const data = await this.load();
    return data.orders[`${shop}:${orderId}`] || null;
  }

  async hasWebhook(webhookId) {
    const data = await this.load();
    return Boolean(data.webhooks[webhookId]);
  }

  async saveQrFromWebhook({ shop, orderId, webhookId, record }) {
    return this.mutate((data) => {
      const key = `${shop}:${orderId}`;
      if (!data.orders[key]) data.orders[key] = record;
      data.webhooks[webhookId] = {
        shop,
        orderId: String(orderId),
        processedAt: new Date().toISOString(),
      };
      return data.orders[key];
    });
  }
}
