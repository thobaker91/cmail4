// Cmail — the dynamic island: one small glass pill that drops from under the
// navigation and speaks, in real time, whenever a mail leaves or arrives.
// Sending shows its progress live; the moment it lands, a View button rides
// in. A fresh arrival opens straight into the message with one tap.
// Small, compact, single-line — it never breaks a phone's layout.
import { t } from './i18n.js';
import { h, clear, icon, vibrate } from './ui.js';

let el = null;
let hideT = null;

function ensure() {
  if (el?.isConnected) return el;
  el = h('div', { class: 'dyn-island', role: 'status', 'aria-live': 'polite' });
  document.body.append(el);
  return el;
}

// show({ icn, kind, title, desc, busy, action, onClick, ttl })
//   kind     'acc' (accent) · 'ok' · 'warn'
//   busy     halo breathing + the island stays until replaced
//   action   { label, fn } — the little pill button (View)
//   onClick  tapping the island body itself
//   ttl      ms before it quietly slides back up
export function show(opts) {
  const box = ensure();
  clearTimeout(hideT);
  clear(box);
  box.className = `dyn-island${opts.busy ? ' is-busy' : ''}`;

  const icn = h('span', { class: `dyn-island__icn ${opts.kind === 'ok' ? 'is-ok' : opts.kind === 'warn' ? 'is-warn' : ''}` },
    opts.busy ? h('span', { class: 'spin--inline' }, icon('refresh')) : icon(opts.icn || 'mail'));
  const txt = h('span', { class: 'dyn-island__txt' },
    h('span', { class: 'dyn-island__t' }, opts.title ?? ''),
    opts.desc ? h('span', { class: 'dyn-island__d' }, opts.desc) : '');

  box.append(icn, txt);
  if (opts.action) {
    box.append(h('button', { class: 'dyn-island__act', onclick: (e) => { e.stopPropagation(); hide(); opts.action.fn(); } },
      opts.action.label));
  }

  box.onclick = () => {
    if (!opts.onClick) { hide(); return; }
    hide();
    opts.onClick();
  };

  requestAnimationFrame(() => box.classList.add('is-in'));
  if (opts.ttl !== 0 && !opts.busy) hideT = setTimeout(hide, opts.ttl ?? 6000);
}

export function hide() {
  clearTimeout(hideT);
  if (!el?.isConnected) return;
  el.classList.remove('is-in');
  const dead = el;
  setTimeout(() => dead.remove(), 480);
  el = null;
}

// ---- the two live moments ----

// a mail is leaving — the island holds its breath until the server answers
export function sending() {
  show({ busy: true, title: t('sending'), desc: '', ttl: 0 });
}

// the send landed — a View button rides the island straight to the mail
export function sent(mailId, desc) {
  vibrate([8, 30, 8]);
  show({
    icn: 'check', kind: 'ok',
    title: t('islandSentT'), desc: desc || t('islandSentD'),
    action: { label: t('islandView'), fn: () => { location.hash = `#/mail/m/${mailId}`; } },
    onClick: () => { location.hash = `#/mail/m/${mailId}`; },
    ttl: 7000,
  });
}

// a fresh arrival — one tap opens the mail
export function arrived(mail) {
  vibrate([8, 30, 8]);
  show({
    icn: 'inbox', kind: 'acc',
    title: t('islandNewT'),
    desc: mail.from_name || mail.from_addr || '',
    onClick: () => { location.hash = `#/mail/m/${mail.id}`; },
    ttl: 6500,
  });
}
