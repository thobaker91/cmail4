// Cmail — deployment diagnostics.
// If the platform is missing a piece (no D1 binding yet, tables not
// initialized, unexpected crash) the worker still answers with a calm,
// bilingual guide instead of a bare "internal server error".
import type { Env } from './util';

type Mode = 'binding' | 'tables' | 'generic';

function detect(env: Env, err: unknown): Mode {
  if (!env || !(env as Record<string, unknown>).DB) return 'binding';
  const msg = String((err as Error)?.message ?? err ?? '');
  if (/no such table/i.test(msg)) return 'tables';
  if (/no such column/i.test(msg)) return 'tables';
  return 'generic';
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- copy ----------
const FA = {
  binding: {
    title: 'اتصال دیتابیس برقرار نیست',
    lead: 'Cmail همین‌جا و بدون هیچ خطایی منتظر است — فقط کافی است یک Binding از نوع D1 با نام DB به پروژه داده شود. قدم‌ها:',
    steps: [
      'در داشبورد: Storage & Databases ← D1 ← دیتابیس بسازید (نام: cmail-db)',
      'کد Worker را باز کنید (Edit Code) و فایل worker.js را جای‌گذاری و Deploy کنید',
      'Settings ← Bindings ← Add ← D1 — نام متغیر: DB و انتخاب دیتابیس ساخته‌شده',
      'این صفحه را دوباره باز کنید؛ جداول خودکار ساخته می‌شوند',
    ],
    cli: 'راه ترمینالی: npx wrangler d1 create cmail-db و سپس deploy',
  },
  tables: {
    title: 'جداول هنوز ساخته نشده‌اند',
    lead: 'اتصال D1 سالم است. صفحهٔ اصلی را باز کنید؛ در همان نخستین قدمِ راه‌اندازی، دکمهٔ «ساخت خودکار جداول» همهٔ جداول را یک‌جا می‌سازد.',
    steps: [
      'باز کردن صفحهٔ اصلی — راه‌اندازی خودش ادامه می‌دهد',
      'یا ترمینالی: npx wrangler d1 execute cmail-db --remote --file=schema.sql',
    ],
    cli: '',
  },
  generic: {
    title: 'خطای غیرمنتظره',
    lead: 'چیز پیش‌بینی‌نشده‌ای رخ داد. جزئیات زیر برای گزارش مشکل کافی است:',
    steps: [],
    cli: '',
  },
} as const;

const EN = {
  binding: {
    title: 'Database binding is missing',
    lead: 'Everything else is ready — the worker just needs one D1 binding named DB. Steps:',
    steps: [
      'Dashboard → Storage & Databases → D1 → create a database (name: cmail-db)',
      'Open your Worker → Edit Code → paste worker.js → Deploy',
      'Settings → Bindings → Add → D1 — variable name: DB, pick the database',
      'Reload this page — the setup wizard takes over and creates the tables',
    ],
    cli: 'Terminal route: npx wrangler d1 create cmail-db, then deploy',
  },
  tables: {
    title: 'Tables are not created yet',
    lead: 'The D1 binding works. Open the home page — the first setup step has a one-click button that creates every table automatically.',
    steps: [
      'Open the home page — the wizard continues from there',
      'Or from a terminal: npx wrangler d1 execute cmail-db --remote --file=schema.sql',
    ],
    cli: '',
  },
  generic: {
    title: 'Unexpected error',
    lead: 'Something unexpected happened. The details below are enough to report the issue:',
    steps: [],
    cli: '',
  },
} as const;

function page(mode: Mode, lang: 'fa' | 'en', version: string, detail: string, time: string): string {
  const t = lang === 'fa' ? FA[mode] : EN[mode];
  const rtl = lang === 'fa' ? ' dir="rtl" style="text-align:right"' : '';
  const steps = t.steps.length
    ? `<ol class="steps">${t.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
    : '';
  const cli = t.cli ? `<p class="cli">${esc(t.cli)}</p>` : '';
  const detailBox =
    mode === 'generic'
      ? `<pre class="detail">${esc(detail.slice(0, 400) || 'unknown')}</pre><p class="meta">${esc(time)}${version ? ' · v' + esc(version) : ''}</p>`
      : `<p class="meta">v${esc(version)} · ${esc(time)}</p>`;
  return `<!doctype html>
<html lang="${lang}"${rtl}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cmail — ${esc(t.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.9 system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
    color: #e8eef2; background:
      radial-gradient(600px 400px at 15% 20%, rgba(96,165,250,.16), transparent 60%),
      radial-gradient(700px 500px at 85% 80%, rgba(52,211,153,.13), transparent 60%),
      #0b0f14;
  }
  .card {
    width: min(660px, 100%); padding: 34px 38px; border-radius: 22px;
    background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.09);
    box-shadow: 0 24px 70px rgba(0,0,0,.45); backdrop-filter: blur(18px);
  }
  .mark { font-weight: 800; font-size: 22px; letter-spacing: .4px; margin-bottom: 18px;
    background: linear-gradient(90deg, #9be3b4, #8ec9e8); -webkit-background-clip: text; background-clip: text; color: transparent; }
  h1 { font-size: 20px; margin-bottom: 10px; }
  p.lead { color: #b7c3cd; margin-bottom: 16px; }
  ol.steps { padding-inline-start: 22px; color: #dce6ee; margin-bottom: 16px; }
  ol.steps li { margin: 7px 0; }
  ol.steps code, p.cli code { background: rgba(255,255,255,.08); border-radius: 6px; padding: 1px 7px;
    font: 13px ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; direction: ltr; unicode-bidi: embed; }
  p.cli { color: #9fb2c0; font-size: 13.5px; }
  pre.detail { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px; padding: 12px 14px; font: 12.5px ui-monospace, Menlo, Consolas, monospace;
    direction: ltr; text-align: left; overflow-wrap: anywhere; white-space: pre-wrap; margin-bottom: 12px; }
  p.meta { color: #77899a; font-size: 12.5px; margin-top: 6px; }
  .both { margin-top: 22px; padding-top: 16px; border-top: 1px dashed rgba(255,255,255,.12);
    color: #77899a; font-size: 13px; text-align: center; }
  .both a { color: #8ec9e8; text-decoration: none; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">Cmail</div>
    <h1>${esc(t.title)}</h1>
    <p class="lead">${esc(t.lead)}</p>
    ${steps}${cli}${detailBox}
    <div class="both">${lang === 'fa'
      ? `<a href="?lang=en">English guide ↓</a>`
      : `<a href="?lang=fa">راهنمای فارسی ↑</a>`}</div>
  </main>
</body>
</html>`;
}

export function diagnosticResponse(req: Request, env: Env, err: unknown): Response {
  // defensive: even a malformed request must still get the guide page
  let url: URL | null = null;
  let accept = '';
  try {
    url = new URL((req as Request)?.url ?? 'http://localhost/');
    accept = (req as Request)?.headers?.get?.('accept-language') ?? '';
  } catch { url = null; }
  const forced = url?.searchParams.get('lang');
  const lang: 'fa' | 'en' = forced === 'fa' || forced === 'en'
    ? forced
    : /fa|pe/i.test(accept) ? 'fa' : 'en';
  const mode = detect(env, err);
  const detail = String((err as Error)?.message ?? err ?? '');
  const html = page(mode, lang, env?.APP_VERSION ?? '', detail, new Date().toISOString());
  return new Response(html, {
    status: mode === 'generic' ? 500 : 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
    },
  });
}
