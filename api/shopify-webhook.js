// // -----------------------------------------------------------------------------
// // Shopify → LearnWorlds Webhook (FINAL VERSION WITH COURSE + BUNDLE SUPPORT)
// // -----------------------------------------------------------------------------

// export const config = {
//   api: {
//     bodyParser: false, // Needed for HMAC
//   },
// };

// import crypto from "crypto";

// // LearnWorlds
// const LW_API_BASE =
//   process.env.LW_API_BASE ||
//   "https://securitymasterclasses.securityexcellence.net/admin/api/v2";
// const LW_CLIENT = process.env.LW_CLIENT;
// const LW_TOKEN = process.env.LW_TOKEN;

// // Shopify
// const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
// const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
// const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
// const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

// // -----------------------------------------------------------------------------
// // RAW BODY FOR HMAC
// // -----------------------------------------------------------------------------
// function readRawBody(req) {
//   return new Promise((resolve, reject) => {
//     const chunks = [];
//     req.on("data", (c) => chunks.push(c));
//     req.on("end", () => resolve(Buffer.concat(chunks)));
//     req.on("error", reject);
//   });
// }

// // -----------------------------------------------------------------------------
// // HMAC CHECK
// // -----------------------------------------------------------------------------
// function verifyHmac(raw, headerHmac) {
//   if (!headerHmac || !SHOPIFY_WEBHOOK_SECRET) return false;

//   const digest = crypto
//     .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
//     .update(raw)
//     .digest("base64");

//   try {
//     return crypto.timingSafeEqual(
//       Buffer.from(digest, "base64"),
//       Buffer.from(headerHmac, "base64")
//     );
//   } catch {
//     return false;
//   }
// }

// // -----------------------------------------------------------------------------
// // SHOPIFY ADMIN GET
// // -----------------------------------------------------------------------------
// async function shopifyAdmin(path) {
//   const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

//   const res = await fetch(url, {
//     headers: {
//       "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
//       Accept: "application/json",
//     },
//   });

//   if (!res.ok) {
//     console.log(
//       JSON.stringify({
//         stage: "shopify_admin_error",
//         path,
//         status: res.status,
//       })
//     );
//     return null;
//   }

//   return res.json();
// }

// // -----------------------------------------------------------------------------
// // LEARNWORLDS UNENROLL
// // -----------------------------------------------------------------------------
// async function lwUnenroll(email, productId, productType) {
//   const endpoint = `${LW_API_BASE}/users/${encodeURIComponent(
//     email
//   )}/enrollment`;

//   console.log(
//     JSON.stringify({
//       stage: "lw_unenroll_request",
//       email,
//       productId,
//       productType,
//     })
//   );

//   const res = await fetch(endpoint, {
//     method: "DELETE",
//     headers: {
//       Accept: "application/json",
//       Authorization: `Bearer ${LW_TOKEN}`,
//       "Lw-Client": LW_CLIENT,
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify({ productId, productType }),
//   });

//   const text = await res.text();

//   console.log(
//     JSON.stringify({
//       stage: "lw_unenroll_response",
//       status: res.status,
//       body: text,
//     })
//   );

//   if (!res.ok) {
//     throw new Error(`LW Unenroll Failed: ${res.status} - ${text}`);
//   }

//   try {
//     return JSON.parse(text);
//   } catch {
//     return { raw: text };
//   }
// }

// // -----------------------------------------------------------------------------
// // BUILD REFUND ITEMS
// // -----------------------------------------------------------------------------
// function reconstructRefundItems(event, order) {
//   const items = [];

//   const refundItems =
//     event?.refund_line_items ||
//     event?.refund?.line_items ||
//     [];

//   for (const r of refundItems) {
//     if (r.line_item) {
//       items.push(r.line_item);
//       continue;
//     }

//     if (r.line_item_id && order?.line_items) {
//       const match = order.line_items.find((li) => li.id === r.line_item_id);
//       if (match) items.push(match);
//     }
//   }

