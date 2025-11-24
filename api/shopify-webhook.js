// Shopify -> LearnWorlds webhook handler (Vercel Serverless Function)
// Handles orders/cancelled and refunds/create to unenroll products in LearnWorlds

import crypto from 'crypto';

const LW_API_BASE = process.env.LW_API_BASE || 'https://securitymasterclasses.securityexcellence.net/admin/api/v2';
const LW_CLIENT = process.env.LW_CLIENT; // e.g., 64facb2d6072346ff30ed226
const LW_TOKEN = process.env.LW_TOKEN; // Bearer token
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // App's webhook secret
const LW_PRODUCT_MAP_JSON = process.env.LW_PRODUCT_MAP_JSON || ''; // Optional JSON mapping string

// Optional: dynamically resolve mapping via Shopify Admin API metafields
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g., my-store.myshopify.com
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN; // Admin API token
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2023-10';

// Read raw request body for HMAC verification
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}


function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.warn('SHOPIFY_WEBHOOK_SECRET is missing – cannot verify webhook.');
    return false;
  }
  // Compute HMAC over the RAW BYTES (no encoding argument)
  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  if (!hmacHeader) return false;
  // timingSafeEqual requires same length buffers
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  console.log('HMAC debug', { computedLen: a.length, headerLen: b.length });
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function lwUnenroll(email, productId, productType) {
  if (!LW_TOKEN || !LW_CLIENT) {
    throw new Error('Missing LearnWorlds credentials (LW_TOKEN, LW_CLIENT).');
  }
  const res = await fetch(`${LW_API_BASE}/users/${encodeURIComponent(email)}/enrollment`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${LW_TOKEN}`,
      'Lw-Client': LW_CLIENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ productId, productType }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LearnWorlds unenroll failed: ${res.status} ${res.statusText} - ${text}`);
  }
  return res.json();
}

function loadProductMap() {
  // Priority: env var JSON -> repo file lw-product-map.json -> empty
  try {
    if (LW_PRODUCT_MAP_JSON) {
      return JSON.parse(LW_PRODUCT_MAP_JSON);
    }
  } catch (e) {
    console.warn('Invalid LW_PRODUCT_MAP_JSON env value. Falling back to file map.', e.message);
  }
  try {
    // Dynamic import of local JSON if present
    return require('../lw-product-map.json');
  } catch (_) {
    return {};
  }
}

async function fetchShopifyAdmin(path) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) return null;
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

function extractLwFromMetafields(list) {
  if (!Array.isArray(list)) return null;
  const ns = 'learnworlds';
  const pid = list.find((m) => m.namespace === ns && m.key === 'product_id')?.value;
  const ptype = list.find((m) => m.namespace === ns && m.key === 'product_type')?.value;
  if (pid && ptype) return { productId: pid, productType: ptype };
  return null;
}

async function resolveLwFromShopifyMetafields(lineItem, cache) {
  // Try variant metafields first
  if (lineItem?.variant_id) {
    const cacheKey = `variant:${lineItem.variant_id}`;
    if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
    try {
      const data = await fetchShopifyAdmin(`/variants/${lineItem.variant_id}/metafields.json`);
      const lw = extractLwFromMetafields(data?.metafields);
      if (cache) cache.set(cacheKey, lw);
      if (lw) return lw;
    } catch (_) {}
  }
  // Fallback to product metafields
  if (lineItem?.product_id) {
    const cacheKey = `product:${lineItem.product_id}`;
    if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
    try {
      const data = await fetchShopifyAdmin(`/products/${lineItem.product_id}/metafields.json`);
      const lw = extractLwFromMetafields(data?.metafields);
      if (cache) cache.set(cacheKey, lw);
      if (lw) return lw;
    } catch (_) {}
  }
  return null;
}

async function resolveLwProductForLineItem(map, lineItem, cache) {
  // Prefer mapping by SKU; fallback to product_id or variant_id keys
  const sku = (lineItem?.sku || '').trim();
  if (sku && map[sku]) return map[sku];
  const pidKey = `product:${lineItem?.product_id}`;
  if (map[pidKey]) return map[pidKey];
  const vidKey = `variant:${lineItem?.variant_id}`;
  if (map[vidKey]) return map[vidKey];

  // If the line item has custom properties containing LearnWorlds hints
  const props = Array.isArray(lineItem?.properties) ? lineItem.properties : [];
  const lwIdProp = props.find((p) => (p?.name || p?.label) === 'lw_product_id');
  const lwTypeProp = props.find((p) => (p?.name || p?.label) === 'lw_product_type');
  if (lwIdProp && lwTypeProp) {
    return { productId: lwIdProp.value, productType: lwTypeProp.value };
  }
  // Last resort: lookup from Shopify metafields dynamically
  return await resolveLwFromShopifyMetafields(lineItem, cache);
}

function getRefundedLineItems(refundEvent) {
  // refunds/create webhook contains refund.line_items with quantities
  const refunded = [];
  try {
    const refunds = refundEvent?.refund_line_items || refundEvent?.refund?.line_items || [];
    for (const item of refunds) {
      // Normalize shape across REST variations
      refunded.push({
        sku: item?.line_item?.sku,
        product_id: item?.line_item?.product_id,
        variant_id: item?.line_item?.variant_id,
        properties: item?.line_item?.properties,
      });
    }
  } catch (_) {}
  return refunded;
}

export default async function handler(req, res) {
  try {
    const raw = await readRawBody(req);
    const topic = req.headers['x-shopify-topic'];
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const shopDomainHeader = req.headers['x-shopify-shop-domain'];
    console.log('Webhook received', { topic, bytes: raw?.length || 0, method: req.method, hmacPresent: !!hmacHeader, shopDomain: shopDomainHeader });
    console.log('Webhook received', { topic, bytes: raw?.length || 0, method: req.method });

    if (!verifyShopifyHmac(raw, hmacHeader)) {
      console.warn('Invalid webhook signature or missing secret.');
      return res.status(401).send('Invalid webhook signature');
    }

    const event = JSON.parse(raw.toString('utf8'));
    const map = loadProductMap();

    // Identify email
    const email = event?.email || event?.customer?.email || event?.order?.email || event?.order?.customer?.email;
    if (!email) {
      console.warn('Webhook payload missing email; skipping unenroll.');
      return res.status(200).json({ ok: true, skipped: 'no_email' });
    }

    let lineItems = [];
    if (topic === 'orders/cancelled') {
      lineItems = event?.line_items || [];
    } else if (topic === 'refunds/create') {
      lineItems = getRefundedLineItems(event);
    } else if (topic === 'orders/updated' && event?.cancelled_at) {
      // Some stores prefer orders/updated when cancelled
      lineItems = event?.line_items || [];
    } else {
      // Ignore other topics
      return res.status(200).json({ ok: true, ignored_topic: topic });
    }

    const actions = [];
    const cache = new Map();
    for (const li of lineItems) {
      const lw = await resolveLwProductForLineItem(map, li, cache);
      if (!lw) {
        actions.push({ line_item: li, status: 'unmapped' });
        continue;
      }
      try {
        const resp = await lwUnenroll(email, lw.productId, lw.productType);
        actions.push({ line_item: li, status: 'unenrolled', lw, resp });
      } catch (e) {
        actions.push({ line_item: li, status: 'error', lw, error: e.message });
      }
    }

    return res.status(200).json({ ok: true, topic, actions });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}