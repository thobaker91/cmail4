// Cmail — the lock screen.
// The padlock at the top is not a shortcut — it really locks the panel:
// a full overlay covers everything, and the only ways back in are the
// credential the owner chose (the second factor by default, or the panel
// password — Settings → Security) or signing out entirely.
import { api, state, errText } from './api.js';
import { t } from './i18n.js';
import { h, clear, icon, toast, vibrate } from './ui.js';

const KEY = 'cmail_locked';
let overlayEl = null;

export function isLocked() { return sessionStorage.getItem(KEY) === '1'; }

export function lockNow() {
  sessionStorage.setItem(KEY, '1');
  render();
}

// called on boot and after every sign-in — a locked tab stays locked,
// a guest session never sees the lock at all
export function maybeLock() {
  if (isLocked() && state.user && state.user.role !== 'share') render();
  else if (overlayEl) unlockDone();
}

// what the lock asks for — the owner's choice, read from /me
function mode() { return state.lockMode === 'password' ? 'password' : 'totp'; }

function render() {
  if (overlayEl) return; // already on stage
  const m = mode();

  const title = h('h2', { class: 'lock__title' }, t('lockTitle'));
  const sub = h('p', { class: 'lock__sub' }, m === 'password' ? t('lockSubPw') : t('lockSubTotp'));

  const input = h('input', {
    class: `input ${m === 'totp' ? 'mono' : ''}`,
    type: m === 'password' ? 'password' : 'text',
    inputmode: m === 'totp' ? 'numeric' : undefined,
    autocomplete: m === 'totp' ? 'one-time-code' : 'current-password',
    maxlength: m === 'totp' ? '8' : undefined,
    placeholder: m === 'totp' ? '••••••' : '••••••••',
    style: { textAlign: 'center', fontSize: m === 'totp' ? '20px' : '16px', letterSpacing: m === 'totp' ? '7px' : '2px' },
    'aria-label': m === 'password' ? t('password') : t('totpTitle'),
  });

  const btn = h('button', { class: 'btn btn--primary', type: 'submit', style: { width: '100%' } }, icon('lock'), t('lockUnlock'));
  const out = h('button', { class: 'btn btn--ghost', type: 'button', style: { width: '100%' } }, icon('logout'), t('lockLogout'));
  const card = h('div', { class: 'lock__card glass' },
    h('span', { class: 'lock__sigil', 'aria-hidden': 'true' }, icon('lockMode')),
    title, sub,
    h('form', { class: 'auth-form' }, h('div', { class: 'field' }, input), btn, out));
  overlayEl = h('div', { class: 'lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('lockTitle') }, card);
  requestAnimationFrame(() => overlayEl?.classList.add('is-on'));
  document.body.append(overlayEl);

  // pointer devices get the field focused immediately; phones wait a beat so
  // the keyboard does not yank the overlay up mid-animation
  const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  setTimeout(() => input.focus(), fine ? 80 : 350);

  const shake = () => {
    vibrate([12, 50, 12]);
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 600);
  };

  out.addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => { });
    unlockDone();
    state.user = null;
    location.hash = '#/login';
    if ((location.hash || '') === '#/login') location.reload();
  });

  card.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = String(input.value ?? '').trim();
    if (!value) { shake(); return; }
    btn.disabled = true;
    try {
      await api.post('/api/auth/verify-unlock', m === 'password' ? { mode: 'password', password: value } : { mode: 'totp', code: value });
      toast(t('lockWelcome'), 'ok', 1600);
      unlockDone();
    } catch (err) {
      toast(errText(err), 'err');
      shake();
      input.value = '';
      btn.disabled = false;
      // the second factor was switched off (or the mode changed) while the
      // panel sat locked — fall back to the panel password honestly
      if (err?.code === 'totp_not_enabled') {
        state.lockMode = 'password';
        overlayEl?.remove();
        overlayEl = null;
        render();
      }
      return;
    }
    btn.disabled = false;
  });
}

function unlockDone() {
  sessionStorage.removeItem(KEY);
  const el = overlayEl;
  overlayEl = null;
  if (el) {
    el.classList.remove('is-on');
    setTimeout(() => el.remove(), 320);
  }
}
