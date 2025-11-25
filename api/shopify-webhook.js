// -----------------------------------------------------------------------------
// Shopify → LearnWorlds Webhook (with structured JSON logs)
// -----------------------------------------------------------------------------

export const config = {
  api: {
    bodyParser: false, // REQUIRED for Shopify HMAC on Vercel
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
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

const LW_PRODUCT_MAP_JSON = process.env.LW_PRODUCT_MAP_JSON || "";

// -----------------------------------------------------------------------------
// HELPER: RAW BODY READER (required for HMAC)
// -----------------------------------------------------------------------------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// -----------------------------------------------------------------------------
// HELPER: HMAC VERIFICATION
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
  } catch (err) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// LOAD PRODUCT MAP
// -----------------------------------------------------------------------------
function loadProductMap() {
  try {
    if (LW_PRODUCT_MAP_JSON) {
      console.log(
        JSON.stringify({
          stage: "product_map_env",
          status: "loaded_from_env",
        })
      );
      return JSON.parse(LW_PRODUCT_MAP_JSON);
    }
  } catch (e) {
    console.log(
      JSON.stringify({
        stage: "product_map_env",
        status: "invalid_env_json",
        error: e.message,
      })
    );
  }

  try {
    const map = require("../lw-product-map.json");
    console.log(
      JSON.stringify({
        stage: "product_map_file",
        status: "loaded_from_file",
      })
    );
    return map;
  } catch {
    console.log(
      JSON.stringify({
        stage: "product_map_file",
        status: "missing",
      })
    );
    return {};
  }
}

// -----------------------------------------------------------------------------
// SHOPIFY ADMIN API
// -----------------------------------------------------------------------------
async function shopifyAdmin(path) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    console.log(
      JSON.stringify({
        stage: "shopify_admin",
        path,
        status: res.status,
      })
    );
    return null;
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// LEARNWORLDS UNENROLL API
// -----------------------------------------------------------------------------
async function lwUnenroll(email, productId, productType) {
  const endpoint = `${LW_API_BASE}/users/${encodeURIComponent(
    email
  )}/enrollment`;

  console.log(
    JSON.stringify({
      stage: "lw_unenroll_request",
      endpoint,
      email,
      productId,
      productType,
    })
  );

  const res = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${LW_TOKEN}`,
      "Lw-Client": LW_CLIENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ productId, productType }),
  });

  const text = await res.text();

  console.log(
    JSON.stringify({
      stage: "lw_unenroll_response",
      status: res.status,
      response: text,
    })
  );

  if (!res.ok) {
    throw new Error(`LW Unenroll Failed: ${res.status} - ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// -----------------------------------------------------------------------------
// METAFIELD → LW extract
// -----------------------------------------------------------------------------
function extractMetafieldLW(fields) {
  if (!Array.isArray(fields)) return null;

  const productId = fields.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_id"
  )?.value;

  const productType = fields.find(
    (m) => m.namespace === "learnworlds" && m.key === "product_type"
  )?.value;

  if (!productId || !productType) return null;

  return { productId, productType };
}

// -----------------------------------------------------------------------------
// PRODUCT RESOLUTION LOGIC (SKU / metafields / properties / map)
// -----------------------------------------------------------------------------
async function resolveLwProduct(lineItem, map, cache = new Map()) {
  const lineItemId = lineItem?.id;
  const sku = lineItem?.sku || "";
  const productId = lineItem?.product_id;
  const variantId = lineItem?.variant_id;

  console.log(
    JSON.stringify({
      stage: "mapping_start",
      lineItemId,
      sku,
      productId,
      variantId,
    })
  );

  // 1. Properties
  if (Array.isArray(lineItem.properties)) {
    const pid = lineItem.properties.find(
      (p) =>
        ["lw_product_id", "learnworlds_product_id", "course_id"].includes(
          p?.name || p?.label
        )
    )?.value;

    const ptype = lineItem.properties.find(
      (p) =>
        ["lw_product_type", "learnworlds_product_type", "course_type"].includes(
          p?.name || p?.label
        )
    )?.value;

    if (pid && ptype) {
      console.log(
        JSON.stringify({
          stage: "mapping_properties",
          result: "matched",
          productId: pid,
          productType: ptype,
        })
      );
      return { productId: pid, productType: ptype };
    }
  }

  // 2. SKU map
  if (sku && map[sku]) {
    console.log(
      JSON.stringify({
        stage: "mapping_sku",
        result: "matched",
        sku,
        lw: map[sku],
      })
    );
    return map[sku];
  }

  // 3. product:ID / variant:ID in map
  if (map[`product:${productId}`]) {
    console.log(
      JSON.stringify({
        stage: "mapping_productId_map",
        result: "matched",
        lw: map[`product:${productId}`],
      })
    );
    return map[`product:${productId}`];
  }

  if (map[`variant:${variantId}`]) {
    console.log(
      JSON.stringify({
        stage: "mapping_variantId_map",
        result: "matched",
        lw: map[`variant:${variantId}`],
      })
    );
    return map[`variant:${variantId}`];
  }

  // 4. Shopify metafield lookup (variant then product)
  if (variantId) {
    const ck = `variant:${variantId}`;
    if (!cache.has(ck)) {
      const meta = await shopifyAdmin(
        `/variants/${variantId}/metafields.json`
      );
      cache.set(ck, extractMetafieldLW(meta?.metafields));
    }
    if (cache.get(ck)) {
      console.log(
        JSON.stringify({
          stage: "mapping_variant_metafields",
          result: "matched",
          lw: cache.get(ck),
        })
      );
      return cache.get(ck);
    }
  }

  if (productId) {
    const ck = `product:${productId}`;
    if (!cache.has(ck)) {
      const meta = await shopifyAdmin(
        `/products/${productId}/metafields.json`
      );
      cache.set(ck, extractMetafieldLW(meta?.metafields));
    }
    if (cache.get(ck)) {
      console.log(
        JSON.stringify({
          stage: "mapping_product_metafields",
          result: "matched",
          lw: cache.get(ck),
        })
      );
      return cache.get(ck);
    }
  }

  console.log(
    JSON.stringify({
      stage: "mapping_end",
      result: "no_match",
      lineItemId,
    })
  );

  return null;
}

// -----------------------------------------------------------------------------
// RECONSTRUCT REFUND ITEMS
// -----------------------------------------------------------------------------
function reconstructRefundItems(refundEvent, order) {
  const items = [];

  const refundItems =
    refundEvent?.refund_line_items ||
    refundEvent?.refund?.line_items ||
    [];

  for (const r of refundItems) {
    if (r?.line_item) {
      items.push(r.line_item);
      continue;
    }

    if (r?.line_item_id && order?.line_items) {
      const match = order.line_items.find((li) => li.id === r.line_item_id);
      if (match) items.push(match);
    }
  }

  console.log(
    JSON.stringify({
      stage: "refund_line_items_reconstructed",
      count: items.length,
    })
  );

  return items;
}

// -----------------------------------------------------------------------------
// MAIN HANDLER
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    const raw = await readRawBody(req);
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];

    console.log(
      JSON.stringify({
        stage: "webhook_received",
        topic,
      })
    );

    // HMAC CHECK
    if (!verifyHmac(raw, hmacHeader)) {
      console.log(
        JSON.stringify({
          stage: "hmac_failed",
        })
      );
      return res.status(401).json({ ok: false, error: "HMAC failed" });
    }

    console.log(
      JSON.stringify({
        stage: "hmac_verified",
      })
    );

    // Parse JSON
    const event = JSON.parse(raw.toString("utf8"));
    const map = loadProductMap();

    // -------------------------------------------------------------------------
    // EMAIL RESOLUTION
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

    console.log(
      JSON.stringify({
        stage: "email_resolved",
        email: email || null,
      })
    );

    if (!email) {
      return res.status(200).json({
        ok: false,
        error: "email_not_found",
      });
    }

    // -------------------------------------------------------------------------
    // LINE ITEMS
    // -------------------------------------------------------------------------
    let lineItems = [];

    if (topic === "orders/cancelled" || (topic === "orders/updated" && event?.cancelled_at)) {
      lineItems = event?.line_items || [];
    }

    if (topic === "refunds/create" || topic === "refunds/created") {
      if (!orderData && event.order_id) {
        orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
      }

      lineItems = reconstructRefundItems(event, orderData?.order);
    }

    console.log(
      JSON.stringify({
        stage: "line_items_loaded",
        count: lineItems.length,
      })
    );

    if (lineItems.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "no_line_items",
      });
    }

    // -------------------------------------------------------------------------
    // PROCESS EACH LINE ITEM → UNENROLL
    // -------------------------------------------------------------------------
    const actions = [];
    const cache = new Map();

    for (const li of lineItems) {
      const lw = await resolveLwProduct(li, map, cache);

      if (!lw) {
        actions.push({ status: "unmapped", lineItem: li });
        continue;
      }

      try {
        const response = await lwUnenroll(
          email,
          lw.productId,
          lw.productType
        );

        actions.push({
          status: "unenrolled",
          lw,
          lineItem: li,
          response,
        });
      } catch (err) {
        actions.push({
          status: "error",
          lineItem: li,
          lw,
          error: err.message,
        });
      }
    }

    console.log(
      JSON.stringify({
        stage: "processing_complete",
        actions,
      })
    );

    return res.status(200).json({
      ok: true,
      topic,
      email,
      actions,
    });
  } catch (err) {
    console.log(
      JSON.stringify({
        stage: "handler_error",
        error: err.message,
      })
    );

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