//   console.log(
//     JSON.stringify({
//       stage: "refund_reconstructed",
//       count: items.length,
//     })
//   );

//   return items;
// }

// // -----------------------------------------------------------------------------
// // MAIN HANDLER
// // -----------------------------------------------------------------------------
// export default async function handler(req, res) {
//   try {
//     const raw = await readRawBody(req);
//     const hmacHeader = req.headers["x-shopify-hmac-sha256"];
//     const topic = req.headers["x-shopify-topic"];

//     console.log(JSON.stringify({ stage: "webhook_received", topic }));

//     if (!verifyHmac(raw, hmacHeader)) {
//       console.log(JSON.stringify({ stage: "hmac_failed" }));
//       return res.status(401).json({ ok: false, error: "HMAC failed" });
//     }

//     const event = JSON.parse(raw.toString("utf8"));

//     // -----------------------------------------------------------
//     // Resolve email
//     // -----------------------------------------------------------
//     let email =
//       event?.email ||
//       event?.customer?.email ||
//       event?.order?.email ||
//       event?.order?.customer?.email;

//     let orderData = null;

//     if (!email && event?.order_id) {
//       orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
//       email =
//         orderData?.order?.email ||
//         orderData?.order?.customer?.email ||
//         null;
//     }

//     console.log(JSON.stringify({ stage: "email_resolved", email }));

//     if (!email) {
//       return res.status(200).json({ ok: false, error: "email_not_found" });
//     }

//     // -----------------------------------------------------------
//     // Determine line items
//     // -----------------------------------------------------------
//     let items = [];

//     if (topic === "orders/cancelled") {
//       items = event?.line_items || [];
//     } else if (topic === "refunds/create") {
//       if (!orderData && event.order_id) {
//         orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
//       }
//       items = reconstructRefundItems(event, orderData?.order);
//     } else if (topic === "orders/updated" && event?.cancelled_at) {
//       items = event?.line_items || [];
//     } else {
//       return res.status(200).json({ ok: true, ignored_topic: topic });
//     }

//     console.log(
//       JSON.stringify({
//         stage: "line_items_loaded",
//         count: items.length,
//       })
//     );

//     // -----------------------------------------------------------
//     // Process each item
//     // -----------------------------------------------------------
//     const actions = [];

//     for (const li of items) {
//       const sku = li?.sku || "";

//       console.log(JSON.stringify({ stage: "sku_detected", sku }));

//       if (!sku.startsWith("learnworlds_")) {
//         actions.push({ status: "unmapped", sku });
//         continue;
//       }

//       // Extract productId from SKU
//       const productId = sku.replace(/^learnworlds_/, "");

//       // Fetch Shopify product
//       const productData = await shopifyAdmin(
//         `/products/${li.product_id}.json`
//       );

//       const shopifyType = productData?.product?.product_type?.toLowerCase();

//       const productType =
//         shopifyType === "bundle"
//           ? "bundle"
//           : shopifyType === "course"
//           ? "course"
//           : "course"; // default fallback

//       console.log(
//         JSON.stringify({
//           stage: "product_type_detected",
//           sku,
//           product_type: shopifyType,
//           lw_type: productType,
//         })
//       );

//       try {
//         const resp = await lwUnenroll(email, productId, productType);
//         actions.push({
//           status: "unenrolled",
//           sku,
//           productId,
//           productType,
//           response: resp,
//         });
//       } catch (err) {
//         actions.push({
//           status: "error",
//           sku,
//           productId,
//           productType,
//           error: err.message,
//         });
//       }
//     }

//     console.log(JSON.stringify({ stage: "done", actions }));

