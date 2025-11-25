// -----------------------------------------------------------------------------
// Shopify -> LearnWorlds webhook (pages/api/shopify-webhook.js)
// - Raw body for HMAC (bodyParser: false required for Vercel)
// - Verifies HMAC
// - Dynamically resolves LearnWorlds productId/productType from order items
// - Unenrolls users via LearnWorlds API DELETE /users/{email}/enrollment
// -----------------------------------------------------------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from "crypto";

// ----- ENV -----
const LW_API_BASE =
  process.env.LW_API_BASE ||
  "https://securitymasterclasses.securityexcellence.net/admin/api/v2";

const LW_CLIENT = process.env.LW_CLIENT;
const LW_TOKEN = process.env.LW_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const LW_PRODUCT_MAP_JSON = process.env.LW_PRODUCT_MAP_JSON || "";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

// ----- Utilities: read raw body -----
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ----- Verify HMAC -----
function verifyHmac(rawBody, headerHmac) {
  if (!SHOPIFY_WEBHOOK_SECRET || !headerHmac) return false;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "base64"),
      Buffer.from(headerHmac, "base64")
    );
  } catch {
    return false;
  }
}

// ----- LearnWorlds API: unenroll user -----
// Matches your CLI usage: DELETE /users/{email}/enrollment with body {productId, productType}
async function lwUnenroll(email, productId, productType) {
  if (!LW_TOKEN || !LW_CLIENT) {
    throw new Error("Missing LearnWorlds credentials (LW_TOKEN or LW_CLIENT).");
  }

  const res = await fetch(
    `${LW_API_BASE}/users/${encodeURIComponent(email)}/enrollment`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${LW_TOKEN}`,
        "Lw-Client": LW_CLIENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ productId, productType }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LearnWorlds unenroll failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// ----- Load product map (env override or file) -----
// Your uploaded map (lw-product-map.json) will be used if present. :contentReference[oaicite:5]{index=5}
function loadProductMap() {
  try {
    if (LW_PRODUCT_MAP_JSON) return JSON.parse(LW_PRODUCT_MAP_JSON);
  } catch (e) {
    console.warn("Invalid LW_PRODUCT_MAP_JSON (env). Falling back to file.");
  }
  try {
    // relative to pages/api, file should be at project root or one level up depending on structure
    return require("../lw-product-map.json");
  } catch {
    return {};
  }
}

// ----- Shopify Admin API helper (optional lookups) -----
async function shopifyAdmin(path) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) return null;
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// ----- Extract from metafields -----
// expects metafields array with namespace 'learnworlds' and keys product_id/product_type
function extractLwFromMetafields(fields) {
  if (!Array.isArray(fields)) return null;
  const pid = fields.find((m) => m.namespace === "learnworlds" && m.key === "product_id")?.value;
  const ptype = fields.find((m) => m.namespace === "learnworlds" && m.key === "product_type")?.value;
  if (pid && ptype) return { productId: pid, productType: ptype };
  return null;
}

// ----- Resolve LearnWorlds product for a single line item -----
// Strategy (in this order):
// 1) Check line item properties for lw_product_id/lw_product_type (or learnworlds_product_id/_type) -> dynamic per-order-item
// 2) Check SKU mapping in map
// 3) Check map keys product:{product_id} or variant:{variant_id}
// 4) Query Shopify metafields for variant -> product
async function resolveLwProductForLineItem(map, lineItem, cache = new Map()) {
  // 1) Check line item properties (Shopify line_item.properties array)
  const props = Array.isArray(lineItem?.properties) ? lineItem.properties : [];
  if (props.length) {
    // properties can be objects or {name, value} depending on payload
    const normalizeProps = props.map((p) => {
      if (p == null) return null;
      if (typeof p === "object" && ("name" in p || "label" in p)) {
        const key = p.name ?? p.label;
        const value = p.value ?? p;
        return { key: String(key), value };
      } else if (typeof p === "object" && Object.keys(p).length === 1) {
        // sometimes properties appear as { key: value } objects
        const k = Object.keys(p)[0];
        return { key: k, value: p[k] };
      } else {
        return null;
      }
    }).filter(Boolean);

    const findValue = (candidates) => {
      for (const c of candidates) {
        const found = normalizeProps.find((pp) => pp.key === c);
        if (found) return found.value;
      }
      return null;
    };

    // common property names to support (flexible)
    const idCandidates = ["lw_product_id", "learnworlds_product_id", "lw_productId", "lw_product"];
    const typeCandidates = ["lw_product_type", "learnworlds_product_type", "lw_productType", "lw_type"];

    const pid = findValue(idCandidates);
    const ptype = findValue(typeCandidates);

    if (pid && ptype) {
      return { productId: String(pid), productType: String(ptype) };
    }
  }

  // 2) SKU lookup (case-insensitive keys in map)
  const sku = (lineItem?.sku || "").trim();
  if (sku) {
    const mapKey = Object.keys(map).find(k => k.toLowerCase() === sku.toLowerCase());
    if (mapKey) return map[mapKey];
    if (map[sku]) return map[sku];
  }

  // 3) product:{id} and variant:{id} map keys
  const pKey = `product:${lineItem?.product_id}`;
  if (map[pKey]) return map[pKey];
  const vKey = `variant:${lineItem?.variant_id}`;
  if (map[vKey]) return map[vKey];

  // 4) Shopify metafields fallback (variant -> product)
  if (lineItem?.variant_id) {
    const cacheKey = `variant:${lineItem.variant_id}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    try {
      const data = await shopifyAdmin(`/variants/${lineItem.variant_id}/metafields.json`);
      const lw = extractLwFromMetafields(data?.metafields);
      cache.set(cacheKey, lw);
      if (lw) return lw;
    } catch (e) {
      // ignore and continue
    }
  }

  if (lineItem?.product_id) {
    const cacheKey = `product:${lineItem.product_id}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    try {
      const data = await shopifyAdmin(`/products/${lineItem.product_id}/metafields.json`);
      const lw = extractLwFromMetafields(data?.metafields);
      cache.set(cacheKey, lw);
      if (lw) return lw;
    } catch (e) {
      // ignore and continue
    }
  }

  return null;
}

// ----- Helper: get refunded items from refund payloads -----
function getRefundedLineItems(refundEvent) {
  const items = [];
  try {
    // some payloads have refund_line_items with line_item embedded
    const refunds = refundEvent?.refund_line_items || refundEvent?.refund?.line_items || [];
    for (const r of refunds) {
      if (r?.line_item) items.push(r.line_item);
      else if (r?.line_item_id && refundEvent?.order?.line_items) {
        // fallback: find corresponding order line item by id
        const found = refundEvent.order.line_items.find(li => li.id === r.line_item_id);
        if (found) items.push(found);
      }
    }
  } catch (e) {}
  return items;
}

// ----- Main handler -----
export default async function handler(req, res) {
  try {
    const raw = await readRawBody(req);

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];

    if (!verifyHmac(raw, hmacHeader)) {
      console.error("HMAC verification failed");
      return res.status(401).json({ ok: false, error: "HMAC verification failed" });
    }

    // parse event
    const event = JSON.parse(raw.toString("utf8"));
    const map = loadProductMap();

    // identify email
    const email =
      event?.email ||
      event?.customer?.email ||
      event?.order?.email ||
      event?.order?.customer?.email;

    if (!email) {
      console.warn("No email found in payload — skipping unenroll.");
      return res.status(200).json({ ok: true, skipped: "no_email" });
    }

    // determine line items to process
    let lineItems = [];
    if (topic === "orders/cancelled" || (topic === "orders/updated" && event?.cancelled_at)) {
      lineItems = event?.line_items || [];
    } else if (topic === "refunds/create" || topic === "refunds/created") {
      lineItems = getRefundedLineItems(event);
    } else {
      // ignore other topics
      return res.status(200).json({ ok: true, ignored: topic });
    }

    // iterate and unenroll where possible
    const actions = [];
    const cache = new Map();

    for (const li of lineItems) {
      try {
        const lw = await resolveLwProductForLineItem(map, li, cache);
        if (!lw) {
          actions.push({ line_item: li, status: "unmapped" });
          continue;
        }

        // call LearnWorlds unenroll
        const resp = await lwUnenroll(email, lw.productId, lw.productType);
        actions.push({ line_item: li, status: "unenrolled", lw, response: resp });
      } catch (e) {
        actions.push({ line_item: li, status: "error", error: e.message });
      }
    }

    return res.status(200).json({ ok: true, topic, actions });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
