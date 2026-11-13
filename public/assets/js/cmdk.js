// Cmail — Command Palette (⌘K) · quick launcher
// search across navigation, actions, inboxes and live email results
import { api, state } from './api.js';
import { t, setLang, lang } from './i18n.js';
import { h, clear, icon, toast, vibrate } from './ui.js';
import { setTheme, setAccent, switchAccount } from './app.js';
import { openCompose, createAddressModal } from './views/mail.js';

let back = null;
let input = null;
let listEl = null;
let items = [];            // flat list of selectable rows
let activeIdx = 0;
let emailT = null;
let lastQuery = '';

// ---------- public ----------
export function openCmdk() {
  if (back) { input?.focus(); return; }
  vibrate(6);
  back = h('div', { class: 'cmdk-back', onclick: (e) => { if (e.target === back) closeCmdk(); } });
  const panel = h('div', { class: 'cmdk glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('cmdkPlaceholder') });

  input = h('input', {
    type: 'text', placeholder: t('cmdkPlaceholder'), autocomplete: 'off', spellcheck: 'false',
    oninput: () => { render(); scheduleEmails(); },
  });
  const esc = h('button', { class: 'cmdk__esc', onclick: () => closeCmdk() }, t('cmdkClose'));
  panel.append(
    h('div', { class: 'cmdk__in' }, icon('search'), input, esc),
    listEl = h('div', { class: 'cmdk__list', role: 'listbox' }),
    h('div', { class: 'cmdk__foot' },
      navHint(t('cmdkNavHint')), hint('Enter', t('cmdkOpen')), hint('esc', t('cmdkClose'))),
  );
  back.append(panel);
  document.body.append(back);
  setTimeout(() => input.focus(), 40);
  render();

  back.addEventListener('keydown', onKey);
  // trap: palette handles its own keys while open
  document.addEventListener('keydown', cmdkGlobalKey, true);
}

export function cmdkIsOpen() { return !!back; }

// route parent-document keys into the palette (iframe shell)
export function cmdkKey(e) {
  if (!back) return false;
  if (e.key === 'Escape') { closeCmdk(); return true; }
  if (e.key === 'ArrowDown') { move(1); return true; }
  if (e.key === 'ArrowUp') { move(-1); return true; }
  if (e.key === 'Enter') { runActive(); return true; }
  return false;
}

export function closeCmdk() {
  if (!back) return;
  back.remove();
  back = null; input = null; listEl = null; items = []; lastQuery = '';
  document.removeEventListener('keydown', cmdkGlobalKey, true);
}

function cmdkGlobalKey(e) {
  if (!back) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCmdk(); }
}

function hint(key, label) {
  return h('span', {}, h('kbd', { class: 'kbd' }, key), label);
}
// the ↑↓ pair the old foot drew as text glyphs — those are exactly the
// characters several device fonts turn into tofu boxes; two crisp SVG
// chevrons can never fail
function navHint(label) {
  return h('span', { class: 'cmdk__navhint' },
    h('kbd', { class: 'kbd kbd--icn' }, icon('chevron', 'flip-v')),
    h('kbd', { class: 'kbd kbd--icn' }, icon('chevron')),
    label);
}

// ---------- sources ----------
function buildSources(q) {
  const s = [];
  const query = q.trim().toLowerCase();
  const match = (txt) => !query || String(txt ?? '').toLowerCase().includes(query);
  const rank = (txt) => {
    const x = String(txt ?? '').toLowerCase();
    if (!query) return 2;
    if (x.startsWith(query)) return 0;
    if (x.includes(query)) return 1;
    return -1;
  };

  // --- navigation (auth-aware) ---
  const ready = !!state.setup?.ready;
  const isShare = state.user?.role === 'share';
  const navs = [];
  if (!ready) {
    navs.push({ icn: 'spark', label: t('navStatus'), run: () => { location.hash = '#/status?stay'; } });
    navs.push({ icn: 'user', label: t('login'), run: () => { location.hash = '#/login'; } });
  } else if (isShare) {
    // the guest's palette holds only the rooms its credential grants —
    // addresses, settings and domains simply do not exist here
    navs.push(
      { icn: 'inbox', label: t('navMail'), run: () => { location.hash = '#/mail'; } },
      { icn: 'key', label: t('navVault'), run: () => { location.hash = '#/vault'; } },
      { icn: 'help', label: t('navHelp'), run: () => { location.hash = '#/help'; } },
      { icn: 'heart', label: t('navAbout'), run: () => { location.hash = '#/about'; } },
    );
  } else {
    navs.push(
      { icn: 'inbox', label: t('navMail'), run: () => { location.hash = '#/mail'; } },
      { icn: 'mail', label: t('navAddresses'), run: () => { location.hash = '#/addresses'; } },
      { icn: 'key', label: t('navVault'), run: () => { location.hash = '#/vault'; } },
      { icn: 'help', label: t('navHelp'), run: () => { location.hash = '#/help'; } },
      { icn: 'heart', label: t('navAbout'), run: () => { location.hash = '#/about'; } },
      { icn: 'settings', label: t('navSettings'), run: () => { location.hash = '#/settings'; } },
    );
    if (state.user?.role === 'admin') {
      navs.push(
        { icn: 'globe', label: t('navDomains'), run: () => { location.hash = '#/domains'; } },
        { icn: 'spark', label: t('navStatus'), run: () => { location.hash = '#/status?stay'; } },
      );
    }
  }
  const navHits = navs.filter((n) => rank(n.label) >= 0).sort((a, b) => rank(a.label) - rank(b.label));
  if (navHits.length) s.push({ title: t('cmdkNav'), items: navHits });

  // --- actions ---
  const acts = [];
  const canCompose = !!state.user && (!state.user.share || (state.user.share.perms || []).includes('compose'));
  if (state.user) {
    if (state.setup?.sending_ready !== false && canCompose) {
      acts.push({ icn: 'send', label: t('cmdkCompose'), kw: 'compose new mail', run: () => openCompose() });
    }
    if (!isShare) acts.push(
      { icn: 'plus', label: t('cmdkNewAlias'), kw: 'alias inbox address create', run: () => createAddressModal(() => window.dispatchEvent(new CustomEvent('cmail:refresh-mail'))) },
    );
    acts.push(
      { icn: 'refresh', label: t('refresh'), kw: 'reload inbox sync', run: () => { window.dispatchEvent(new CustomEvent('cmail:refresh-mail')); toast(t('refresh'), 'ok', 1200); } },
    );
  }
  acts.push(
    { icn: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', label: t('cmdkTheme'), kw: 'dark light theme appearance', run: () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); } },
    { icn: 'globe', label: t('cmdkLang'), kw: 'language fa en persian english', run: () => { setLang(lang === 'fa' ? 'en' : 'fa'); window.dispatchEvent(new CustomEvent('cmail:rerender')); } },
  );
  if (state.user) acts.push({ icn: 'logout', label: t('logout'), kw: 'sign out exit', run: doLogout });
  const actHits = acts.filter((a) => rank(a.label) >= 0 || match(a.kw)).sort((a, b) => rank(a.label) - rank(b.label));
  if (actHits.length) s.push({ title: t('cmdkActions'), items: actHits });

  // --- accent palettes (only when typing "acc"/"pal"/palette names) ---
  const accents = [['green', 'paletteGreen'], ['blue', 'paletteBlue'], ['purple', 'palettePurple'], ['amber', 'paletteAmber']];
  const accHits = accents
    .map(([key, lk]) => ({ key, label: t(lk), kw: 'accent color palette theme' }))
    .filter((a) => query && (rank(a.label) >= 0 || /acc|pal|رنگ|پالت/.test(query)));
  if (accHits.length) s.push({
    title: t('palette'), items: accHits.map((a) => ({
      icn: 'palette2', label: a.label, swatch: a.key, run: () => {
        setAccent(a.key);
        toast(t('saved'), 'ok', 1100);
      },
    })),
  });

  // --- inboxes — every mailbox is its own account space ---
  if (state.user && state.addresses.length) {
    const inb = state.addresses
      .filter((a) => rank(a.address) >= 0 || match(a.label))
      .sort((a, b) => rank(a.address) - rank(b.address))
      .map((a) => ({
        icn: a.kind === 'temp' ? 'clock' : 'mail',
        label: a.address, sub: a.kind === 'temp' ? t('temporary') : t('permanent'),
        // switching funnels through the one account switcher (the avatar
        // circle) so every surface stays in sync
        run: () => switchAccount(a.id),
      }));
    if (inb.length) s.push({ title: t('cmdkInboxes'), items: inb });
  }
  return s;
}

async function doLogout() {
  await api.post('/api/auth/logout').catch(() => {});
  state.user = null;
  location.hash = '#/login';
}

// ---------- live email search ----------
function scheduleEmails() {
  clearTimeout(emailT);
  emailT = setTimeout(fetchEmailResults, 220);
}

async function fetchEmailResults() {
  if (!back || !state.user) return;
  const q = input.value.trim();
  if (q.length < 2) { lastQuery = ''; render(true); return; }
  try {
    const r = await api.get(`/api/emails?limit=6&q=${encodeURIComponent(q)}`);
    if (!back || input.value.trim() !== q) return; // stale
    lastQuery = q;
    const hits = (r.emails ?? []).map((em) => ({
      icn: 'mail',
      label: em.subject || '(no subject)',
      sub: `${em.from_name || em.from_addr} · ${em.preview || ''}`.slice(0, 70),
      run: () => { location.hash = `#/mail/${em.id}`; },
    }));
    render(false, hits.length ? [{ title: t('cmdkMail'), items: hits }] : []);
  } catch { /* silent */ }
}

// ---------- rendering ----------
function render(keepEmails = false, emailGroups = null) {
  if (!back || !listEl) return;
  const q = input.value;
  const statics = buildSources(q);
  const groups = keepEmails && lastQuery === q ? currentEmailGroups : statics.concat(emailGroups ?? []);
  if (!keepEmails) currentEmailGroups = [];
  if (emailGroups) currentEmailGroups = emailGroups;

  clear(listEl);
  items = [];
  let firstOverall = true;
  let any = false;

  for (const g of groups) {
    if (!g.items.length) continue;
    any = true;
    listEl.append(h('div', { class: 'cmdk__group' }, g.title));
    for (const it of g.items) {
      const idx = items.length;
      const row = h('button', {
        class: `cmdk__item ${firstOverall ? 'is-active' : ''}`,
        role: 'option',
        onmouseenter: () => setActive(idx),
        onclick: () => { vibrate(6); closeCmdk(); it.run(); },
      },
        it.swatch ? h('span', { class: `cmdk__sw cmdk__sw--${it.swatch}` }) : icon(it.icn),
        h('span', { class: 'cmdk__label' }, it.label),
        it.sub ? h('span', { class: 'cmdk__sub' }, it.sub) : '',
        firstOverall ? h('span', { class: 'cmdk__enter' }, icon('arrow')) : '');
      row.dataset.idx = String(idx);
      listEl.append(row);
      items.push(it);
      firstOverall = false;
    }
  }
  if (!any) listEl.append(h('div', { class: 'cmdk__none' }, icon('search'), t('cmdkNone')));
  activeIdx = 0;
}

let currentEmailGroups = [];

function setActive(idx) {
  activeIdx = idx;
  listEl?.querySelectorAll('.cmdk__item').forEach((el) => {
    const on = Number(el.dataset.idx) === idx;
    el.classList.toggle('is-active', on);
    const ent = el.querySelector('.cmdk__enter');
    if (ent) ent.style.display = on ? '' : 'none';
  });
}

function move(dir) {
  if (!items.length) return;
  const next = (activeIdx + dir + items.length) % items.length;
  setActive(next);
  listEl?.querySelector(`.cmdk__item[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
}

function runActive() {
  const it = items[activeIdx];
  if (!it) return;
  vibrate(6);
  closeCmdk();
  it.run();
}

// ---------- keyboard ----------
function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
}
