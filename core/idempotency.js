export class IdempotencyCache {
  constructor({ ttlMs = 86_400_000, maxEntries = 10_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  has(key) {
    const expiresAt = this.entries.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key) {
    const now = this.now();
    for (const [entryKey, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(entryKey);
    }
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, now + this.ttlMs);
  }
}
