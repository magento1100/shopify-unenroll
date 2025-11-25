// -----------------------------------------------------------------------------
// Shopify → LearnWorlds Webhook
// - Works on Vercel (bodyParser disabled)
// - Refund email fix (fetch order from Shopify Admin API)
// - Refund line item fix (rebuild line items from order if missing)
// - Dynamic LearnWorlds product detection
// - Unenroll from LW on cancel or refund
// -----------------------------------------------------------------------------

export const config = {
  api: {
    bodyParser: false, // REQUIRED for HMAC to work in Vercel
  },
};

import crypto from "crypto";

// -----------------------------------------------------------------------------
// ENV
// -----------------------------------------------------------------------------
const LW_API_BASE =
  process.env.LW_API_BASE ||
  "https://securitymasterclasses.securityexcellence.net/admin/api/v2";

const LW_CLIENT = process.env.LW_CLIENT;
const LW_TOKEN = process.env.LW_TOKEN;

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

const LW_PRODUCT_MAP_JSON = process.env.LW_PRODUCT_MAP_JSON || "";

// -----------------------------------------------------------------------------
// RAW BODY READER
// -----------------------------------------------------------------------------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// -----------------------------------------------------------------------------
// HMAC VERIFICATION
// -----------------------------------------------------------------------------
function verifyHmac(rawBody, headerHmac) {
  if (!headerHmac || !SHOPIFY_WEBHOOK_SECRET) return false;

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

// -----------------------------------------------------------------------------
// LOAD PRODUCT MAP
// -----------------------------------------------------------------------------
function loadProductMap() {
  try {
    if (LW_PRODUCT_MAP_JSON) return JSON.parse(LW_PRODUCT_MAP_JSON);
  } catch {
    console.warn("Invalid LW_PRODUCT_MAP_JSON, using file instead.");
  }

  try {
    return require("../lw-product-map.json");
  } catch {
    return {};
  }
}

// -----------------------------------------------------------------------------
// LEARNWORLDS: UNENROLL
// -----------------------------------------------------------------------------
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
    throw new Error(`LW unenroll FAILED: ${res.status} - ${text}`);
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// SHOPIFY ADMIN API
// -----------------------------------------------------------------------------
async function shopifyAdmin(path) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) return null;

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    console.error("Shopify Admin API FAILED:", res.status);
    return null;
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// LEARNWORLDS METAFIELD DETECTION
// -----------------------------------------------------------------------------
function extractLwFromMetafields(list) {
  if (!Array.isArray(list)) return null;

  const productId = list.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_id"
  )?.value;

  const productType = list.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_type"
  )?.value;

  if (productId && productType) {
    return { productId, productType };
  }

  return null;
}

// -----------------------------------------------------------------------------
// RESOLVE PRODUCT (dynamic lookup from item)
// -----------------------------------------------------------------------------
async function resolveLwProduct(lineItem, map, cache = new Map()) {
  // 1. line item properties
  const props = Array.isArray(lineItem?.properties) ? lineItem.properties : [];

  for (const p of props) {
    const key = p?.name || p?.label;
    if (!key) continue;

    if (
      ["lw_product_id", "learnworlds_product_id", "course_id"].includes(
        key
      )
    ) {
      const id = p.value;
      const type =
        props.find(
          (x) =>
            ["lw_product_type", "learnworlds_product_type", "course_type"].includes(
              x?.name || x?.label
            )
        )?.value || "course";

      return { productId: id, productType: type };
    }
  }

  // 2. SKU mapping (case-insensitive)
  const sku = (lineItem?.sku || "").trim();
  if (sku) {
    const key = Object.keys(map).find(
      (k) => k.toLowerCase() === sku.toLowerCase()
    );
    if (key) return map[key];
  }

  // 3. product:{id} / variant:{id}
  if (map[`product:${lineItem?.product_id}`])
    return map[`product:${lineItem.product_id}`];

  if (map[`variant:${lineItem?.variant_id}`])
    return map[`variant:${lineItem.variant_id}`];

  // 4. Shopify metafields
  if (lineItem?.variant_id) {
    const ck = `variant:${lineItem.variant_id}`;
    if (!cache.has(ck)) {
      const data = await shopifyAdmin(
        `/variants/${lineItem.variant_id}/metafields.json`
      );
      const lw = extractLwFromMetafields(data?.metafields);
      cache.set(ck, lw);
    }
    if (cache.get(ck)) return cache.get(ck);
  }

  if (lineItem?.product_id) {
    const ck = `product:${lineItem.product_id}`;
    if (!cache.has(ck)) {
      const data = await shopifyAdmin(
        `/products/${lineItem.product_id}/metafields.json`
      );
      const lw = extractLwFromMetafields(data?.metafields);
      cache.set(ck, lw);
    }
    if (cache.get(ck)) return cache.get(ck);
  }

  return null;
}

