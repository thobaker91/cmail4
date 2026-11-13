// Cmail — Cloudflare Worker entry
// API (Hono) + incoming email handler + scheduled cleanup + fully
// self-contained UI (every asset is embedded in the bundle — the worker
// serves its own interface, so deployment needs nothing but this file
// and one D1 binding).
import { Hono } from 'hono';
import type { Env, AppEnv } from './util';
import { attachUser } from './auth';
import { handleEmail, scheduledCleanup } from './emailin';
import { ASSET_FILES } from './generated/assets';
import { diagnosticResponse } from './diag';
import setupRoutes from './routes/setup';
import authRoutes from './routes/auth';
import addressRoutes from './routes/addresses';
import emailRoutes from './routes/emails';
import totpRoutes from './routes/totp';
import mailfolderRoutes from './routes/mailfolders';
import adminRoutes from './routes/admin';
import shareRoutes from './routes/share';

const app = new Hono<AppEnv>();

// ---------- security headers ----------
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!c.req.path.startsWith('/api')) {
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: http:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src 'self' data: about:",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; ')
    );
  }
});

// ---------- embedded UI ----------
function asset(name: string): Response | null {
  const f = ASSET_FILES[name];
  if (!f) return null;
  const headers: Record<string, string> = {
    'Content-Type': f.type,
    ETag: f.tag,
    // fonts never change → cache them for good. Revalidating them on every
    // load (the old no-cache) made late font swaps reflow the whole page on
    // slow networks — one of the real causes of the "page jump" reports.
    'Cache-Control': f.type === 'font/woff2' ? 'public, max-age=31536000, immutable'
      : f.type.startsWith('image/') ? 'public, max-age=86400'
      : 'no-cache',
  };
  const body: BodyInit = f.text !== undefined ? f.text : Uint8Array.from(atob(f.b64!), (ch) => ch.charCodeAt(0));
  return new Response(body, { status: 200, headers });
}

app.get('/', (c) => {
  const hit = asset('index.html');
  if (hit && c.req.header('If-None-Match') === hit.headers.get('ETag')) return c.body(null, 304);
  return hit ?? c.text('Not found', 404);
});
app.get('/index.html', (c) => asset('index.html') ?? c.text('Not found', 404));
app.get('/manifest.json', (c) => asset('manifest.json') ?? c.text('Not found', 404));
app.get('/assets/*', (c) => {
  let name = '';
  try { name = decodeURIComponent(new URL(c.req.url).pathname); } catch { return c.text('Bad request', 400); }
  // '/assets/css/app.css' → 'assets/css/app.css' (keys are paths relative to public/)
  name = name.replace(/^\/+/, '');
  const hit = asset(name);
  if (!hit) return c.text('Not found', 404);
  if (c.req.header('If-None-Match') === hit.headers.get('ETag')) return c.body(null, 304);
  return hit;
});

// ---------- api ----------
app.use('/api/*', attachUser);
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

app.route('/api/setup', setupRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/addresses', addressRoutes);
app.route('/api/emails', emailRoutes);
app.route('/api/totp', totpRoutes);
app.route('/api/mail-folders', mailfolderRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/share', shareRoutes);

app.get('/api/health', (c) => c.json({ ok: true, service: 'cmail', time: Date.now() }));

// api 404
app.all('/api/*', (c) => c.json({ ok: false, error: 'not_found' }, 404));

// ---------- fallbacks ----------
app.notFound((c) => {
  if (c.req.method === 'GET' && !c.req.path.startsWith('/api')) {
    return asset('index.html') ?? c.text('Not found', 404);
  }
  return c.text('Not found', 404);
});

// API errors stay JSON; pages get the styled diagnostics page.
app.onError((err, c) => {
  if (c.req.path.startsWith('/api')) {
    return c.json(
      { ok: false, error: 'server_error', detail: String(err?.message ?? err).slice(0, 200) },
      500
    );
  }
  return diagnosticResponse(c.req.raw, c.env, err);
});

// ---------- exports ----------

export default {
  // last-resort net: even a broken deployment shows guidance, never a bare
  // "internal server error". (try/catch for synchronous throws, .catch for
  // async rejections — both layers matter.)
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    try {
      return (app.fetch(req, env, ctx) as Promise<Response>).catch((e: unknown) => diagnosticResponse(req, env, e));
    } catch (e) {
      return diagnosticResponse(req, env, e);
    }
  },

  // Cloudflare Email Routing receiver
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext) {
    try {
      await handleEmail(message, env);
    } catch (e) {
      console.error('email handler failed:', e);
      message.setReject('Cmail failed to process this message');
    }
  },

  // hourly: expire temp inboxes, retention, session hygiene
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    try {
      await scheduledCleanup(env);
    } catch (e) {
      console.error('scheduled cleanup failed:', e);
    }
  },
};
