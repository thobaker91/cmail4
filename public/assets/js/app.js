// Cmail — app shell: boot, router, floating pill navigation + account switcher
import { api, state, errText } from './api.js';
import { t, setLang, lang } from './i18n.js';
import { h, clear, icon, toast, vibrate, avatarColor, closeAllOverlays, confirmBox, copyText } from './ui.js';
import * as island from './island.js';
import { openCmdk, closeCmdk, cmdkIsOpen, cmdkKey } from './cmdk.js';
import { renderLogin } from './views/auth.js';
import { renderGate } from './views/gate.js';
import { renderMail, createAddressModal } from './views/mail.js';
import { renderAddresses } from './views/addresses.js';
import { renderVault } from './views/vault.js';
import { renderDomains } from './views/domains.js';
import { renderSettings } from './views/settings.js';
import { renderAbout } from './views/about.js';
import { renderHelp } from './views/help.js';
import { renderInto as renderAlerts } from './health.js';
import { lockNow, maybeLock, isLocked } from './lockscreen.js';

const app = document.getElementById('app');
const pillbar = document.getElementById('pillbar');
const pbNav = document.getElementById('pb-nav');
const pbEnd = document.getElementById('pb-end');
const pbVer = document.getElementById('pb-ver');
const tabbar = document.getElementById('tabbar');
const tabbarIn = document.getElementById('tabbar-in');

// ---------- routing ----------
const routes = {
  mail: renderMail,
  addresses: renderAddresses,
  vault: renderVault,
  domains: renderDomains,
  settings: renderSettings,
  about: renderAbout,
  help: renderHelp,
  login: renderLogin,
  status: renderGate,
};

export function nav(hash) { location.hash = hash; }