// -----------------------------------------------------------------------------
// REFUND LINE ITEMS RECONSTRUCTION
// -----------------------------------------------------------------------------
function reconstructRefundLineItems(refundEvent, order) {
  const out = [];

  const refundItems =
    refundEvent?.refund_line_items ||
    refundEvent?.refund?.line_items ||
    [];

  for (const r of refundItems) {
    if (r?.line_item) {
      out.push(r.line_item);
      continue;
    }

    if (r?.line_item_id && order?.line_items) {
      const match = order.line_items.find(
        (li) => li.id === r.line_item_id
      );
      if (match) out.push(match);
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// MAIN WEBHOOK HANDLER
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    // RAW BODY
    const raw = await readRawBody(req);

    // HMAC
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];

    if (!verifyHmac(raw, hmacHeader)) {
      return res
        .status(401)
        .json({ ok: false, error: "HMAC verification failed" });
    }

    // PARSE PAYLOAD
    const event = JSON.parse(raw.toString("utf8"));
    const map = loadProductMap();

    // -------------------------------------------------------------------------
    // EMAIL RESOLUTION (refund payloads often missing email)
    // -------------------------------------------------------------------------
    let email =
      event?.email ||
      event?.customer?.email ||
      event?.order?.email ||
      event?.order?.customer?.email;

    let orderData = null;

    if (!email && event?.order_id) {
      orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
      email =
        orderData?.order?.email ||
        orderData?.order?.customer?.email ||
        null;
    }

    if (!email) {
      console.error("No email found even after order fetch.");
      return res.status(200).json({
        ok: false,
        error: "EMAIL_NOT_FOUND",
      });
    }

    // -------------------------------------------------------------------------
    // DETERMINE LINE ITEMS
    // -------------------------------------------------------------------------
    let lineItems = [];

    if (topic === "orders/cancelled" || (topic === "orders/updated" && event?.cancelled_at)) {
      lineItems = event?.line_items || [];
    }

    if (topic === "refunds/create" || topic === "refunds/created") {
      if (!orderData && event.order_id) {
        orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
      }

      lineItems = reconstructRefundLineItems(
        event,
        orderData?.order
      );
    }

    if (!lineItems.length) {
      return res.status(200).json({
        ok: true,
        message: "No line items to process",
      });
    }

    // -------------------------------------------------------------------------
    // PROCESS LINE ITEMS -> UNENROLL
    // -------------------------------------------------------------------------
    const actions = [];
    const cache = new Map();

    for (const li of lineItems) {
      const lw = await resolveLwProduct(li, map, cache);

      if (!lw) {
        actions.push({ line_item: li, status: "unmapped" });
        continue;
      }

      try {
        const r = await lwUnenroll(email, lw.productId, lw.productType);
        actions.push({
          status: "unenrolled",
          line_item: li,
          lw,
          response: r,
        });
      } catch (e) {
        actions.push({
          status: "error",
          line_item: li,
          lw,
          error: e.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      topic,
      email,
      actions,
    });
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
