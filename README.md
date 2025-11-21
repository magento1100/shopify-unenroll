# Shopify -> LearnWorlds Unenroll (Vercel Serverless)

This project adds a Vercel serverless endpoint to automatically unenroll a customer from LearnWorlds products when a Shopify order is cancelled or refunded.

## Files

- `api/shopify-webhook.js`: Vercel serverless function that:
  - Verifies Shopify webhook HMAC.
  - Handles `orders/cancelled`, `orders/updated` (when cancelled), and `refunds/create`.
  - Maps Shopify line items to LearnWorlds products and calls LearnWorlds unenrollment.
- `lw-product-map.json`: Optional mapping (fallback when env var is not set) of Shopify SKU/product/variant IDs to LearnWorlds product identifiers and types.
- `index (1).html`: Local admin UI for manual enroll/unenroll (unchanged).

## Environment Variables (set in Vercel)

- `LW_API_BASE` — LearnWorlds Admin API base (default provided).
- `LW_CLIENT` — LearnWorlds client id.
- `LW_TOKEN` — LearnWorlds Bearer token.
- `SHOPIFY_WEBHOOK_SECRET` — Your app’s Shopify webhook secret.
- `LW_PRODUCT_MAP_JSON` — Optional JSON string (object) mapping Shopify identifiers to LearnWorlds products. Example:

```json
{
  "BUNDLE_PRO": { "productId": "test-bundle-ekta", "productType": "bundle" },
  "product:1234567890": { "productId": "course-xyz", "productType": "course" },
  "variant:987654321": { "productId": "pro-bundle", "productType": "bundle" }
}
```

If `LW_PRODUCT_MAP_JSON` is not set, the function will use `lw-product-map.json` in the repo.

### Dynamic Mapping (Recommended)

You don’t need to maintain a huge JSON. Store LearnWorlds product info in Shopify metafields and the webhook will resolve them on the fly:

- Add metafields on the product or variant with namespace `learnworlds`:
  - Key `product_id` → the LearnWorlds product id
  - Key `product_type` → `course` or `bundle`
- Provide these env vars so the webhook can read metafields:
  - `SHOPIFY_STORE_DOMAIN` — e.g. `your-store.myshopify.com`
  - `SHOPIFY_ADMIN_ACCESS_TOKEN` — Admin API access token
  - `SHOPIFY_API_VERSION` — optional (defaults to `2023-10`)
- Resolution priority in webhook:
  1) Static map by `SKU`, `product:<id>`, or `variant:<id>`
  2) Line item properties `lw_product_id` and `lw_product_type`
  3) Shopify metafields (variant first, then product)

This lets you handle many products without updating code. As you add new products, just set their metafields; the webhook picks them up automatically.

## Deployment (Vercel)

1. Import this repo into Vercel.
2. Add the environment variables above under Project Settings → Environment Variables.
3. Deploy. Vercel will expose the function at `https://<your-project>.vercel.app/api/shopify-webhook`.
4. In Shopify Admin, register webhooks to this URL for:
   - `orders/cancelled`
   - `refunds/create`
   - (Optional) `orders/updated` if you prefer to catch cancellations there
5. In each webhook, set the secret that matches `SHOPIFY_WEBHOOK_SECRET`.

## Mapping Strategy

The function resolves LearnWorlds products using the following priority:

1. SKU — `line_item.sku` key in the mapping.
2. Product ID — key formatted as `product:<product_id>`.
3. Variant ID — key formatted as `variant:<variant_id>`.
4. Line item properties — properties named `lw_product_id` and `lw_product_type`.

Populate `LW_PRODUCT_MAP_JSON` (or `lw-product-map.json`) if you prefer static mapping. Otherwise, rely on metafields or line item properties for dynamic resolution.

## Notes

- Webhook HMAC is verified using `SHOPIFY_WEBHOOK_SECRET`; the function returns 401 if invalid.
- LearnWorlds calls use `DELETE /users/{email}/enrollment` with `productId` and `productType`.
- The local UI (`index (1).html`) contains hard-coded credentials; do not deploy it publicly. Use the serverless function with env vars for production.