function currentRoute() {
  const raw = (location.hash || '').replace(/^#\//, '').split('?')[0];
  const [page, ...rest] = raw.split('/');
  return { page: page || '', arg: rest.join('/') };
}

// every navigation gets a token — when the user clicks two pages in quick
// succession only the newest render may touch the screen; the stale one
// bails at its next await instead of painting two sections at once
let routeSeq = 0;

async function route() {
  const seq = ++routeSeq;
  const { page } = currentRoute();
  const stale = () => seq !== routeSeq;

  // a new page never inherits the old page's floating layers: open dialogs
  // (and their Escape handlers), menus and popovers all retire here — an
  // open dialog used to survive navigation and haunt the next page
  closeAllOverlays();
  if (cmdkIsOpen()) closeCmdk();

  // fetch system status (may be offline); always fresh on gate entry
  if (!state.setup || page === 'status' || page === 'login') {
    try { state.setup = await api.get('/api/setup/status'); }
    catch { if (!state.setup) state.setup = null; }
    if (stale()) return;
    // the status endpoint self-heals the single user's admin role — pick up
    // the fresh role right away so admin surfaces unlock without a re-login
    if (state.setup && state.user) {
      try { const me = await api.get('/api/auth/me'); if (me?.user) state.user = me.user; } catch { /* */ }
      if (stale()) return;
    }
  }
  const ready = !!state.setup?.ready;

  // GATE — the main app stays closed until every prerequisite is connected.
  // A fresh install lands on the setup screen itself: the D1 step comes
  // before the username form. Once the tables exist, the sign-in page is
  // reachable normally and the gate handles the remaining steps (domain…).
  if (!ready) {
    // an UNKNOWN status (status fetch failed / worker cold-start hiccup) is
    // setup-pending too: a fresh visitor must never meet a credential form
    // before the system state is known — the gate (with its own offline
    // panel and retry) is the only honest answer in that case
    const dbPending = !state.setup || !state.setup.tables;
    const allowed = page === 'status' || (page === 'login' && !dbPending);
    if (!allowed) { location.hash = '#/status'; return; }
  } else if (page === 'status' && !location.hash.includes('stay')) {
    location.hash = state.user ? '#/mail' : '#/login'; return;
  }

  const needsAuth = page !== 'login' && page !== 'status';
  if (needsAuth && !state.user) { location.hash = '#/login'; return; }
  if (page === 'login' && state.user) { location.hash = ready ? '#/mail' : '#/status'; return; }

  // a locked panel stays locked — the overlay covers every page until the
  // credential the owner chose (or a full sign-out) answers
  maybeLock();

  const authView = page === 'login' || page === 'status';
  renderShell(page, authView);
  if (stale()) return;
  clear(app);
  window.scrollTo({ top: 0 });

  // a share guest gets no admin alerts — its own island lives above the page
  const alertHost = document.getElementById('sysalert');
  if (alertHost) {
    if (!authView && state.user?.role === 'admin') {
      await renderAlerts(alertHost);
      if (stale()) return;
      document.body.classList.toggle('has-alert', !alertHost.hidden && alertHost.children.length > 0);
    } else if (!authView && state.user?.role === 'share') {
      // the Dynamic Island floats fixed above the content — no banner, no
      // padding shift, the page keeps its full height
      alertHost.hidden = true; clear(alertHost);
      document.body.classList.remove('has-alert');
      renderShareIsland();
    } else {
      alertHost.hidden = true; clear(alertHost);
      document.body.classList.remove('has-alert');
      removeShareIsland();
    }
  }

  // a guest may only stand in the rooms its credential grants: mail, the
  // synced vault, help and about — every other URL folds back into the mail
  if (state.user?.role === 'share' && page && !['mail', 'vault', 'help', 'about'].includes(page)) {
    location.hash = '#/mail'; return;
  }

  if (authView) {
    app.className = 'view view--auth';
    if (page === 'login') return renderLogin(app);
    return renderGate(app);
  }

  // an address that leads nowhere gets an honest page — the old behavior
  // silently rendered the inbox under any unknown URL
  if (!routes[page] && page) {
    app.className = 'view';
    render404(app);
    return;
  }

  app.className = 'view';
  const view = routes[page] ?? renderMail;
  try {
    await view(app, currentRoute().arg);
  } catch (e) {
    if (stale()) return;
    if (e.code === 'unauthorized') return;
    toast(errText(e), 'err');
    app.append(h('div', { class: 'empty' }, h('div', { class: 'empty__t' }, t('error')), h('div', { class: 'empty__d' }, e.message ?? '')));
  }
  if (!stale()) slideGlider();
}

// ---------- 404 — the page that admits the URL went nowhere ----------
function render404(root) {
  const el = h('div', { class: 'nf404' },
    h('div', { class: 'illus-plate' }, h('img', { src: 'assets/img/p404.webp', alt: '', width: '720', height: '720', decoding: 'async' })),
    h('h2', { class: 'nf404__t' }, t('nf404Title')),
    h('p', { class: 'nf404__d' }, t('nf404D')),
    h('button', { class: 'btn btn--primary', onclick: () => { location.hash = state.user ? '#/mail' : '#/login'; } }, icon('inbox'), t('nf404Home')));
  root.append(el);
}

// ---------- shell: floating pill navigation + mobile tabbar ----------
function navItems() {
  // a share guest lives inside its shared mailboxes — mail, vault (the synced
  // 2FA codes of those very accounts) and help are the whole world
  if (state.user?.role === 'share') {
    return [
      { key: 'mail', icon: 'inbox', label: t('navMail'), href: '#/mail' },
      { key: 'vault', icon: 'key', label: t('navVault'), href: '#/vault' },
      { key: 'help', icon: 'help', label: t('navHelp'), href: '#/help' },
    ];
  }
  const items = [
    { key: 'mail', icon: 'inbox', label: t('navMail'), href: '#/mail' },
    { key: 'addresses', icon: 'mail', label: t('navAddresses'), href: '#/addresses' },
    { key: 'vault', icon: 'key', label: t('navVault'), href: '#/vault' },
    { key: 'help', icon: 'help', label: t('navHelp'), href: '#/help' },
  ];
  return items;
}

function tabItems() {
  if (state.user?.role === 'share') {
    return [
      { key: 'mail', icon: 'inbox', label: t('navMail') },
      { key: 'vault', icon: 'key', label: t('navVault') },
      { key: 'help', icon: 'help', label: t('navHelp') },
      { key: 'about', icon: 'heart', label: t('navAbout') },
    ];
  }
  return [
    { key: 'mail', icon: 'inbox', label: t('navMail') },
    { key: 'addresses', icon: 'mail', label: t('navAddresses') },
    { key: 'vault', icon: 'key', label: t('navVault') },
    { key: 'about', icon: 'heart', label: t('navAbout') },
    { key: 'settings', icon: 'settings', label: t('navSettings') },
  ];
}

function renderShell(page, authView) {
  [pillbar, tabbar].forEach((el) => { el.hidden = authView; });
  document.body.classList.toggle('is-auth', authView);
  if (authView) return;

  // version chip lives on the brand — refresh it from the server status
  if (pbVer && state.setup?.version) pbVer.textContent = state.setup.version.split('.').slice(0, 2).join('.');

  // ----- page pills -----
  clear(pbNav);
  for (const it of navItems()) {
    pbNav.append(h('a', {
      class: `pill-nav ${page === it.key ? 'is-on' : ''}`,
      href: it.href,
      dataset: { nav: it.key },
    }, icon(it.icon), h('span', {}, it.label), it.key === 'mail' ? h('span', { class: 'badge', id: 'pill-unread', style: { display: state.unread > 0 ? '' : 'none' } }, state.unread > 99 ? '99+' : String(state.unread)) : ''));
  }
  // the glass indicator that glides under the active pill
  pbNav.append(h('span', { class: 'pill-glider', id: 'pill-glider', 'aria-hidden': 'true' }));
  requestAnimationFrame(() => slideGlider(true));

  // ----- end controls: search · theme · language · lock · account -----
  clear(pbEnd);
  pbEnd.append(
    h('button', { class: 'spot-pill', title: t('searchMail'), 'aria-label': t('searchMail'), onclick: () => openCmdk() },
      icon('search'), h('span', { class: 't' }, t('searchMail')), h('kbd', { class: 'kbd' }, isMac() ? '⌘K' : 'Ctrl K')),
    h('span', { class: 'pillbar__sep' }),
    h('button', { class: 'icon-btn', title: t('theme'), 'aria-label': t('theme'), onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')),
    h('button', { class: 'icon-btn', title: t('language'), 'aria-label': t('language'), onclick: () => { setLang(lang === 'fa' ? 'en' : 'fa'); route(); } }, icon('globe')),
  );
  // the padlock that really locks the panel — visible for the owner when the
  // second factor is on (default mode) or whenever the password mode is picked
  refreshLockBadge();
  const userWrap = h('div', { style: { position: 'relative', display: 'inline-flex' } });
  userWrap.append(h('button', { class: 'avatar', id: 'acct-avatar', 'aria-label': t('account'), title: t('account'), onclick: (e) => { e.stopPropagation(); openSwitcher(userWrap); } }, activeAvatarLetter()));
  pbEnd.append(userWrap);

  // ----- mobile tabbar -----
  clear(tabbarIn);
  for (const it of tabItems()) {
    tabbarIn.append(h('a', {
      class: `tab ${page === it.key ? 'is-on' : ''}`,
      href: `#/${it.key}`,
      dataset: { tab: it.key },
    }, icon(it.icon), h('span', {}, it.label), it.key === 'mail' ? h('span', { class: 'badge', id: 'tab-unread', style: { display: state.unread > 0 ? '' : 'none' } }, state.unread > 99 ? '99+' : String(state.unread)) : ''));
  }
}

function isMac() { return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent); }

// ---------- the padlock at the top — a real lock ----------
function lockBadgeBtn() {
  const pw = state.lockMode === 'password';
  return h('button', {
    class: 'icon-btn lock-badge', id: 'lock-badge',
    title: pw ? t('lockBadgePw') : t('lockBadgeTotp'),
    'aria-label': pw ? t('lockBadgePw') : t('lockBadgeTotp'),
    onclick: () => {
      vibrate(6);
      // before locking, say plainly what will be asked on the way back in
      confirmBox(pw ? t('lockConfirmPw') : t('lockConfirmTotp'), () => lockNow(), false);
    },
  }, icon('lockMode'));
}
// the padlock shows for the owner when 2FA is on (totp mode) — or always,
// once the owner picks the password mode in Settings → Security
export function refreshLockBadge() {
  const existing = document.getElementById('lock-badge');
  const show = !!state.user && state.user.role !== 'share'
    && (!!state.user.totp_enabled || state.lockMode === 'password');
  if (show && !existing && !pillbar.hidden && state.user) pbEnd.append(lockBadgeBtn());
  if (!show && existing) existing.remove();
}
// kept for the 2FA enable/disable flows in Settings
export function updateLockBadge(_on) { refreshLockBadge(); }

// ---------- the share island — the guest's Dynamic Island ----------
// The old banner pushed the whole page down and talked too much. Now: one
// compact floating pill in the Apple Dynamic Island spirit — icon, mailbox
// summary, a live countdown and a single "?" that morphs it open. The
// details are the essentials and nothing else: which mailboxes, how much
// time is left, the admin's note when there is one, and the way out.
let shareTick = null;
let shareIslandEl = null;
let shareIslandSig = '';

function dhms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return lang === 'fa'
    ? `${d ? d + ' روز و ' : ''}${h}:${m}:${ss}`
    : `${d ? d + 'd ' : ''}${h}:${m}:${ss}`;
}

export function removeShareIsland() {
  if (shareTick) { clearInterval(shareTick); shareTick = null; }
  if (shareIslandEl) { shareIslandEl.remove(); shareIslandEl = null; }
  shareIslandSig = '';
}

function shareIslandLogout() {
  removeShareIsland();
  return api.post('/api/auth/logout').catch(() => { })
    .then(() => { state.user = null; nav('/login'); });
}

// the window closed under the guest's feet — say it plainly, then out
function shareExpired() {
  if (!state.user || state.user.role !== 'share') return;
  removeShareIsland();
  state.user = null;
  toast(t('shareEnded'), 'err', 4200);
  location.hash = '#/login';
}

function renderShareIsland() {
  const sh = state.user?.share;
  // nothing changed since the last draw — the island never repaints itself
  // out from under a tap (the 20s keepalive runs this check constantly).
  // the language rides in the signature: switching fa↔en redraws the words
  const sig = JSON.stringify(sh ?? null) + '|' + lang;
  if (!sh) { removeShareIsland(); return; }
  if (shareIslandEl && sig === shareIslandSig) return;
  removeShareIsland();
  shareIslandSig = sig;

  const shAddrs = (sh.addresses?.length ? sh.addresses : [sh.address]).filter(Boolean);
  const localPart = (a) => String(a ?? '').split('@')[0] || a;

  // two clocks, one number: the pill wears the countdown, the open details
  // label it — both breathe from the same tick
  const cd = h('span', { class: 'sisland__cd mono' }, '—');
  const cd2 = h('b', { class: 'mono' }, '—');
  const setCd = (v) => { cd.textContent = v; cd2.textContent = v; };

  const pill = h('button', {
    class: 'sisland__pill', 'aria-expanded': 'false', 'aria-label': t('shareIslandTitle'),
    onclick: () => {
      const open = el.classList.toggle('is-open');
      pill.setAttribute('aria-expanded', String(open));
      clear(qBtn).append(icon(open ? 'x' : 'help'));
      vibrate(open ? 8 : 5);
    },
  },
    h('span', { class: 'sisland__icn' }, icon('users')),
    h('span', { class: 'sisland__label' },
      shAddrs.length === 1 ? localPart(shAddrs[0]) : t('shareIslandCount').replace('{n}', lang === 'fa' ? faDig(shAddrs.length) : String(shAddrs.length))),
    h('span', { class: 'sisland__clock' }, icon('clock'), cd),
    h('span', { class: 'sisland__q', 'aria-hidden': 'true' }, icon('help')));

  // the details: the mailboxes (tap = copy), the labeled time, the admin's
  // note when one exists — and nothing else
  const boxes = h('div', { class: 'sisland__boxes' },
    shAddrs.map((a) => h('button', {
      class: 'sisland__box', title: t('copy'),
      onclick: async () => { await copyText(a); toast(t('copied'), 'ok', 1300); },
    },
      h('span', { class: 'sisland__box-icn' }, icon('mail')),
      h('span', { class: 'mono' }, a),
      h('span', { class: 'sisland__box-copy' }, icon('copy')))));

  const body = h('div', { class: 'sisland__body' },
    h('div', { class: 'sisland__in' },
      h('div', { class: 'sisland__row' }, icon('clock'), h('span', {}, `${t('shareFrozenLeft')}: `), cd2),
      boxes,
      sh.note ? h('div', { class: 'sisland__note' }, icon('note'), h('span', {}, sh.note)) : '',
      h('div', { class: 'sisland__acts' },
        h('button', { class: 'btn btn--sm btn--danger-ghost', onclick: shareIslandLogout }, icon('logout'), t('logout')))));

  const qBtn = pill.querySelector('.sisland__q');
  const el = h('div', { class: 'sisland', id: 'share-island' }, pill, body);
  document.body.append(el);
  shareIslandEl = el;

  // a FROZEN countdown stands still at frozen_at — no burning, no logout,
  // the honest number the admin froze; no expiry at all says so in a word
  const frozenLeft = sh.time_frozen && sh.frozen_at && sh.expires_at
    ? Math.max(0, Number(sh.expires_at) - Number(sh.frozen_at))
    : null;
  if (frozenLeft !== null) { setCd(dhms(frozenLeft)); return; }
  if (!sh.expires_at) { setCd(t('shareNoLimit')); return; }
  const tick = () => {
    const left = (sh.expires_at ?? 0) - Date.now();
    if (left <= 0) {
      if (shareTick) { clearInterval(shareTick); shareTick = null; }
      shareExpired();
      return;
    }
    setCd(dhms(left));
  };
  tick();
  shareTick = window.setInterval(tick, 1000);
}

const FA_DIGITS_ISLAND = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
function faDig(n) { return String(n).replace(/\d/g, (d) => FA_DIGITS_ISLAND[+d]); }

// ---------- the gliding glass indicator ----------
// one pill of frosted glass lives under the nav; picking a page makes it
// slide across — soft, glassy, animated, exactly the feel of the big clients
let gliderPlaced = false;
export function slideGlider(instant = false) {
  const g = document.getElementById('pill-glider');
  if (!g) return;
  const on = pbNav.querySelector('.pill-nav.is-on');
  if (!on) { g.style.opacity = '0'; return; }
  g.style.opacity = '1';
  g.style.width = `${on.offsetWidth}px`;
  g.style.transform = `translateX(${on.offsetLeft}px)`;
  if (instant) {
    g.style.transition = 'none';
    void g.offsetWidth;
    g.style.transition = '';
  }
  gliderPlaced = true;
}
window.addEventListener('resize', () => { if (gliderPlaced) slideGlider(true); });
document.fonts?.ready?.then(() => slideGlider(true));

// ---------- account switcher — every mailbox is its own account ----------
// The circle at the top works exactly like the big clients: open it, glance
// at the tiny details of every account (mail count, unread, 2FA codes),
// jump into one, add another — never leaving the page you were on.
let acctCache = null;
let acctCacheAt = 0;
let acctMenuEl = null;

function activeAccount() {
  const list = state.addresses ?? [];
  return list.find((a) => a.id === state.currentAddressId) ?? null;
}

function activeAvatarLetter() {
  const a = activeAccount();
  return (a ? (a.label || a.address) : (state.user?.username ?? '?')).slice(0, 1).toUpperCase();
}

export async function switchAccount(id) {
  closeSwitcher();
  const changed = state.currentAddressId !== id;
  state.currentAddressId = id;
  localStorage.setItem('cmail_acct', id ?? '');
  vibrate(6);
  if (changed) {
    state.unread = (state.addresses ?? []).find((a) => a.id === id)?.unread ?? state.unread;
    updateUnreadBadge();
  }
  // repaint the avatar letter, then land on the mail space of that account
  const av = document.getElementById('acct-avatar');
  if (av) av.textContent = activeAvatarLetter();
  const { page } = currentRoute();
  if (page === 'mail') route();
  else location.hash = '#/mail';
}

async function accountsData() {
  if (acctCache && Date.now() - acctCacheAt < 30_000) return acctCache;
  try {
    const [ar, tr] = await Promise.all([
      api.get('/api/addresses'),
      api.get('/api/totp').catch(() => ({ entries: [] })),
    ]);
    state.addresses = ar.addresses ?? [];
    const codes = {};
    for (const e of (tr.entries ?? [])) {
      if (!e.address_id) continue;
      codes[e.address_id] = (codes[e.address_id] ?? 0) + 1;
    }
    acctCache = { list: state.addresses, codes };
    acctCacheAt = Date.now();
  } catch { return { list: state.addresses ?? [], codes: {} }; }
  return acctCache;
}

export function invalidateAccounts() { acctCache = null; acctCacheAt = 0; }

async function openSwitcher(anchor) {
  if (acctMenuEl) { closeSwitcher(); return; }
  vibrate(5);
  const menu = h('div', { class: 'acct-menu', role: 'menu', 'aria-label': t('account') });
  acctMenuEl = menu;

  // ----- header: who is signed in + which account is live -----
  const active = activeAccount();
  const head = h('div', { class: 'acct-menu__head' },
    h('span', { class: 'avatar', style: { background: active ? avatarColor(active.address) : 'var(--acc)' } }, activeAvatarLetter()),
    h('div', { class: 'acct-menu__id' },
      h('div', { class: 'acct-menu__name' }, state.user?.display_name || state.user?.username || '—'),
      h('div', { class: 'acct-menu__sub' },
        h('span', {}, state.user?.role === 'admin' ? t('roleAdmin') : t('roleMember')),
        active ? h('span', { class: 'mono', style: { fontSize: '10.5px' } }, active.address) : '')));
  menu.append(head);

  // ----- account rows (filled once the stats land) -----
  const label = h('div', { class: 'acct-menu__label' }, t('yourAccounts'));
  const listBox = h('div', { class: 'acct-menu__list' });
  menu.append(label, listBox);

  // ----- add another account (the owner only — a guest cannot add) -----
  if (state.user?.role !== 'share') {
    menu.append(h('button', { class: 'acct-menu__add', onclick: async () => { closeSwitcher(); await createAddressModal(() => { invalidateAccounts(); route(); }); } },
      icon('plus'), h('span', {}, t('acctNew'))));
  }

  // ----- footer: manage / settings / about / sign out -----
  const isShare = state.user?.role === 'share';
  const foot = h('div', { class: 'acct-menu__foot' });
  const footBtn = (icn, lbl, fn, cls = '') => {
    const b = h('button', { class: cls, onclick: () => { closeSwitcher(); fn(); } }, icon(icn), h('span', {}, lbl));
    return b;
  };
  foot.append(
    isShare ? '' : footBtn('inbox', t('navAddresses'), () => nav('/addresses')),
    state.user?.role === 'admin' ? footBtn('globe', t('navDomains'), () => nav('/domains')) : '',
    isShare ? '' : footBtn('settings', t('navSettings'), () => nav('/settings')),
    footBtn('heart', t('navAbout'), () => nav('/about')),
    footBtn('logout', t('logout'), async () => { await api.post('/api/auth/logout').catch(() => {}); state.user = null; nav('/login'); }, 'is-danger'),
  );
  menu.append(foot);

  document.body.append(menu);

  // ----- position under the avatar circle, clamped to the viewport -----
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const top = Math.min(r.bottom + 10, window.innerHeight - mh - 10);
    menu.style.top = `${Math.max(10, top)}px`;
    if (document.documentElement.dir === 'rtl') {
      menu.style.left = `${Math.max(9, Math.min(r.left, window.innerWidth - mw - 9))}px`;
      menu.style.right = 'auto';
    } else {
      menu.style.right = `${Math.max(9, Math.min(window.innerWidth - r.right, window.innerWidth - mw - 9))}px`;
      menu.style.left = 'auto';
    }
  };
  place();
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeSwitcher(); };
  setTimeout(() => document.addEventListener('click', off), 0);
  window.addEventListener('resize', closeSwitcher, { once: true });

  // ----- fill the rows with the live per-account details -----
  const { list, codes } = await accountsData();
  if (acctMenuEl !== menu) return; // closed while loading
  clear(listBox);
  if (!list.length) {
    listBox.append(h('div', { class: 'small muted', style: { padding: '10px 12px 14px', textAlign: 'center' } }, t('noAccountsYet')));
    label.style.display = 'none';
  } else {
    label.style.display = '';
    for (const a of list) {
      const isActive = a.id === state.currentAddressId;
      const nCodes = codes[a.id] ?? 0;
      const row = h('button', {
        class: `acct-row ${isActive ? 'is-on' : ''}`,
        onclick: () => switchAccount(a.id),
      },
        h('span', { class: 'acct-row__ava', style: { background: avatarColor(a.address) } }, (a.label || a.address).slice(0, 1).toUpperCase()),
        h('span', { class: 'acct-row__body' },
          h('span', { class: 'acct-row__addr' }, a.address),
          h('span', { class: 'acct-row__meta' },
            h('span', {}, icon('mail'), h('b', {}, String(a.total ?? 0)), ' ' + t('acctMails')),
            h('span', {}, icon('key'), h('b', {}, String(nCodes)), ' ' + t('acctCodes')))),
        h('span', { class: 'acct-row__end' },
          a.unread > 0 ? h('span', { class: 'acct-row__badge' }, a.unread > 99 ? '99+' : String(a.unread)) : '',
          isActive ? h('span', { class: 'acct-row__check' }, icon('check')) : ''));
      listBox.append(row);
    }
  }
  place();
}

