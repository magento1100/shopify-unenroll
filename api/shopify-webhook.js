// -----------------------------------------------------------------------------
// Shopify → LearnWorlds Webhook (FINAL VERSION WITH COURSE + BUNDLE SUPPORT)
// -----------------------------------------------------------------------------

export const config = {
  api: {
    bodyParser: false, // Needed for HMAC
  },
};

import crypto from "crypto";

// LearnWorlds
const LW_API_BASE =
  process.env.LW_API_BASE ||
  "https://securitymasterclasses.securityexcellence.net/admin/api/v2";
const LW_CLIENT = process.env.LW_CLIENT;
const LW_TOKEN = process.env.LW_TOKEN;

// Shopify
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

// -----------------------------------------------------------------------------
// RAW BODY FOR HMAC
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
// HMAC CHECK
// -----------------------------------------------------------------------------
function verifyHmac(raw, headerHmac) {
  if (!headerHmac || !SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(raw)
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
// SHOPIFY ADMIN GET
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
        stage: "shopify_admin_error",
        path,
        status: res.status,
      })
    );
    return null;
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// LEARNWORLDS UNENROLL
// -----------------------------------------------------------------------------
async function lwUnenroll(email, productId, productType) {
  const endpoint = `${LW_API_BASE}/users/${encodeURIComponent(
    email
  )}/enrollment`;

  console.log(
    JSON.stringify({
      stage: "lw_unenroll_request",
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
      body: text,
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
// BUILD REFUND ITEMS
// -----------------------------------------------------------------------------
function reconstructRefundItems(event, order) {
  const items = [];

  const refundItems =
    event?.refund_line_items ||
    event?.refund?.line_items ||
    [];

  for (const r of refundItems) {
    if (r.line_item) {
      items.push(r.line_item);
      continue;
    }

    if (r.line_item_id && order?.line_items) {
      const match = order.line_items.find((li) => li.id === r.line_item_id);
      if (match) items.push(match);
    }
  }

  console.log(
    JSON.stringify({
      stage: "refund_reconstructed",
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

    console.log(JSON.stringify({ stage: "webhook_received", topic }));

    if (!verifyHmac(raw, hmacHeader)) {
      console.log(JSON.stringify({ stage: "hmac_failed" }));
      return res.status(401).json({ ok: false, error: "HMAC failed" });
    }

    const event = JSON.parse(raw.toString("utf8"));

    // -----------------------------------------------------------
    // Resolve email
    // -----------------------------------------------------------
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

    console.log(JSON.stringify({ stage: "email_resolved", email }));

    if (!email) {
      return res.status(200).json({ ok: false, error: "email_not_found" });
    }

    // -----------------------------------------------------------
    // Determine line items
    // -----------------------------------------------------------
    let items = [];

    if (topic === "orders/cancelled") {
      items = event?.line_items || [];
    } else if (topic === "refunds/create") {
      if (!orderData && event.order_id) {
        orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
      }
      items = reconstructRefundItems(event, orderData?.order);
    } else if (topic === "orders/updated" && event?.cancelled_at) {
      items = event?.line_items || [];
    } else {
      return res.status(200).json({ ok: true, ignored_topic: topic });
    }

    console.log(
      JSON.stringify({
        stage: "line_items_loaded",
        count: items.length,
      })
    );

    // -----------------------------------------------------------
    // Process each item
    // -----------------------------------------------------------
    const actions = [];

    for (const li of items) {
      const sku = li?.sku || "";

      console.log(JSON.stringify({ stage: "sku_detected", sku }));

      if (!sku.startsWith("learnworlds_")) {
        actions.push({ status: "unmapped", sku });
        continue;
      }

      // Extract productId from SKU
      const productId = sku.replace(/^learnworlds_/, "");

      // Fetch Shopify product
      const productData = await shopifyAdmin(
        `/products/${li.product_id}.json`
      );

      const shopifyType = productData?.product?.product_type?.toLowerCase();

      const productType =
        shopifyType === "bundle"
          ? "bundle"
          : shopifyType === "course"
          ? "course"
          : "course"; // default fallback

      console.log(
        JSON.stringify({
          stage: "product_type_detected",
          sku,
          product_type: shopifyType,
          lw_type: productType,
        })
      );

      try {
        const resp = await lwUnenroll(email, productId, productType);
        actions.push({
          status: "unenrolled",
          sku,
          productId,
          productType,
          response: resp,
        });
      } catch (err) {
        actions.push({
          status: "error",
          sku,
          productId,
          productType,
          error: err.message,
        });
      }
    }

    console.log(JSON.stringify({ stage: "done", actions }));

    return res.status(200).json({ ok: true, email, actions });
  } catch (err) {
    console.log(JSON.stringify({ stage: "handler_error", error: err.message }));
    return res.status(500).json({ ok: false, error: err.message });
  }
}
