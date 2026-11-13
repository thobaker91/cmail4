// Cmail — API client + shared state
import { t } from './i18n.js';

export const state = {
  user: null,
  addresses: [],
  domains: [],
  currentAddressId: null,
  setup: null,
  unread: 0,
  lockMode: 'totp', // what the top padlock asks for: 'totp' | 'password'
};

const BASE = ''; // same-origin

// ---------- the global progress bar ----------
// any request that runs longer than a blink paints a thin living bar at the
// very top of the page — nobody ever stares at a silent screen again
let inflight = 0;
let barShowT = null;
let barEl = null;

function progressStart() {
  inflight++;
  if (barShowT || barEl) return;
  barShowT = setTimeout(() => {
    barShowT = null;
    if (barEl) return;
    barEl = document.createElement('div');
    barEl.className = 'loadbar';
    barEl.setAttribute('aria-hidden', 'true');
    barEl.innerHTML = '<i></i>';
    document.body.append(barEl);
    requestAnimationFrame(() => barEl?.classList.add('is-on'));
  }, 280);
}

function progressEnd() {
  inflight = Math.max(0, inflight - 1);
  if (inflight > 0) return;
  if (barShowT) { clearTimeout(barShowT); barShowT = null; return; }
  if (barEl) {
    const b = barEl;
    barEl = null;
    b.classList.remove('is-on');
    b.classList.add('is-done');
    setTimeout(() => b.remove(), 420);
  }
}

async function request(method, path, body, opts = {}) {
  progressStart();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      ...opts,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (res.status === 401 && !path.startsWith('/api/auth') && !path.startsWith('/api/setup')) {
      // session died
      window.dispatchEvent(new CustomEvent('cmail:unauthorized'));
    }
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.code = data?.error || 'http_error';
      err.detail = data?.detail;
      throw err;
    }
    return data;
  } finally {
    progressEnd();
  }
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

export function errText(e) {
  const map = {
    invalid_credentials: 'invalidCredentials',
    weak_password: 'weakPassword',
    invalid_username: 'invalidUsername',
    address_taken: 'addressTaken',
    invalid_local_part: 'invalidLocal',
    invalid_domain: 'invalidDomain',
    address_limit: 'addrLimit',
    rate_limited: 'rateLimited',
    invalid_secret: 'invalidSecret',
    invalid_uri: 'invalidUri',
    invalid_code: 'totpBadCode',
    pending_expired: 'totpPendingExpired',
    totp_enabled: 'totpAlreadyOn',
    not_found: 'error',
    name_required: 'nameRequired',
    sending_not_configured: 'sendingNotConfigured',
    empty_body: 'emptyBody',
    invalid_recipient: 'invalidRecipient',
    invalid_sender: 'invalidSender',
    cannot_delete_self: 'cannotDeleteSelf',
    domain_not_ready: 'errDomainNotReady',
    forbidden: 'forbidden',
    totp_not_enabled: 'totpNotEnabled',
    device_limit: 'deviceLimit',
    tables_missing: 'setupNeedDbToast',
  };
  return map[e?.code] ? t(map[e.code]) : (e?.detail ? `${t('error')} — ${e.detail}` : t('error'));
}
