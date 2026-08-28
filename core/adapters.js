import { createAdapter as createHaravanAdapter } from '../adapters/haravan/index.js';
import { createAdapter as createKiotVietAdapter } from '../adapters/kiotviet/index.js';
import { createAdapter as createNhanhAdapter } from '../adapters/nhanh/index.js';
import { createAdapter as createPancakeAdapter } from '../adapters/pancake/index.js';
import { createAdapter as createSapoAdapter } from '../adapters/sapo/index.js';
import { createAdapter as createShopifyAdapter } from '../adapters/shopify/index.js';
import { createAdapter as createWooCommerceAdapter } from '../adapters/woocommerce/index.js';

const factories = {
  haravan: createHaravanAdapter,
  kiotviet: createKiotVietAdapter,
  nhanh: createNhanhAdapter,
  pancake: createPancakeAdapter,
  sapo: createSapoAdapter,
  shopify: createShopifyAdapter,
  woocommerce: createWooCommerceAdapter,
};

export function createPlatformAdapter(platform, options = {}) {
  const factory = factories[platform];
  if (!factory) throw new Error(`Chưa có adapter cho ${platform}`);
  return factory(options);
}