function closeSwitcher() {
  if (acctMenuEl) { acctMenuEl.remove(); acctMenuEl = null; }
}

// ---------- theme & accent ----------
// twelve palettes, each named after its actual color
const MOOD_META = {
  green: { dark: '#161c17', light: '#f3f6ef' },
  blue: { dark: '#131b21', light: '#eff4f6' },
  purple: { dark: '#181522', light: '#f4f1f7' },
  amber: { dark: '#1d1812', light: '#f7f3ea' },
  rose: { dark: '#1f1419', light: '#f9f1f4' },
  cyan: { dark: '#101c1b', light: '#eef6f5' },
  orange: { dark: '#1f1712', light: '#f9f3ec' },
  lime: { dark: '#191d10', light: '#f5f8ea' },
  teal: { dark: '#111d18', light: '#eff6f2' },
  indigo: { dark: '#14161f', light: '#f0f1f8' },
  slate: { dark: '#14181c', light: '#f1f4f6' },
  crimson: { dark: '#1f1413', light: '#f9f1f0' },
};

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('cmail_theme', theme);
  const mood = document.documentElement.dataset.accent || 'green';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', (MOOD_META[mood] ?? MOOD_META.green)[theme === 'dark' ? 'dark' : 'light']);
  // refresh icons that depend on theme
  if (!pillbar.hidden) {
    const btn = pbEnd?.querySelector('.icon-btn');
    if (btn) btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon').innerHTML;
  }
}