//     return res.status(200).json({ ok: true, email, actions });
//   } catch (err) {
//     console.log(JSON.stringify({ stage: "handler_error", error: err.message }));
//     return res.status(500).json({ ok: false, error: err.message });
//   }
// }
// -----------------------------------------------------------------------------
// Shopify -> LearnWorlds webhook (with subscription cancellation support)
// - Detailed JSON logs (structured) for debugging
// - Supports orders/cancelled, orders/updated (cancelled_at + subscription items), refunds/create
// - Dynamic SKU -> LearnWorlds productId mapping (sku starts with "learnworlds_")
// - Shopify product_type -> LearnWorlds productType mapping (bundle / course)
// - Vercel-compatible (bodyParser: false)
// -----------------------------------------------------------------------------

export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from "crypto";

// --------------------- ENV ---------------------
const LW_API_BASE =
  process.env.LW_API_BASE ||
  "https://securitymasterclasses.securityexcellence.net/admin/api/v2";
const LW_CLIENT = process.env.LW_CLIENT;
const LW_TOKEN = process.env.LW_TOKEN;

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

// --------------------- RAW BODY ---------------------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// --------------------- HMAC ---------------------
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

// --------------------- Shopify Admin helper ---------------------
async function shopifyAdmin(path) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
    console.log(
      JSON.stringify({
        stage: "shopify_admin_missing_env",
      })
    );
    return null;
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  try {
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
  } catch (err) {
    console.log(
      JSON.stringify({
        stage: "shopify_admin_exception",
        path,
        error: err.message,
      })
    );
    return null;
  }
}

// --------------------- LearnWorlds unenroll ---------------------
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

// --------------------- Reconstruct refunds ---------------------
function reconstructRefundItems(event, order) {
  const out = [];
  const refundItems =
    event?.refund_line_items || event?.refund?.line_items || [];

  for (const r of refundItems) {
    if (r?.line_item) {
      out.push(r.line_item);
      continue;
    }
    if (r?.line_item_id && order?.line_items) {
      const match = order.line_items.find((li) => li.id === r.line_item_id);
      if (match) out.push(match);
    }
  }

  console.log(
    JSON.stringify({
      stage: "refund_reconstructed",
      count: out.length,
    })
  );
  return out;
}

// --------------------- SKU -> LearnWorlds mapping ---------------------
// expects SKU starting with "learnworlds_"
function mapLwFromSku(sku) {
  if (!sku || typeof sku !== "string") return null;
  if (!sku.startsWith("learnworlds_")) return null;
  const productId = sku.replace(/^learnworlds_/, "");
  return productId || null;
}

// --------------------- Get productType from Shopify product_type ---------------------
async function determineLwTypeFromShopifyProduct(productIdNumeric) {
  if (!productIdNumeric) return "course"; // fallback

  const pd = await shopifyAdmin(`/products/${productIdNumeric}.json`);
  const shopifyType = pd?.product?.product_type?.toLowerCase?.() || "";

  // map exactly: 'bundle' -> 'bundle', 'course' -> 'course'
  if (shopifyType === "bundle") return "bundle";
  if (shopifyType === "course") return "course";

  // fallback to 'course'
  return "course";
}

