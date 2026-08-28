const DEFAULT_PATTERNS = [
  /\bMONA[\s_-]+(?:SHOPIFY|HARAVAN|SAPO|KIOTVIET|NHANH|PANCAKE|WOOCOMMERCE|WC)[\s:#_-]+(?<orderId>[A-Z0-9][A-Z0-9_-]*)\b/iu,
  /\b(?<orderId>(?:DH|HD|ORDER|ORD|WC)[-_]?[A-Z0-9]+)\b/iu,
];

export function compileOrderIdRegex(source) {
  if (!source) return null;
  try {
    return new RegExp(source, 'iu');
  } catch (error) {
    throw new Error(`ORDER_ID_REGEX không hợp lệ: ${error.message}`);
  }
}

function matchedOrderId(match) {
  return match?.groups?.orderId ?? match?.[1] ?? match?.[0];
}

export function mapOrderId(payload, { pattern } = {}) {
  const explicit = payload?.orderId ?? payload?.order_id;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return String(explicit).trim();
  }

  const description = typeof payload?.description === 'string' ? payload.description : '';
  const patterns = pattern ? [pattern] : DEFAULT_PATTERNS;
  for (const candidate of patterns) {
    candidate.lastIndex = 0;
    const value = matchedOrderId(candidate.exec(description));
    if (value) return String(value).trim();
  }
  return null;
}
