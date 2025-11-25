// -----------------------------------------------------------------------------
// REQUIRED FOR SHOPIFY WEBHOOKS ON VERCEL
// Disables Next.js body parsing so we can read RAW body bytes for HMAC check
// -----------------------------------------------------------------------------
export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from "crypto";

// -----------------------------------------------------------------------------
// ENV VARS
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// RAW BODY READER (required for Shopify HMAC)
// -----------------------------------------------------------------------------
async function getRawBody(req) {
  return await new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// -----------------------------------------------------------------------------
// HMAC Verification
// -----------------------------------------------------------------------------
function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.error("Missing SHOPIFY_WEBHOOK_SECRET");
    return false;
  }
  if (!hmacHeader) {
    console.error("Missing X-Shopify-Hmac-Sha256 header");
    return false;
  }

  const computed = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  const computedBuffer = Buffer.from(computed, "base64");
  const headerBuffer = Buffer.from(hmacHeader, "base64");

  if (computedBuffer.length !== headerBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuffer, headerBuffer);
}

// -----------------------------------------------------------------------------
// LearnWorlds Unenroll API
// -----------------------------------------------------------------------------
async function lwUnenroll(email, productId, productType) {
  if (!LW_TOKEN || !LW_CLIENT) {
    throw new Error("Missing LearnWorlds credentials.");
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
    throw new Error(
      `LearnWorlds unenroll failed: ${res.status} ${res.statusText} - ${text}`
    );
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// Load Product Mapping
// -----------------------------------------------------------------------------
function loadProductMap() {
  try {
    if (LW_PRODUCT_MAP_JSON) {
      return JSON.parse(LW_PRODUCT_MAP_JSON);
    }
  } catch (e) {
    console.warn("Invalid LW_PRODUCT_MAP_JSON:", e.message);
  }

  try {
    return require("../lw-product-map.json");
  } catch (_) {
    return {};
  }
}

// -----------------------------------------------------------------------------
// Shopify Admin API (optional lookup)
// -----------------------------------------------------------------------------
async function fetchShopifyAdmin(path) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) return null;

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text}`);
  }

  return res.json();
}

function extractLwFromMetafields(list) {
  if (!Array.isArray(list)) return null;

  const pid = list.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_id"
  )?.value;

  const ptype = list.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_type"
  )?.value;

  return pid && ptype ? { productId: pid, productType: ptype } : null;
}

async function resolveLwFromShopifyMetafields(lineItem, cache) {
  if (lineItem?.variant_id) {
    const key = `variant:${lineItem.variant_id}`;
    if (cache.has(key)) return cache.get(key);

    try {
      const data = await fetchShopifyAdmin(
        `/variants/${lineItem.variant_id}/metafields.json`
      );
      const lw = extractLwFromMetafields(data?.metafields);
      cache.set(key, lw);
      if (lw) return lw;
    } catch (_) {}
  }

  if (lineItem?.product_id) {
    const key = `product:${lineItem.product_id}`;
    if (cache.has(key)) return cache.get(key);

    try {
      const data = await fetchShopifyAdmin(
        `/products/${lineItem.product_id}/metafields.json`
      );
      const lw = extractLwFromMetafields(data?.metafields);
      cache.set(key, lw);
      if (lw) return lw;
    } catch (_) {}
  }

  return null;
}

async function resolveLwProductForLineItem(map, lineItem, cache) {
  const sku = (lineItem?.sku || "").trim();
  if (sku && map[sku]) return map[sku];

  const pidKey = `product:${lineItem?.product_id}`;
  if (map[pidKey]) return map[pidKey];

  const vidKey = `variant:${lineItem?.variant_id}`;
  if (map[vidKey]) return map[vidKey];

  // Check Shopify metafields fallback
  return await resolveLwFromShopifyMetafields(lineItem, cache);
}

// Refund items extractor
function getRefundedLineItems(refundEvent) {
  const list = [];

  try {
    const items =
      refundEvent?.refund_line_items || refundEvent?.refund?.line_items || [];

    for (const i of items) {
      list.push({
        sku: i?.line_item?.sku,
        product_id: i?.line_item?.product_id,
        variant_id: i?.line_item?.variant_id,
        properties: i?.line_item?.properties,
      });
    }
  } catch (_) {}

  return list;
}

// -----------------------------------------------------------------------------
// MAIN WEBHOOK HANDLER
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    const raw = await getRawBody(req);

    const topic = req.headers["x-shopify-topic"];
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    // HMAC verification
    if (!verifyShopifyHmac(raw, hmacHeader)) {
      console.error("❌ HMAC verification failed");
      return res
        .status(401)
        .json({ ok: false, error: "Invalid webhook signature" });
    }

    console.log("✅ HMAC verified:", topic);

    const event = JSON.parse(raw.toString("utf8"));
    const map = loadProductMap();

    const email =
      event?.email ||
      event?.customer?.email ||
      event?.order?.email ||
      event?.order?.customer?.email;

    if (!email) {
      console.warn("No email found — skipping as unenroll not possible.");
      return res.status(200).json({ ok: true, skipped: "no_email" });
    }

    let lineItems = [];

    if (topic === "orders/cancelled") {
      lineItems = event?.line_items || [];
    } else if (topic === "refunds/create") {
      lineItems = getRefundedLineItems(event);
    } else if (topic === "orders/updated" && event?.cancelled_at) {
      lineItems = event?.line_items || [];
    } else {
      return res.status(200).json({ ok: true, ignored: topic });
    }

    const actions = [];
    const cache = new Map();

    for (const li of lineItems) {
      const lw = await resolveLwProductForLineItem(map, li, cache);

      if (!lw) {
        actions.push({ line_item: li, status: "unmapped" });
        continue;
      }

      try {
        const resp = await lwUnenroll(
          email,
          lw.productId,
          lw.productType
        );
        actions.push({ line_item: li, status: "unenrolled", lw, resp });
      } catch (e) {
        actions.push({
          line_item: li,
          status: "error",
          lw,
          error: e.message,
        });
      }
    }

    return res.status(200).json({ ok: true, topic, actions });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
