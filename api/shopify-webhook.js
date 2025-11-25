// -----------------------------------------------------------------------------
// REQUIRED FOR SHOPIFY WEBHOOKS ON VERCEL
// -----------------------------------------------------------------------------
export const config = {
  api: {
    bodyParser: false, // MUST BE FALSE FOR HMAC TO WORK
  },
};

import crypto from "crypto";

// Env Vars
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

// READ RAW BODY (REQUIRED FOR SHOPIFY)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// VERIFY SHOPIFY HMAC
function verifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch {
    return false;
  }
}

// LEARNWORLDS: UNENROLL USER
async function lwUnenroll(email, productId, productType) {
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
    throw new Error(`LearnWorlds error: ${res.status} - ${text}`);
  }

  return res.json();
}

// LOAD PRODUCT MAP
function loadProductMap() {
  try {
    return LW_PRODUCT_MAP_JSON
      ? JSON.parse(LW_PRODUCT_MAP_JSON)
      : require("../lw-product-map.json");
  } catch {
    return {};
  }
}

// SHOPIFY ADMIN API LOOKUPS
async function shopifyAdmin(path) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) return null;

  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`,
    {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) return null;

  return res.json();
}

// EXTRACT FROM METAFIELDS
function extractLwFromMetafields(fields) {
  if (!Array.isArray(fields)) return null;

  const productId = fields.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_id"
  )?.value;

  const productType = fields.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_type"
  )?.value;

  return productId && productType ? { productId, productType } : null;
}

// FIND PRODUCT MAP ENTRY
async function findLearnWorldsProduct(lineItem, map, cache) {
  const sku = lineItem?.sku?.trim();
  if (sku && map[sku]) return map[sku];

  const pKey = `product:${lineItem?.product_id}`;
  if (map[pKey]) return map[pKey];

  const vKey = `variant:${lineItem?.variant_id}`;
  if (map[vKey]) return map[vKey];

  // Try Shopify metafields
  if (lineItem?.variant_id) {
    const variant = await shopifyAdmin(
      `/variants/${lineItem.variant_id}/metafields.json`
    );
    const lw = extractLwFromMetafields(variant?.metafields);
    if (lw) return lw;
  }

  if (lineItem?.product_id) {
    const product = await shopifyAdmin(
      `/products/${lineItem.product_id}/metafields.json`
    );
    const lw = extractLwFromMetafields(product?.metafields);
    if (lw) return lw;
  }

  return null;
}

// -----------------------------------------------------------------------------
// MAIN HANDLER — WORKING SHOPIFY WEBHOOK FOR VERCEL
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    const rawBody = await readRawBody(req);

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];

    // Verify signature
    if (!verifyHmac(rawBody, hmacHeader, SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).json({ ok: false, error: "HMAC verification failed" });
    }

    console.log("✔️ HMAC Verified:", topic);

    const event = JSON.parse(rawBody.toString("utf8"));
    const map = loadProductMap();

    // Identify customer email
    const email =
      event?.email ||
      event?.customer?.email ||
      event?.order?.email ||
      event?.order?.customer?.email;

    if (!email) {
      return res.status(200).json({ ok: true, skip: "No email" });
    }

    let lineItems = [];

    if (topic === "orders/cancelled" || (topic === "orders/updated" && event?.cancelled_at)) {
      lineItems = event?.line_items || [];
    } else if (topic === "refunds/create") {
      lineItems =
        event?.refund_line_items?.map((i) => i.line_item) || [];
    } else {
      return res.status(200).json({ ok: true, ignored: topic });
    }

    const actions = [];
    const cache = new Map();

    for (const item of lineItems) {
      const lw = await findLearnWorldsProduct(item, map, cache);

      if (!lw) {
        actions.push({ status: "unmapped", item });
        continue;
      }

      try {
        const r = await lwUnenroll(email, lw.productId, lw.productType);
        actions.push({ status: "unenrolled", item, lw, response: r });
      } catch (e) {
        actions.push({ status: "error", item, lw, error: e.message });
      }
    }

    return res.status(200).json({ ok: true, topic, actions });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
