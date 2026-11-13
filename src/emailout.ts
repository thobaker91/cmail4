// Cmail — outgoing email via HTTP providers (Brevo / Resend)
import type { Env } from './util';
import { getSettings } from './util';

export type SendResult = { ok: true; id?: string } | { ok: false; error: string };

export async function sendViaProvider(
  env: Env,
  opts: { to: string; toName?: string; subject: string; text: string; html?: string; replyTo?: string }
): Promise<SendResult> {
  const cfg = await getSettings(env, ['sending_provider', 'sending_api_key', 'sending_from_email', 'sending_from_name']);
  const provider = cfg.sending_provider ?? 'none';
  const apiKey = cfg.sending_api_key ?? '';
  const fromEmail = cfg.sending_from_email ?? '';
  const fromName = cfg.sending_from_name ?? 'Cmail';

  if (provider === 'none') return { ok: false, error: 'sending_not_configured' };
  if (!apiKey || !fromEmail) return { ok: false, error: 'sending_not_configured' };

  try {
    if (provider === 'brevo') {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: fromEmail, name: fromName },
          to: [{ email: opts.to, name: opts.toName ?? opts.to }],
          subject: opts.subject,
          textContent: opts.text,
          htmlContent: opts.html || `<pre style="font:14px/1.6 sans-serif;white-space:pre-wrap">${escapeHtml(opts.text)}</pre>`,
          replyTo: opts.replyTo ? { email: opts.replyTo } : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `brevo_${res.status}: ${body.slice(0, 300)}` };
      }
      const data = await res.json<{ messageId?: string }>();
      return { ok: true, id: data.messageId };
    }

    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
          to: [opts.to],
          subject: opts.subject,
          text: opts.text,
          html: opts.html,
          reply_to: opts.replyTo,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `resend_${res.status}: ${body.slice(0, 300)}` };
      }
      const data = await res.json<{ id?: string }>();
      return { ok: true, id: data.id };
    }

    return { ok: false, error: 'unknown_provider' };
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message.slice(0, 200)}` };
  }
}

export async function testProvider(env: Env, to: string): Promise<SendResult> {
  return sendViaProvider(env, {
    to,
    subject: '✉️ Cmail — test message',
    text: 'This is a test message from your Cmail instance. If you received it, outgoing mail works!',
    html: '<div style="font:15px/1.7 sans-serif">This is a <b>test message</b> from your Cmail instance.<br>If you received it, outgoing mail works! ✉️</div>',
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