export function setAccent(accent) {
  document.documentElement.dataset.accent = accent;
  localStorage.setItem('cmail_accent', accent);
  const theme = document.documentElement.dataset.theme || 'dark';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', (MOOD_META[accent] ?? MOOD_META.green)[theme === 'dark' ? 'dark' : 'light']);
}

// the ambient stage behind the whole app: aurora (alive) · halo (still) · pure (flat)
export function setBg(mode) {
  document.documentElement.dataset.bg = mode;
  localStorage.setItem('cmail_bg', mode);
}

// ---------- session keepalive (refresh unread badge + new-mail notify) ----------
setInterval(async () => {
  if (!state.user || pillbar.hidden) return;
  try {
    const r = await api.get('/api/auth/me');
    state.user = r.user;
    if (r.lock_mode) state.lockMode = r.lock_mode;
    // the owner's toolbar may grow or lose the padlock as settings change
    refreshLockBadge();
    // the guest's island rides the freshest share facts — freeze state,
    // mailbox set, expiry — repainting only when something really changed
    if (state.user?.role === 'share') renderShareIsland();
    const last = r.last_email ?? null;
    if (r.unread !== state.unread) {
      const grew = state.unread > 0 && r.unread > state.unread;
      state.unread = r.unread;
      updateUnreadBadge();
      if (grew && last) {
        const seen = sessionStorage.getItem('cmail_seen_mail') ?? '';
        const fresh = last.id !== seen && Date.now() - (last.received_at ?? 0) < 120_000;
        if (fresh) { sessionStorage.setItem('cmail_seen_mail', last.id); island.arrived(last); }
        else toast(t('newMailToast'), 'ok', 3200);
      }
    } else if (last && !sessionStorage.getItem('cmail_seen_mail')) {
      // first poll of the session — the newest mail is old news, mark it seen
      sessionStorage.setItem('cmail_seen_mail', last.id);
    }
  } catch { /* silent */ }
}, 20_000);