// --------------------- MAIN HANDLER ---------------------
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

    console.log(JSON.stringify({ stage: "hmac_verified" }));

    const event = JSON.parse(raw.toString("utf8"));

    // --------------------- Resolve email ---------------------
    let email =
      event?.email ||
      event?.customer?.email ||
      event?.order?.email ||
      event?.order?.customer?.email ||
      null;

    let orderData = null;
    if (!email && event?.order_id) {
      orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
      email =
        orderData?.order?.email || orderData?.order?.customer?.email || null;
      console.log(
        JSON.stringify({
          stage: "order_fetched_for_email",
          order_id: event.order_id,
          found_email: !!email,
        })
      );
    }

    console.log(JSON.stringify({ stage: "email_resolved", email: email || null }));

    if (!email) {
      // no email -> cannot unenroll
      console.log(JSON.stringify({ stage: "no_email_skip" }));
      return res.status(200).json({ ok: false, error: "email_not_found" });
    }

    // --------------------- Determine items to process ---------------------
    let items = [];

    if (topic === "orders/cancelled") {
      items = event?.line_items || [];
      console.log(JSON.stringify({ stage: "orders_cancelled_received", count: items.length }));
    } else if (topic === "orders/updated" && event?.cancelled_at) {
      // Order updated with cancelled_at — treat this as cancel event
      items = event?.line_items || [];
      console.log(JSON.stringify({ stage: "orders_updated_cancel", cancelled_at: event.cancelled_at, count: items.length }));
    } else if (topic === "refunds/create" || topic === "refunds/created") {
      // refunds may lack full line items; fetch order if necessary
      if (!orderData && event.order_id) {
        orderData = await shopifyAdmin(`/orders/${event.order_id}.json`);
        console.log(JSON.stringify({ stage: "order_fetched_for_refund", order_id: event.order_id, found_order: !!orderData }));
      }
      items = reconstructRefundItems(event, orderData?.order);
      console.log(JSON.stringify({ stage: "refunds_event", count: items.length }));
    } else {
      // Not an event we handle
      console.log(JSON.stringify({ stage: "ignored_topic", topic }));
      return res.status(200).json({ ok: true, ignored_topic: topic });
    }

    console.log(JSON.stringify({ stage: "line_items_loaded", count: items.length }));

    if (!Array.isArray(items) || items.length === 0) {
      console.log(JSON.stringify({ stage: "no_items_to_process" }));
      return res.status(200).json({ ok: true, message: "no_line_items" });
    }

    // --------------------- Process each item ---------------------
    const actions = [];

    for (const li of items) {
      // li is a Shopify line item object
      const sku = li?.sku || null;
      const sellingPlanId = li?.selling_plan_id || null;
      const isSubscriptionItem = Boolean(sellingPlanId);

      console.log(
        JSON.stringify({
          stage: "item_start",
          line_item_id: li?.id || null,
          sku,
          product_id: li?.product_id || null,
          variant_id: li?.variant_id || null,
          selling_plan_id: sellingPlanId,
          isSubscriptionItem,
        })
      );

      // Map LW productId from SKU
      const lwId = mapLwFromSku(sku);

      if (!lwId) {
        console.log(
          JSON.stringify({
            stage: "mapping_failed",
            reason: "sku_not_learnworlds",
            sku,
            line_item_id: li?.id || null,
          })
        );
        actions.push({ status: "unmapped", reason: "sku_not_learnworlds", line_item: li });
        continue;
      }

      // Determine LW productType using Shopify product_type
      const productType = await determineLwTypeFromShopifyProduct(li?.product_id);

      console.log(
        JSON.stringify({
          stage: "mapping_success",
          sku,
          lwId,
          productType,
          isSubscriptionItem,
        })
      );

      // For subscription logic: if this was a subscription line item, treat it as subscription-related
      // For Option A (simple): we unenroll when this order is a cancellation/refund AND the item is a subscription item (or we choose to unenroll subscription items on cancel/refund either way)
      // We'll unenroll regardless if the SKU matches; but we log subscription info for clarity.

      try {
        const resp = await lwUnenroll(email, lwId, productType);
        actions.push({
          status: "unenrolled",
          sku,
          lwId,
          productType,
          isSubscriptionItem,
          response: resp,
        });
      } catch (err) {
        console.log(
          JSON.stringify({
            stage: "unenroll_error",
            sku,
            lwId,
            productType,
            error: err.message,
          })
        );
        actions.push({
          status: "error",
          sku,
          lwId,
          productType,
          isSubscriptionItem,
          error: err.message,
        });
      }
    }

    console.log(JSON.stringify({ stage: "processing_complete", actions }));

    return res.status(200).json({ ok: true, email, actions });
  } catch (err) {
    console.log(JSON.stringify({ stage: "handler_error", error: err.message }));
    return res.status(500).json({ ok: false, error: err.message });
  }
}
