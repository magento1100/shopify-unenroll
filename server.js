import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
// Defer importing the webhook handler to avoid startup issues

const app = express();
const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files (HTML, JS, CSS)
app.use(express.static(__dirname));

// Simple health check
app.get('/health', (req, res) => res.send('ok'));

// Webhook route with raw body buffer for HMAC verification
app.use('/api/shopify-webhook', express.raw({ type: '*/*' }));
app.post('/api/shopify-webhook', async (req, res) => {
  const mod = await import('./api/shopify-webhook.js');
  return mod.default(req, res);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