export function updateUnreadBadge() {
  const show = state.unread > 0;
  const txt = state.unread > 99 ? '99+' : String(state.unread);
  for (const id of ['pill-unread', 'tab-unread']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = txt;
    el.style.display = show ? '' : 'none';
    if (show) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }
  // the mail pill just grew/shrank — the glass indicator follows it
  requestAnimationFrame(() => slideGlider());
}

// ---------- boot ----------
(async function boot() {
  // one app, one boot — a duplicated module instance (unversioned import
  // graph) used to run the whole shell twice: two hashchange listeners,
  // two routers racing, an inbox that painted into a detached view and
  // sections that opened on top of each other
  if (window.__cmailBooted) return;
  window.__cmailBooted = true;
  setTheme(localStorage.getItem('cmail_theme') ?? 'dark');
  // older builds shipped other accent names — fold everything into the
  // palettes that carry their color's own name
  const LEGACY = {
    sage: 'green', serene: 'blue', violet: 'purple',
    emerald: 'green', ocean: 'blue', midnight: 'blue', ice: 'blue',
    sakura: 'purple', wine: 'purple', coral: 'purple', gold: 'amber',
  };
  const savedAccent = localStorage.getItem('cmail_accent') ?? 'green';
  setAccent(LEGACY[savedAccent] ?? savedAccent);
  document.documentElement.dataset.bg = localStorage.getItem('cmail_bg') ?? 'aurora';
  // scenes are gone — the living color stage is the one and only backdrop
  if (localStorage.getItem('cmail_scene')) localStorage.removeItem('cmail_scene');
  delete document.documentElement.dataset.scene;

  window.addEventListener('cmail:unauthorized', () => {
    const wasShare = state.user?.role === 'share';
    state.user = null;
    if (!location.hash.startsWith('#/login')) {
      // a guest whose credential was revoked/expired gets its own honest line
      toast(wasShare ? t('shareEnded') : t('invalidCredentials'), 'err');
      location.hash = '#/login';
    }
  });
  window.addEventListener('cmail:rerender', () => { if (!location.hash.includes('/status')) route(); });
  window.addEventListener('cmail:unread-changed', (e) => { state.unread = e.detail ?? 0; updateUnreadBadge(); });
  window.addEventListener('hashchange', () => { console.log('[hashchange event]'); closeSwitcher(); route(); });

  // ⌘K / Ctrl+K — command palette · “/” focus mail search
  const kbdHandler = (e) => {
    if (e.key === 'Escape' && acctMenuEl) { closeSwitcher(); return; }
    const t = e.target;
    const typing = t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable);
    const fromOuterDoc = t?.ownerDocument && t.ownerDocument !== document;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); back_open_or_close(); return; }
    if (cmdkIsOpen() && fromOuterDoc && cmdkKey(e)) return;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    // plain keys pressed on the embedding page → forward into the app
    if (fromOuterDoc) {
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true, cancelable: true })); } catch { /* */ }
      return;
    }
    if (e.key === '/' && document.getElementById('email-list')) {
      e.preventDefault();
      document.querySelector('.mail__search')?.focus();
    }
  };
  document.addEventListener('keydown', kbdHandler);
  // also listen on the embedding page so ⌘K works before the iframe is focused
  if (window.parent && window.parent !== window) {
    try { window.parent.document.addEventListener('keydown', kbdHandler); } catch { /* cross-origin */ }
  }
  function back_open_or_close() { if (document.querySelector('.cmdk-back')) closeCmdk(); else openCmdk(); }

  // silent session check
  try {
    const me = await api.get('/api/auth/me');
    state.user = me.user;
    state.unread = me.unread ?? 0;
    if (me.lock_mode) state.lockMode = me.lock_mode;
  } catch { state.user = null; }

  if (!location.hash) location.hash = state.user ? '#/mail' : '#/login';
  await route();
  updateUnreadBadge();
})();
