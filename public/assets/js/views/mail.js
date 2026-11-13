// Cmail — mail view: account-style inboxes / list / dedicated email page
// Each mailbox behaves like its own account: its mail, its notes, its 2FA codes.
// Opening an email navigates to its own page (#/mail/m/:id) — never a popup.
// HTML emails are sanitized and rendered in a height-adaptive sandboxed frame.
import { api, state, errText } from '../api.js';
import { t, lang } from '../i18n.js';
import { h, clear, icon, toast, modal, confirmBox, copyText, timeAgo, esc, avatarColor, fmtBytes, fmtCountdown, vibrate, glyphTile, lockBadge, shareFrozen, shareUnfrozen } from '../ui.js';
import { entryModal, tempGuard, tempAuthorized, grantTempAuth } from './vault.js';
import { invalidateAccounts } from '../app.js';
import * as island from '../island.js';

let box = 'inbox';
let search = '';
let selected = new Set();
let cursorIdx = -1;      // keyboard cursor over the visible list
let lastFirstId = null;  // newest known message (auto-refresh)
let newFlashId = null;   // id to highlight when it just arrived
let selecting = false;   // touch selection mode
let autoT = null;        // inbox auto-refresh timer

let emails = [];
let listScroll = null;
let sidebarScroll = null;
let ovalEl = null;       // the account oval in the list header (name + address + copy)
let barEl = null;        // inbox card toolbar (select-all · refresh · counters)
let barMeta = null;
let bulkBarEl = null;
// the honest numbers the shared-delete guard needs: the mailbox's real total
// (from the newest list pull) and whether the current account is covered by
// an active share (cached a minute — the guard is a courtesy, not a gate)
let lastTotal = 0;
let shareFrozenSeen = false;
let shareMap = null, shareMapAt = 0;

// ---------- shared-mailbox delete guard (v3.0.0) ----------
// an email a guest can see never vanishes silently: when the mailbox is
// handed to an active share, the admin gets the honest warning first — and
// when the deletion would empty the mailbox, the warning names the
// suspension (the share suspends and recovers on the next email; it is
// never deleted behind the admin's back)
async function loadShareMap(force = false) {
  if (state.user?.share) return null;
  if (shareMap && !force && Date.now() - shareMapAt < 60_000) return shareMap;
  try {
    const r = await api.get('/api/share');
    const m = new Map();
    for (const s of (r.shares ?? [])) {
      if (!s.active) continue;
      const ids = (s.address_ids ?? []).map(String).filter(Boolean);
      for (const aid of ids) m.set(aid, { multi: ids.length > 1 });
    }
    shareMap = m; shareMapAt = Date.now();
  } catch { shareMap = shareMap ?? new Map(); shareMapAt = Date.now(); }
  return shareMap;
}
async function confirmEmailDelete(count, addrId, run, plain = false, baseText = '') {
  const map = await loadShareMap();
  const sh = map?.get(String(addrId ?? state.currentAddressId ?? ''));
  if (!sh) { if (plain) confirmBox(baseText || t('confirm'), run); else run(); return; }
  const parts = [];
  if (baseText) parts.push(baseText);
  parts.push(t('delSharedWarn'));
  confirmBox(parts.join(' '), run, true);
}
let statusEl = null;     // slow-load status strip inside the card
let listSeq = 0;         // racing list loads — newest wins
let listLoading = false;
let listError = null;
let slowT = null;        // reveals the status strip only when a load drags on
let folders = [];        // this account's own folders — per-account sorting, never global
let foldersSig = '';     // last painted folder rail — skip repaints when nothing changed
let foldersSeq = 0;      // racing folder loads — newest wins
let listSig = '';        // last painted list signature — silent refreshes skip identical repaints
// the last list each box answered with — reopening a box paints instantly
// from here and lets the network quietly catch up (stale-while-revalidate,
// the way the big clients never make you watch a spinner twice)
const listCache = new Map();

const sendReady = () => state.setup?.sending_ready !== false && !!state.setup?.admin_created;
// permission helper — a share guest may only do what its credential allows;
// the owner always passes
const can = (p) => !state.user?.share || (state.user.share.perms || []).includes(p);

// global cross-module events (command palette → mail)
window.addEventListener('cmail:refresh-mail', () => {
  if (!listScroll?.isConnected) return;
  loadEmails(true);
});

export async function renderMail(root, arg) {
  // a specific email has its own page — route level, like the big clients
  if (arg && arg.startsWith('m/')) return renderReader(root, arg.slice(2));

  box = 'inbox';
  search = '';
  selected.clear();
  cursorIdx = -1;
  lastFirstId = null;
  newFlashId = null;
  selecting = false;

  const view = h('div', { class: 'view view--full' });
  const grid = h('div', { class: 'mail' });
  const scrim = h('div', { class: 'mail__scrim', onclick: () => grid.classList.remove('show-sidebar') });

  const sidebar = buildSidebar();
  const mainCol = buildMain();

  grid.append(sidebar, mainCol, scrim);
  view.append(grid);
  root.append(view);

  // the compose option is always on stage for those who may send: a frozen
  // lock rides beside the paper plane while no sending provider is connected,
  // and it opens into the real composer the moment sending is configured (or
  // just refuses politely, explaining what is missing). A guest without the
  // compose permission never sees the plane at all — not hidden, just gone.
  if (can('compose')) {
    const fab = h('button', { class: `compose-fab ${sendReady() ? '' : 'is-locked'}`, title: sendReady() ? t('compose') : t('sendLockedTitle'), 'aria-label': sendReady() ? t('compose') : t('sendLockedTitle'), onclick: () => sendReady() ? openCompose() : toast(t('sendLockedToast'), 'err') }, icon('send'));
    if (!sendReady()) fab.append(lockBadge('frozen', t('sendLockedTitle')));
    view.append(fab);
  }

  await loadAddresses();

  // auto-refresh: every 10 seconds the inbox pulls
  // the list and the unread badges, highlights whatever just landed, and
  // stays out of the way while an overlay is open
  clearInterval(autoT);
  autoT = setInterval(async () => {
    // the timer only serves THIS render's list — a stale timer from a
    // previous render must never feed the fresh view (rapid-click safety)
    if (!listScroll?.isConnected) { clearInterval(autoT); return; }
    if (document.hidden || document.querySelector('.modal-back, .cmdk-back')) return;
    loadEmails(true);
    loadAddresses(true);
  }, 10_000);
}

// ---------- the current account ----------
let addrSig = '';  // last painted sidebar signature — skip repaints when nothing changed
async function loadAddresses(quiet = false) {
  try {
    const r = await api.get('/api/addresses');
    state.addresses = r.addresses ?? [];
  } catch (e) { if (!quiet) toast(errText(e), 'err'); state.addresses = state.addresses ?? []; }

  // every mailbox is its own space — the active one survives reloads
  const saved = localStorage.getItem('cmail_acct');
  const savedOk = saved && state.addresses.find((a) => a.id === saved);
  if (savedOk) state.currentAddressId = saved;
  else {
    state.currentAddressId = state.addresses[0]?.id ?? null;
    localStorage.setItem('cmail_acct', state.currentAddressId ?? '');
  }

  // repaint the rails only when something actually changed — the auto-refresh
  // must never yank an open dropdown, a focused row or the scroll position
  // out from under the user
  const sig = JSON.stringify([
    state.addresses.map((a) => [a.id, a.kind, a.label, a.unread, a.total, a.expires_at, tempAuthorized(a.id)]),
    state.currentAddressId,
    emails.length,
  ]);
  if (quiet && sig === addrSig) return;
  addrSig = sig;

  drawSidebar();
  syncAvatarLetter();
  drawOval();
  drawBar();
  drawList();
  loadFolders(quiet);
  if (!quiet) loadEmails();
}

// ---------- this account's own folders ----------
// every folder lives on exactly ONE address; switching accounts swaps the
// whole folder set with it (the same isolation the 2FA vault follows)
async function loadFolders(quiet = false) {
  if (!state.currentAddressId) { folders = []; foldersSig = ''; drawSidebar(); return; }
  const seq = ++foldersSeq;
  try {
    const r = await api.get(`/api/mail-folders?address_id=${encodeURIComponent(state.currentAddressId)}`);
    if (seq !== foldersSeq || !sidebarScroll?.isConnected) return;
    folders = r.folders ?? [];
  } catch { if (seq !== foldersSeq) return; folders = []; }
  // repaint only when something really changed — the auto-refresh must not
  // churn the rail or yank a focus out from under the user
  const sig = JSON.stringify([state.currentAddressId, folders.map((f) => [f.id, f.name, f.color, f.count, f.unread])]);
  if (quiet && sig === foldersSig) return;
  foldersSig = sig;
  drawSidebar();
}

// the shell avatar mirrors the live account
function syncAvatarLetter() {
  const av = document.getElementById('acct-avatar');
  if (!av) return;
  const a = (state.addresses ?? []).find((x) => x.id === state.currentAddressId);
  av.textContent = (a ? (a.label || a.address) : (state.user?.username ?? '?')).slice(0, 1).toUpperCase();
}

const activeAccount = () => (state.addresses ?? []).find((x) => x.id === state.currentAddressId) ?? null;

// switching spaces — one function every entry point funnels through
// (the only switcher in the whole app is the avatar circle in the top bar)
function switchInbox(id, opts = {}) {
  state.currentAddressId = id;
  localStorage.setItem('cmail_acct', id ?? '');
  box = 'inbox'; search = '';
  selected.clear(); selecting = false;
  cursorIdx = -1; lastFirstId = null; newFlashId = null;
  folders = []; foldersSig = '';   // the folder set belongs to the account — never bleed across
  const si = document.querySelector('.mail__search');
  if (si) si.value = '';
  drawSidebar(); drawList(); loadFolders(true); loadEmails();
  // the list column announces the active space
  drawOval();
  drawBar();
  drawBulkBar();   // the selection died with the old account — retire its bar too
  syncAvatarLetter();
  if (!opts.keepClosed) document.querySelector('.mail')?.classList.remove('show-sidebar');
  vibrate(5);
}

// ---------- sidebar: the account rail + its folders ----------
// no account list here anymore — accounts are switched exclusively from the
// avatar circle in the top bar, exactly like the big clients. the identity
// itself (name + full address + copy) lives in the oval above the list; the
// rail carries the account's own folders.
function buildSidebar() {
  sidebarScroll = h('div', { class: 'mail__scroll mail__scroll--rail', id: 'addr-list' });
  const aside = h('aside', { class: 'mail__col glass mail__sidebar' }, sidebarScroll);
  return aside;
}

// the local part of an address — the honest short name of a mailbox
const localPart = (addr) => String(addr ?? '').split('@')[0] || addr;

function drawSidebar() {
  // only ever paint into THIS render's sidebar — a stale async continuation
  // must not reach into the live DOM of a newer render (rapid-click safety)
  if (!sidebarScroll?.isConnected) return;
  const box2 = clear(sidebarScroll);
  const a = activeAccount();

  // ----- compact identity: whose rail this is -----
  if (!a) {
    box2.append(h('div', { class: 'rail-id' },
      h('div', { class: 'empty', style: { padding: '18px 8px' } },
        icon('mail'),
        h('div', { class: 'empty__t' }, t('noAccountsYet')),
        h('div', { class: 'empty__d' }, t('noAccountsSub')),
        state.user?.role === 'share' ? '' : h('button', { class: 'btn btn--primary mt-2', onclick: () => createAddressModal(() => loadAddresses()) }, icon('plus'), t('acctNew')))));
    return;
  }
  const locked = a.kind === 'temp' && !tempAuthorized(a.id);
  const left = a.kind === 'temp' && a.expires_at ? a.expires_at - Date.now() : null;
  box2.append(h('div', { class: 'rail-id' },
    h('div', { class: 'rail-id__row' },
      h('span', { class: 'email-row__ava', style: { background: avatarColor(a.address), width: '36px', height: '36px', borderRadius: '12px', fontSize: '14.5px' } }, (a.label || a.address).slice(0, 1).toUpperCase()),
      h('div', { class: 'rail-id__t' },
        h('b', { class: 'rail-id__name' }, a.label || localPart(a.address)),
        h('span', { class: 'rail-id__meta' },
          h('span', { class: `kind-tag kind-tag--${a.kind === 'temp' ? 'temp' : 'perm'}` }, a.kind === 'temp' ? t('temporary') : t('permanent')),
          a.kind === 'temp' ? lockBadge(locked ? 'frozen' : 'flame', locked ? t('vaultFrozen') : t('vaultFlame')) : '')),
      h('button', { class: 'icon-btn', title: t('acctProfile'), 'aria-label': t('acctProfile'), onclick: () => accountModal(a) }, icon('settings'))),
    left !== null ? h('div', { class: 'rail-id__ttl' }, icon('clock'), h('b', { class: 'mono' }, fmtCountdown(left, t))) : ''));

  // ----- folder rail: this account's own boxes -----
  const counts = {
    inbox: emails.length,
    unread: emails.filter((x) => !x.is_read && x.direction !== 'out').length,
    starred: emails.filter((x) => x.starred).length,
    noted: emails.filter((x) => x.has_note).length,
    sent: emails.filter((x) => x.direction === 'out').length,
  };
  const rail = h('nav', { class: 'mail-folders', role: 'navigation' });
  for (const [key, icn, label] of [
    ['inbox', 'inbox', t('allMail')],
    ['unread', 'mail', t('unread')],
    ['sent', 'send', t('railSent')],
    ['starred', 'star', t('starred')],
    ['noted', 'note', t('noted')],
  ]) {
    rail.append(h('button', {
      class: `mfolder ${box === key ? 'is-on' : ''}`,
      onclick: () => { box = key; drawSidebar(); drawList(); drawBar(); vibrate(5); },
    },
      h('span', { class: 'mfolder__icn' }, icon(icn)),
      h('span', { class: 'mfolder__t' }, label),
      counts[key] > 0 ? h('span', { class: `mfolder__n ${key === 'unread' ? 'mfolder__n--hot' : ''}` }, counts[key] > 99 ? '99+' : String(counts[key])) : ''));
  }
  box2.append(rail);

  // ----- this account's own folders — filing that never mixes accounts -----
  box2.append(h('div', { class: 'mfolders-head' },
    h('span', {}, t('folders')),
    h('button', { class: 'icon-btn', title: t('folderManage'), 'aria-label': t('folderManage'), onclick: () => folderManager() }, icon('plus'))));
  if (!folders.length) {
    box2.append(h('button', { class: 'mfolder mfolder--ghost', onclick: () => folderManager() },
      h('span', { class: 'mfolder__icn' }, icon('folder')),
      h('span', { class: 'mfolder__t' }, t('noFolders'))));
  } else {
    const frail = h('nav', { class: 'mail-folders mail-folders--sub' });
    for (const f of folders) {
      const mine = emails.filter((x) => x.folder_id === f.id);
      const n = mine.length;
      const u = mine.filter((x) => !x.is_read).length;
      frail.append(h('button', {
        class: `mfolder ${box === `f:${f.id}` ? 'is-on' : ''}`,
        title: f.sort_from ? `${t('folderRule')}: ${f.sort_from}` : '',
        onclick: () => { box = `f:${f.id}`; drawSidebar(); drawList(); drawBar(); vibrate(5); },
      },
        h('span', { class: `fdot fdot--${f.color || 'amber'}` }, ''),
        h('span', { class: 'mfolder__t' }, f.name),
        n > 0 ? h('span', { class: `mfolder__n ${u > 0 ? 'mfolder__n--hot' : ''}` }, n > 99 ? '99+' : String(n)) : ''));
    }
    box2.append(frail);
  }

  // ----- footer: the door to the accounts hall (the owner only — a guest
  // has no addresses page of its own to walk into) -----
  if (state.user?.role !== 'share') {
    box2.append(h('button', { class: 'rail-manage', onclick: () => { location.hash = '#/addresses'; } },
      icon('mail'), h('span', {}, t('manageAddresses'))));
  }
}

// ---------- mailbox account modal: identity + notes + its own 2FA ----------
// a guest sees the identity and the synced 2FA codes of the shared mailbox —
// but every owner-only surface (label, notes, purge, delete) is not merely
// disabled here: it does not exist in the modal at all
async function accountModal(a) {
  vibrate(5);
  const color = avatarColor(a.address);
  const isOwner = state.user?.role !== 'share';

  // fetch entries scoped to this mailbox + live codes
  let entries = [];
  try {
    const r = await api.get(`/api/totp?address_id=${encodeURIComponent(a.id)}`);
    entries = r.entries ?? [];
  } catch { /* vault fetch is best-effort here */ }

  const labelIn = h('input', { class: 'input', value: a.label ?? '', placeholder: t('label') });
  const notesIn = h('textarea', { class: 'input acct-notes', rows: 5, placeholder: t('acctNotesPh') });
  notesIn.value = a.notes ?? '';

  let saveT = null;
  const saveAccount = (immediateToast) => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        await api.patch(`/api/addresses/${a.id}`, { label: labelIn.value.trim(), notes: notesIn.value });
        const me = state.addresses.find((x) => x.id === a.id);
        if (me) { me.label = labelIn.value.trim() || null; me.notes = notesIn.value; }
        drawSidebar();
        if (immediateToast) toast(t('saved'), 'ok', 1400);
      } catch (e) { toast(errText(e), 'err'); }
    }, immediateToast ? 0 : 550);
  };
  if (isOwner) {
    labelIn.addEventListener('input', () => saveAccount(false));
    notesIn.addEventListener('input', () => saveAccount(false));
  }

  const totpWrap = h('div', { class: 'acct-totps' });
  function drawTotp() {
    clear(totpWrap);
    if (!entries.length) {
      totpWrap.append(h('div', { class: 'acct-totps__empty' }, icon('key'), h('span', {}, t('acct2faEmpty'))));
      return;
    }
    for (const e of entries) {
      const codeEl = h('span', { class: 'acct-totp__code mono', html: esc(e.code ?? '——————') });
      totpWrap.append(h('div', { class: 'acct-totp' },
        glyphTile(e.icon, e.color ?? color, (e.issuer || e.name).slice(0, 1)),
        h('span', { class: 'acct-totp__name' }, e.name),
        codeEl,
        h('button', {
          class: 'icon-btn', title: t('deleteEntry'),
          onclick: async (ev) => {
            ev.stopPropagation();
            confirmBox(t('deleteEntryConfirm'), async () => {
              await api.del(`/api/totp/${e.id}`);
              entries = entries.filter((x) => x.id !== e.id);
              drawTotp(); invalidateAccounts(); toast(t('deletedN'), 'ok', 1500);
            });
          },
        }, icon('trash'))));
    }
  }
  drawTotp();

  const m = modal({
    title: t('acctProfile'), iconName: 'user', wide: true,
    body: [
      h('div', { class: 'acct-head' },
        h('span', { class: 'email-row__ava', style: { background: color, width: '44px', height: '44px', borderRadius: '14px', fontSize: '18px' } }, (a.label || a.address).slice(0, 1).toUpperCase()),
        h('div', { class: 'grow' },
          h('div', { class: 'acct-head__addr mono', onclick: async () => { await copyText(a.address); toast(t('copied'), 'ok', 1300); } }, a.address, icon('copy')),
          h('div', { class: 'small muted' }, `${a.kind === 'temp' ? t('temporary') : t('permanent')} · ${a.total ?? 0} ${t('acctMails')}`)),
      ),
      // label & notes are the owner's pen — a guest reads, never rewrites
      isOwner ? h('div', { class: 'field' }, h('label', {}, t('label')), labelIn) : null,
      isOwner ? h('div', { class: 'field' }, h('label', {}, t('acctNotes')), notesIn) : null,
      h('div', { class: 'acct-2fa' },
        h('div', { class: 'acct-2fa__head' }, icon('key'), h('b', {}, t('acct2fa')),
          (() => {
            // temporary mailboxes keep their vault frozen — codes only go in
            // after the owner accepts they die with the address; once granted,
            // the badge flips to the flame and the dialog never asks again
            const b = h('button', { class: 'btn btn--sm btn--primary' });
            const openEntry = () => { m.close(); entryModal(null, { addressId: a.id, onDone: async () => { invalidateAccounts(); drawSidebar(); } }); };
            const draw = () => {
              clear(b);
              const locked = a.kind === 'temp' && !tempAuthorized(a.id);
              b.className = `btn btn--sm btn--primary ${locked ? 'is-frozen' : ''}`;
              if (locked) {
                b.append(icon('plus'), lockBadge('frozen', t('vaultFrozen')), h('span', { class: 'hide-sm' }, t('acct2faAdd')));
                b.onclick = () => tempGuard(a, () => { draw(); openEntry(); });
              } else {
                b.append(icon('plus'), a.kind === 'temp' ? lockBadge('flame', t('vaultFlame')) : '', h('span', { class: 'hide-sm' }, t('acct2faAdd')));
                b.onclick = openEntry;
              }
            };
            draw();
            return b;
          })()),
        totpWrap),
    ],
    footer: isOwner ? [
      // the whole account lifecycle lives here now: the sidebar kebab is
      // gone, so purge / delete sit beside save — clear and honest
      h('button', { class: 'btn btn--ghost btn--danger-ghost', title: t('acctPurge'), onclick: () => {
        confirmBox(t('acctPurgeConfirm'), async () => {
          try { await api.post(`/api/addresses/${a.id}/purge`); toast(t('acctPurged'), 'ok'); m.close(); switchInbox(state.currentAddressId, { keepClosed: true }); } catch (e) { toast(errText(e), 'err'); }
        });
      } }, icon('archive'), t('acctPurge')),
      h('button', { class: 'btn btn--ghost btn--danger-ghost', title: t('acctDelete'), onclick: async () => {
        const smap = await loadShareMap();
        const parts = [t('acctDeleteConfirm')];
        if (smap?.get(String(a.id))) parts.push(t('acctDeleteShared'));
        confirmBox(parts.join(' '), async () => {
          try {
            await api.del(`/api/addresses/${a.id}`);
            toast(t('deletedN'), 'ok', 1400);
            m.close();
            if (state.currentAddressId === a.id) {
              const rest = state.addresses.filter((x) => x.id !== a.id);
              state.currentAddressId = rest[0]?.id ?? null;
            }
            loadAddresses();
          } catch (e) { toast(errText(e), 'err'); }
        });
      } }, icon('trash'), t('acctDelete')),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
      h('button', { class: 'btn btn--primary', onclick: () => { saveAccount(true); m.close(); } }, t('save')),
    ] : [
      // the guest's footer: one honest way out — nothing else is theirs
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
    ],
  });
}

// ---------- list ----------
// the compose button in the list header shares the FAB's lock behavior:
// always visible, frozen until a provider is connected — and a guest
// without the compose permission never sees it at all
function composeBtn() {
  if (!can('compose')) return null;
  const ready = sendReady();
  const b = h('button', {
    class: `btn btn--sm btn--primary ${ready ? '' : 'is-locked'}`,
    title: ready ? t('compose') : t('sendLockedTitle'),
    onclick: () => ready ? openCompose() : toast(t('sendLockedToast'), 'err'),
  }, icon('send'), h('span', { class: 'hide-sm' }, t('compose')));
  if (!ready) b.append(lockBadge('frozen', t('sendLockedTitle')));
  return b;
}

function buildMain() {
  // ----- the account oval: name + full address + copy, one clear identity -----
  // never a switcher — switching lives only in the avatar circle at the top
  // of the page, so nothing inside the inbox ever jumps between accounts
  ovalEl = h('div', { class: 'acct-oval' });
  const ovalRow = h('div', { class: 'mail__ovalrow' },
    ovalEl,
    h('div', { class: 'row', style: { gap: '5px' } },
      composeBtn(),
      h('button', { class: 'icon-btn', title: t('navAddresses'), onclick: () => document.querySelector('.mail')?.classList.toggle('show-sidebar'), dataset: { mobile: 'menu' } }, icon('menu')),
    ));

  const searchInput = h('input', {
    class: 'input mail__search', type: 'search', placeholder: t('search'),
    oninput: (e) => { search = e.target.value.trim(); clearTimeout(searchInput._t); searchInput._t = setTimeout(() => loadEmails(true), 350); },
  });
  // Escape surrenders the search: one press wipes the query and hands the
  // list back — no hunting for a little x with the keyboard already there
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (searchInput.value) { searchInput.value = ''; search = ''; loadEmails(true); }
    searchInput.blur();
  });

  // ----- the one card the whole inbox lives in -----
  // bulk selection exists for those who may act on it — a guest with no
  // star/archive/delete permission never sees the checkbox machinery
  barMeta = h('span', { class: 'inbox-bar__meta' });
  const bulkable = can('star') || can('archive') || can('delete');
  const allBox = bulkable ? h('button', {
    class: 'inbox-selbox', title: t('selectAll'), 'aria-label': t('selectAll'),
    onclick: () => toggleSelectAll(),
  }) : null;
  barEl = h('div', { class: 'inbox-bar' },
    allBox,
    h('button', { class: 'icon-btn', title: t('refresh'), 'aria-label': t('refresh'), onclick: (e) => { e.currentTarget.querySelector('svg')?.classList.add('spin'); loadEmails(true); loadAddresses(true); setTimeout(() => document.querySelector('.inbox-bar .icon-btn svg.spin')?.classList.remove('spin'), 700); } }, icon('refresh')),
    bulkable ? h('button', { class: 'icon-btn mail__selmode', title: t('islandSelect'), 'aria-label': t('islandSelect'), onclick: () => { selecting = !selecting; vibrate(6); drawList(); drawBar(); if (selecting) toast(t('selHint'), 'ok', 2200); } }, icon('check')) : null,
    h('span', { class: 'autodot', title: t('autoRefreshOn') }, ''),
    h('span', { class: 'inbox-bar__sp' }),
    barMeta);

  bulkBarEl = h('div', { class: 'inbox-bulk hidden' });
  statusEl = h('div', { class: 'inbox-status hidden' }, h('span', { class: 'inbox-status__spin' }, icon('refresh')), h('span', {}, t('inboxStillLoading')));
  listScroll = h('div', { class: 'inbox-card__list', id: 'email-list' });

  const card = h('section', { class: 'inbox-card glass' }, barEl, bulkBarEl, statusEl, listScroll);
  attachPullToRefresh(card);
  const sec = h('section', { class: 'mail__main' }, ovalRow, searchInput, card);
  return sec;
}

// ---------- pull-to-refresh — the thumb's own refresh button ----------
// at the very top of the list, pulling down stretches a springy indicator;
// release past the mark and the box re-loads with a haptic tick. Horizontal
// gestures (the row swipes) and mid-list scrolls never trigger it.
function attachPullToRefresh(host) {
  const el = h('div', { class: 'ptr', 'aria-hidden': 'true' }, icon('refresh'));
  host.append(el);
  let y0 = 0, x0 = 0, dy = 0, pulling = false, armed = false, busy = false;
  const spring = (to, withTransition = true) => {
    listScroll.style.transition = withTransition ? 'transform .34s var(--spring)' : 'none';
    listScroll.style.transform = to ? `translateY(${to}px)` : '';
    if (withTransition) setTimeout(() => { listScroll.style.transition = ''; }, 360);
  };
  listScroll.addEventListener('touchstart', (e) => {
    if (busy || selecting || selected.size) { pulling = false; return; }
    if (listScroll.scrollTop > 2) { pulling = false; return; }
    const t0 = e.touches[0];
    y0 = t0.clientY; x0 = t0.clientX; dy = 0; pulling = true; armed = false;
  }, { passive: true });
  listScroll.addEventListener('touchmove', (e) => {
    if (!pulling || busy) return;
    const t0 = e.touches[0];
    const my = t0.clientY - y0, mx = t0.clientX - x0;
    if (Math.abs(mx) > Math.abs(my) + 6) { pulling = false; el.classList.remove('is-armed', 'is-ready'); spring(0); return; }
    dy = Math.max(0, my);
    if (dy <= 2) { el.classList.remove('is-armed', 'is-ready'); return; }
    el.classList.add('is-armed');
    el.classList.toggle('is-ready', dy > 72);
    armed = dy > 72;
    el.style.transform = `translateY(${Math.min(dy, 130) * 0.42 - 26}px)`;
    spring(dy * 0.38, false);
    if (dy > 72 && !el._b) { el._b = true; vibrate(10); }
    if (dy <= 72) el._b = false;
  }, { passive: true });
  const done = () => {
    if (!pulling) return;
    pulling = false;
    el.style.transform = '';
    if (armed && !busy) {
      busy = true; armed = false; el._b = false;
      el.classList.add('is-spin');
      el.classList.remove('is-ready');
      vibrate([10, 40, 10]);
      spring(24, false);
      Promise.resolve(loadEmails(true)).finally(() => {
        busy = false;
        spring(0);
        setTimeout(() => el.classList.remove('is-spin', 'is-armed', 'is-ready'), 240);
      });
    } else {
      spring(0);
      setTimeout(() => el.classList.remove('is-armed', 'is-ready'), 180);
    }
  };
  listScroll.addEventListener('touchend', done, { passive: true });
  listScroll.addEventListener('touchcancel', done, { passive: true });
}

// paint the account oval from the live account — name + full address + copy
function drawOval() {
  if (!ovalEl?.isConnected) return;
  const el = clear(ovalEl);
  const a = activeAccount();
  if (!a) { el.append(h('span', { class: 'acct-oval__none muted' }, t('noAccountsYet'))); return; }
  const locked = a.kind === 'temp' && !tempAuthorized(a.id);
  el.append(
    h('span', { class: 'email-row__ava acct-oval__ava', style: { background: avatarColor(a.address) } }, (a.label || a.address).slice(0, 1).toUpperCase()),
    h('span', { class: 'acct-oval__txt' },
      h('b', { class: 'acct-oval__name' }, a.label || localPart(a.address)),
      h('span', { class: 'acct-oval__addr mono' }, a.address)),
    a.kind === 'temp' ? lockBadge(locked ? 'frozen' : 'flame', locked ? t('vaultFrozen') : t('vaultFlame')) : '',
    h('button', { class: 'icon-btn acct-oval__copy', title: t('copyAddress'), 'aria-label': t('copyAddress'), onclick: async (e) => { e.stopPropagation(); await copyText(a.address); toast(t('copied'), 'ok', 1200); } }, icon('copy')),
    a.unread > 0 ? h('span', { class: 'acct-oval__badge' }, a.unread > 99 ? '99+' : String(a.unread)) : '');
}

// the toolbar: select-all box, refresh, breathing auto-refresh dot, counters
function drawBar() {
  if (!barEl?.isConnected) return;
  const allBox = barEl.querySelector('.inbox-selbox');
  const vis = visibleEmails().filter((x) => !x.expired);
  const sel = vis.filter((x) => selected.has(x.id)).length;
  if (allBox) {
    allBox.classList.toggle('is-on', vis.length > 0 && sel === vis.length);
    allBox.classList.toggle('is-part', sel > 0 && sel < vis.length);
  }
  clear(barMeta);
  if (selected.size) {
    barMeta.append(h('b', {}, String(selected.size)), ' ' + t('selectedN'));
  } else if (box !== 'inbox') {
    // inside a cut (sent · starred · noted · unread · a user folder) the
    // counter speaks for the box you are actually looking at — never the
    // account totals, which belong to the All-mail view alone
    const label = box === 'unread' ? t('unread')
      : box === 'sent' ? t('railSent')
      : box === 'starred' ? t('starred')
      : box === 'noted' ? t('noted')
      : (folders.find((f) => `f:${f.id}` === box)?.name ?? t('folders'));
    barMeta.append(h('b', {}, String(visible.length)), ' ' + label);
  } else {
    // outgoing mail is never "unread" — the badge counts incoming only,
    // the same way the sidebar rail counts it
    const unread = emails.filter((x) => !x.is_read && x.direction !== 'out').length;
    barMeta.append(
      h('span', {}, `${emails.length} ${t('acctMails')}`),
      unread > 0 ? h('span', { class: 'inbox-bar__warm' }, `· ${unread} ${t('unread')}`) : '');
  }
}

// select-all — one box, like the big clients: click once selects the
// visible rows, click again releases them
function toggleSelectAll() {
  const vis = visibleEmails().filter((x) => !x.expired);
  const every = vis.length && vis.every((x) => selected.has(x.id));
  vis.forEach((x) => { if (every) selected.delete(x.id); else selected.add(x.id); });
  selecting = selected.size > 0;
  drawList(); drawBulkBar(); drawBar();
  vibrate(5);
}

function drawBulkBar() {
  const bar = bulkBarEl;
  if (!bar?.isConnected) return;
  if (!selected.size) { bar.classList.add('hidden'); clear(bar); return; }
  bar.classList.remove('hidden');
  clear(bar);
  bar.append(
    h('span', { class: 'chip is-on' }, `${selected.size}`),
    // delete leads the bar — the action people pick must be the first one
    // there (a guest without the delete permission never sees it)
    can('delete') ? h('button', { class: 'chip chip--danger', onclick: () => confirmEmailDelete(selected.size, state.currentAddressId, () => bulkAction('delete'), true, t('deleteSelConfirm')) }, icon('trash'), t('deleteSel')) : '',
    can('archive') ? h('button', { class: 'chip', onclick: () => bulkMoveModal() }, icon('archive'), t('moveTo')) : '',
    h('button', { class: 'chip', onclick: () => toggleSelectAll() }, icon('check'), t('selectAll')),
    h('button', { class: 'chip', onclick: () => bulkAction('read') }, icon('check'), t('markSelRead')),
    h('button', { class: 'chip', onclick: () => { selected.clear(); selecting = false; drawList(); drawBar(); } }, icon('x'), t('clearSel')),
  );
}

async function bulkAction(action, fid) {
  try {
    await api.post('/api/emails/bulk', { ids: [...selected], action, folder_id: fid });
    toast(action === 'delete' ? t('deletedN') : t('saved'), 'ok', 1600);
    selected.clear();
    selecting = false;
    drawList();
    drawBulkBar();
    // unread badges, per-account counts and the list itself stay honest
    loadAddresses();
  } catch (e) { toast(errText(e), 'err'); }
}

// the bulk “move to folder” picker — one tap files the whole selection
function bulkMoveModal() {
  if (!folders.length) { folderManager(); return; }
  let m = null;
  m = modal({
    title: t('moveTo'), iconName: 'folder',
    body: [h('div', { class: 'menu-stack' },
      folders.map((f) => h('button', { class: 'btn menu-act', onclick: () => { m.close(); bulkAction('move', f.id); } },
        h('span', { class: `fdot fdot--${f.color || 'amber'}` }, ''), f.name)))],
    footer: [h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel'))],
  });
}

// ---------- folder manager: create / rename / rule / delete, all per account ----------
const FOLDER_COLORS = ['amber', 'mint', 'sky', 'rose', 'violet'];

function folderManager() {
  const list = h('div', { class: 'fm-list' });
  const nameIn = h('input', { class: 'input', placeholder: t('folderName'), maxlength: 40 });
  const create = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); return; }
    try {
      await api.post('/api/mail-folders', { address_id: state.currentAddressId, name });
      nameIn.value = '';
      await loadFolders(true);
      drawRows();
      toast(t('saved'), 'ok', 1200);
    } catch (e) { toast(errText(e)?.includes('folder_limit') ? t('folderLimit') : errText(e), 'err'); }
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });

  function drawRows() {
    clear(list);
    if (!folders.length) list.append(h('div', { class: 'small muted', style: { padding: '4px 2px 10px' } }, t('noFolders')));
    for (const f of folders) {
      const nm = h('input', { class: 'input', value: f.name, maxlength: 40 });
      const rule = h('input', { class: 'input ltr', value: f.sort_from ?? '', placeholder: 'news, updates, bills…' });
      const dot = h('button', { class: `fdot fdot--btn fdot--${f.color || 'amber'}`, title: t('folderRule'), onclick: async () => {
        const next = FOLDER_COLORS[(FOLDER_COLORS.indexOf(f.color || 'amber') + 1) % FOLDER_COLORS.length];
        try { await api.patch(`/api/mail-folders/${f.id}`, { color: next }); f.color = next; drawRows(); drawSidebar(); } catch (e) { toast(errText(e), 'err'); }
      } });
      const row = h('div', { class: 'fm-row' },
        dot,
        h('div', { class: 'fm-row__fields' },
          h('div', { class: 'fm-row__line' }, nm, h('span', { class: 'fm-row__n' }, `${f.count ?? 0} ${t('acctMails')}`)),
          h('div', { class: 'small muted', style: { margin: '4px 0 3px' } }, t('folderRule')),
          rule),
        h('button', { class: 'icon-btn', title: t('delete'), 'aria-label': t('delete'), onclick: () => confirmBox(t('folderDeleteConfirm'), async () => {
          try {
            await api.del(`/api/mail-folders/${f.id}`);
            if (box === `f:${f.id}`) { box = 'inbox'; drawList(); drawBar(); }
            await loadFolders(true);
            drawRows();
            toast(t('deletedN'), 'ok', 1300);
          } catch (e) { toast(errText(e), 'err'); }
        }) }, icon('trash')));
      let t1 = null;
      nm.addEventListener('input', () => { clearTimeout(t1); t1 = setTimeout(async () => {
        try { await api.patch(`/api/mail-folders/${f.id}`, { name: nm.value.trim() || f.name }); f.name = nm.value.trim() || f.name; drawSidebar(); } catch (e) { toast(errText(e), 'err'); }
      }, 600); });
      let t2 = null;
      rule.addEventListener('input', () => { clearTimeout(t2); t2 = setTimeout(async () => {
        try { await api.patch(`/api/mail-folders/${f.id}`, { sort_from: rule.value }); f.sort_from = rule.value; } catch (e) { toast(errText(e), 'err'); }
      }, 600); });
      list.append(row);
    }
  }
  drawRows();

  const m = modal({
    title: t('folderManage'), iconName: 'folder', wide: true,
    body: [
      h('div', { class: 'field' }, h('label', {}, t('folderNew')), h('div', { class: 'row' }, nameIn, h('button', { class: 'btn btn--primary', onclick: create }, icon('plus'), t('create')))),
      h('div', { class: 'small muted', style: { margin: '0 0 10px' } }, t('folderRuleHint')),
      list,
    ],
    footer: [h('span', { style: { flex: '1' } }), h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('done'))],
  });
}

const cacheKey = () => `${state.currentAddressId ?? ''}|${box}|${search}`;

async function loadEmails(silent) {
  if (!state.currentAddressId) { emails = []; listLoading = false; listError = null; hideSlow(); drawList(); drawSidebar(); drawBar(); return; }
  // racing loads (fast clicks, auto-refresh, account switches) — only the
  // newest request may paint the list; older responses bail out silently
  const seq = ++listSeq;
  if (!document.body.contains(listScroll ?? document.body)) return;
  // Gmail-speed first paint: whatever this box answered with last time is
  // already on screen before the network even wakes up
  if (!silent && !emails.length && listCache.has(cacheKey())) {
    emails = listCache.get(cacheKey());
    listLoading = false; listError = null;
    drawList(); drawSidebar(); drawBar();
  }
  if (!silent) {
    listLoading = true; listError = null;
    if (!emails.length) drawList();
    drawBar();
  }
  // even a background refresh tells the truth when it drags on —
  // the status strip (and the top bar) appear, the old rows stay put
  showSlow();
  try {
    // the whole box arrives in one pull — folders (all / unread / sent /
    // starred / noted) are cut client-side, so flipping between them is
    // instant and the sidebar counters are always exact
    const params = new URLSearchParams({ limit: '80' });
    params.set('address_id', state.currentAddressId);
    if (search) params.set('q', search);
    const r = await api.get(`/api/emails?${params}`);
    if (seq !== listSeq || !document.body.contains(listScroll ?? document.body)) return;
    lastTotal = r.total ?? lastTotal;
    // the suspended share: the room freezes (idempotent) with the reason and
    // the remaining time on the card; when the admin unsuspends or re-assigns
    // mailboxes, it melts and the guest gets the hello toast — no reload
    if (state.user?.share && typeof r.suspended === 'boolean') {
      if (r.suspended) { shareFrozenSeen = true; shareFrozen(state.user.share); }
      else if (shareFrozenSeen) { shareFrozenSeen = false; shareUnfrozen(true); }
    }
    const fresh = r.emails ?? [];
    // auto-refresh detection: the newest id changed without any user action —
    // the dynamic island announces the arrival the moment it lands
    if (silent && fresh.length && !search) {
      if (lastFirstId && fresh[0].id !== lastFirstId) {
        newFlashId = fresh[0].id;
        const m = fresh[0];
        const seen = sessionStorage.getItem('cmail_seen_mail') ?? '';
        if (m.direction !== 'out' && m.id !== seen && Date.now() - (m.received_at ?? 0) < 120_000) {
          sessionStorage.setItem('cmail_seen_mail', m.id);
          island.arrived(m);
        }
      }
      lastFirstId = fresh[0].id;
    }
    emails = fresh;
    listCache.set(cacheKey(), fresh);
    listLoading = false; listError = null;
    hideSlow();
    if (cursorIdx >= visibleEmails().length) cursorIdx = visibleEmails().length - 1;
    // a silent refresh that saw nothing new never repaints — the rows, the
    // scroll position and any hover state survive untouched (no flicker)
    const sig = JSON.stringify(fresh.map((x) => [x.id, x.is_read, x.starred, x.folder_id, x.subject, x.preview, x.direction, x.has_note]));
    if (!(silent && sig === listSig)) drawList();
    listSig = sig;
    drawSidebar();
    drawBar();
  } catch (e) {
    if (seq !== listSeq) return;
    hideSlow();
    if (silent) return; // a background refresh never wipes a good list
    listLoading = false;
    listError = errText(e);
    drawList();
    drawBar();
  }
}

// the status strip only appears when a load really drags on —
// a blink of loading must never flash a spinner in the user's face
function showSlow() {
  clearTimeout(slowT);
  slowT = setTimeout(() => statusEl?.classList.remove('hidden'), 900);
}
function hideSlow() {
  clearTimeout(slowT);
  statusEl?.classList.add('hidden');
}

// the visible cut of the box the user is in — fixed folders cut client-side,
// user folders file by their id
function visibleEmails() {
  if (box.startsWith('f:')) { const fid = box.slice(2); return emails.filter((x) => x.folder_id === fid); }
  if (box === 'unread') return emails.filter((x) => !x.is_read && x.direction !== 'out');
  if (box === 'sent') return emails.filter((x) => x.direction === 'out');
  if (box === 'starred') return emails.filter((x) => x.starred);
  if (box === 'noted') return emails.filter((x) => x.has_note);
  return emails;
}

function drawList() {
  if (!listScroll?.isConnected) return;   // stale render — touch nothing
  // the reader's place survives the repaint — a refresh never throws the
  // user's scroll back to the top
  const keep = listScroll.scrollTop;
  const list = clear(listScroll);
  document.querySelector('.mail')?.classList.toggle('is-selecting', selecting || selected.size > 0);
  const center = (inner) => h('div', { class: 'inbox-card__center' }, inner);

  // ----- no accounts at all: the honest door in -----
  if (!state.addresses?.length) {
    list.append(center(h('div', { class: 'empty' }, icon('mail'),
      h('div', { class: 'empty__t' }, t('noAccountsYet')),
      h('div', { class: 'empty__d' }, t('noAccountsSub')),
      state.user?.role === 'share' ? '' : h('button', { class: 'btn btn--primary mt-2', onclick: () => createAddressModal(() => loadAddresses()) }, icon('plus'), t('acctNew')))));
    return;
  }

  // ----- no account picked: point at the avatar circle up top -----
  if (!state.currentAddressId) {
    list.append(center(h('div', { class: 'empty' }, h('span', { class: 'empty__point' }, icon('user')),
      h('div', { class: 'empty__t' }, t('noAcctPicked')),
      h('div', { class: 'empty__d' }, t('noAcctPickedSub')))));
    cursorIdx = -1;
    return;
  }

  // ----- first paint: skeleton rows that breathe -----
  if (listLoading && !emails.length) {
    for (let i = 0; i < 7; i++) list.append(skelRow(i));
    cursorIdx = -1;
    return;
  }

  // ----- a load that failed: say so, with a way back -----
  if (listError) {
    list.append(center(h('div', { class: 'empty' }, icon('mail'),
      h('div', { class: 'empty__t' }, t('loadFail')),
      h('div', { class: 'empty__d' }, listError),
      h('button', { class: 'btn btn--primary mt-2', onclick: () => loadEmails() }, icon('refresh'), t('retry')))));
    cursorIdx = -1;
    return;
  }

  const visible = visibleEmails();
  if (!visible.length) {
    // an empty folder, an empty user folder and a search that found nothing
    // deserve different words
    if (search) {
      list.append(center(h('div', { class: 'empty' }, icon('search'),
        h('div', { class: 'empty__t' }, t('noMatch')),
        h('div', { class: 'empty__d' }, t('noMatchSub')))));
    } else if (box.startsWith('f:')) {
      list.append(center(h('div', { class: 'empty' }, icon('folder'),
        h('div', { class: 'empty__t' }, t('folderEmpty')), h('div', { class: 'empty__d' }, t('folderEmptySub')))));
    } else {
      list.append(center(h('div', { class: 'empty' }, icon(box === 'inbox' ? 'inbox' : box === 'starred' ? 'star' : box === 'noted' ? 'note' : 'mail'),
        h('div', { class: 'empty__t' }, t('noEmails')), h('div', { class: 'empty__d' }, t('noEmailsSub')))));
    }
    cursorIdx = -1;
    return;
  }
  // rows that arrive after a skeleton (or an empty hand-off) get the one-time
  // staggered entrance — repaints from background refreshes stay perfectly still
  const hadRows = !!listScroll.querySelector('.email-row');
  visible.forEach((em, i) => {
    const row = emailRow(em);
    if (!hadRows) row.style.setProperty('--i', String(i));
    if (i === cursorIdx) row.classList.add('is-cursor');
    if (newFlashId && em.id === newFlashId && i === 0) row.classList.add('is-new');
    list.append(row);
  });
  if (!hadRows) {
    listScroll.classList.add('animate-in');
    setTimeout(() => listScroll.classList.remove('animate-in'), 950);
  }
  listScroll.scrollTop = keep;
  if (newFlashId) setTimeout(() => { newFlashId = null; list.querySelector('.email-row.is-new')?.classList.remove('is-new'); }, 1600);
}

// one shimmering placeholder row — the list announces its shape before the
// data arrives, exactly the way the big clients do
function skelRow(i) {
  const w = [96, 72, 120, 64, 88][i % 5];
  return h('div', { class: 'skel-row', 'aria-hidden': 'true' },
    h('span', { class: 'select-box' }),
    h('span', { class: 'skel skel-row__ava' }),
    h('span', { class: 'skel', style: { width: `${w}px`, height: '11px' } }),
    h('span', { class: 'skel skel-row__mid' }),
    h('span', { class: 'skel', style: { width: '42px', height: '11px' } }));
}

function emailRow(em) {
  const outgoing = em.direction === 'out';
  const who = outgoing ? (em.to_addr || '—') : (em.from_name || em.from_addr || '?');
  const color = avatarColor(outgoing ? `out:${who}` : em.from_addr);
  const flags = h('div', { class: 'email-row__flags' });
  if (outgoing) flags.append(h('span', { class: 'flag-sent', title: t('flagSentTitle') }, icon('send')));
  if (em.folder_id) {
    const f = folders.find((x) => x.id === em.folder_id);
    flags.append(h('span', { class: `flag-folder fdot fdot--${f?.color || 'amber'}`, title: f?.name ?? '' }, ''));
  }
  if (em.has_note) flags.append(h('span', { class: 'flag-note' }, icon('note')));
  if (em.size > 200_000) flags.append(h('span', { class: 'flag-clip' }, icon('paperclip')));

  // bulk selection machinery only exists where an action can follow — a
  // guest with no star/archive/delete permission reads without checkboxes
  const bulkable = can('star') || can('archive') || can('delete');

  // hover quick actions — replace the time slot on pointer devices.
  // every action the credential does not grant is simply not there
  const qaBtns = [];
  if (can('star')) qaBtns.push(h('button', {
    title: t('star'), 'aria-label': t('star'),
    onclick: async (e) => {
      e.stopPropagation(); vibrate(6);
      const on = !em.starred;
      try { await api.patch(`/api/emails/${em.id}`, { starred: on }); em.starred = on ? 1 : 0; loadEmails(true); } catch (err) { toast(errText(err), 'err'); }
    },
  }, icon('star')));
  if (can('delete')) qaBtns.push(h('button', {
    title: t('delete'), 'aria-label': t('delete'),
    onclick: async (e) => {
      e.stopPropagation(); vibrate([10, 40, 10]);
      confirmEmailDelete(1, em.address_id, async () => {
        try { await api.del(`/api/emails/${em.id}`); toast(t('deletedN'), 'ok', 1400); loadEmails(true); } catch (err) { toast(errText(err), 'err'); }
      });
    },
  }, icon('trash')));
  const qa = qaBtns.length ? h('div', { class: 'email-row__qa' }, ...qaBtns) : null;

  // touch: the star lives beside the time — one tap, never opens the mail
  const starSlot = can('star') ? h('button', {
    class: `email-row__star ${em.starred ? 'is-on' : ''}`, title: t('star'), 'aria-label': t('star'),
    onclick: async (e) => {
      e.stopPropagation(); vibrate(6);
      const on = !em.starred;
      try { await api.patch(`/api/emails/${em.id}`, { starred: on }); em.starred = on ? 1 : 0; e.currentTarget.classList.toggle('is-on', on); loadEmails(true); } catch (err) { toast(errText(err), 'err'); }
    },
  }, icon('star')) : null;

  // per-row overflow menu — the touch-proof way to star / mark / delete
  const kebab = h('button', {
    class: 'email-row__kebab', title: t('more'), 'aria-label': t('more'),
    onclick: (e) => { e.stopPropagation(); vibrate(5); rowMenu(em); },
  }, icon('more'));

  // one row, one line — the way a grown-up mail client reads:
  // [box] [face] Sender  Subject — preview ………………… [flags][star] time
  const row = h('div', {
    class: `email-row ${em.is_read ? '' : 'is-unread'} ${selected.has(em.id) ? 'is-selected' : ''}`,
    dataset: { id: em.id },
    onclick: () => {
      if (bulkable && (selecting || selected.size)) { toggleSelect(em.id); return; }
      cursorIdx = emails.findIndex((x) => x.id === em.id);
      // every email gets its own page — a real route, a real back button
      location.hash = `#/mail/m/${em.id}`;
    },
  },
    bulkable ? h('span', { class: 'select-box', onclick: (e) => { e.stopPropagation(); toggleSelect(em.id); } }) : null,
    h('span', { class: 'email-row__ava', style: { background: color }, title: bulkable ? t('selHint') : '',
      onclick: (e) => { if (!bulkable) return; e.stopPropagation(); toggleSelect(em.id); } },
      who.slice(0, 1).toUpperCase()),
    h('span', { class: 'email-row__from' }, outgoing ? `${t('detailsTo')} ${who}` : who),
    h('span', { class: 'email-row__mid' },
      h('span', { class: 'email-row__subj' }, em.subject || '(no subject)'),
      em.preview ? h('span', { class: 'email-row__sep' }, '—') : '',
      em.preview ? h('span', { class: 'email-row__prev' }, em.preview) : ''),
    h('span', { class: 'email-row__end' },
      flags,
      starSlot,
      h('span', { class: 'email-row__time' }, timeAgo(em.received_at, t)),
      kebab),
    qa);

  // bulk selection machinery only exists where an action can follow — a
  // guest with no star/archive/delete permission reads without checkboxes

  // touch: long-press enters multi-select mode
  let lpT = null;
  let moved = false;
  if (bulkable) {
    row.addEventListener('touchstart', () => { moved = false; lpT = setTimeout(() => {
      if (moved || selecting) return;
      selecting = true;
      vibrate(12);
      toggleSelect(em.id);
      toast(t('selHint'), 'ok', 2200);
    }, 480); }, { passive: true });
    row.addEventListener('touchmove', () => { moved = true; clearTimeout(lpT); }, { passive: true });
    row.addEventListener('touchend', () => clearTimeout(lpT), { passive: true });
    row.addEventListener('contextmenu', (e) => { if (selecting || selected.size) e.preventDefault(); });
  }

  // touch: the Gmail-grade shortcut — flick a row and it acts.
  // left flick deletes, right flick stars; a gentle push springs back.
  // (a guest without the permission keeps its flicks inert — spring back)
  const canSwipeLeft = can('delete');
  const canSwipeRight = can('star');
  if (canSwipeLeft || canSwipeRight) {
  let sx = 0, sy = 0, dx = 0, armed = false, buzzed = false;
  row.addEventListener('touchstart', (e) => {
    if (selecting || selected.size) return;
    const t0 = e.touches[0];
    sx = t0.clientX; sy = t0.clientY; dx = 0; armed = false; buzzed = false;
    row.style.transition = 'none';
  }, { passive: true });
  row.addEventListener('touchmove', (e) => {
    if (selecting || selected.size || !sx) return;
    const t0 = e.touches[0];
    const mx = t0.clientX - sx, my = t0.clientY - sy;
    if (!armed) {
      if (Math.abs(mx) > 9 && Math.abs(mx) > Math.abs(my) * 1.25) armed = true;
      else if (Math.abs(my) > 9) { sx = 0; return; }   // vertical scroll owns this gesture
      else return;
    }
    dx = Math.max(-96, Math.min(96, mx * 0.85));
    if (dx < 0 && !canSwipeLeft) dx = 0;
    if (dx > 0 && !canSwipeRight) dx = 0;
    row.style.transform = `translateX(${dx}px)`;
    if (!buzzed && Math.abs(dx) > 52) { buzzed = true; vibrate(9); }
    row.classList.toggle('swipe-del', dx < -52);
    row.classList.toggle('swipe-star', dx > 52);
  }, { passive: true });
  const swipeEnd = () => {
    if (!sx) return;
    sx = 0;
    row.classList.remove('swipe-del', 'swipe-star');
    if (dx < -56 && canSwipeLeft) {
      vibrate([10, 40, 10]);
      confirmEmailDelete(1, em.address_id, () => {
        row.style.transition = 'transform .25s var(--ease), opacity .25s var(--ease)';
        row.style.transform = 'translateX(-110%)';
        row.style.opacity = '.25';
        api.del(`/api/emails/${em.id}`).then(() => { toast(t('deletedN'), 'ok', 1400); loadEmails(true); }).catch((e2) => { toast(errText(e2), 'err'); row.style.transform = ''; row.style.opacity = ''; });
        setTimeout(() => { row.style.transition = ''; }, 300);
      });
    } else if (dx > 56 && canSwipeRight) {
      vibrate(6);
      row.style.transition = 'transform .3s var(--spring)';
      row.style.transform = '';
      setTimeout(() => { row.style.transition = ''; }, 320);
      api.patch(`/api/emails/${em.id}`, { starred: !em.starred })
        .then(() => { em.starred = em.starred ? 0 : 1; loadEmails(true); })
        .catch((e2) => toast(errText(e2), 'err'));
    } else {
      row.style.transition = 'transform .3s var(--spring)';
      row.style.transform = '';
      setTimeout(() => { row.style.transition = ''; }, 320);
    }
    dx = 0;
  };
  row.addEventListener('touchend', swipeEnd, { passive: true });
  row.addEventListener('touchcancel', swipeEnd, { passive: true });
  }
  return row;
}

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  vibrate(5);
  if (!selected.size) selecting = false;
  drawList();
  drawBulkBar();
}

// ---------- per-row action sheet (touch-proof star / read / file / delete) ----------
function rowMenu(em) {
  let m = null;
  const act = (label, icn, fn, cls = 'btn') => h('button', {
    class: `${cls} menu-act`,
    onclick: () => { m.close(); fn(); },
  }, icon(icn), label);

  const items = [];
  if (can('star')) {
    items.push(act(em.starred ? t('unstar') : t('star'), 'star', async () => {
      try { await api.patch(`/api/emails/${em.id}`, { starred: !em.starred }); loadEmails(true); } catch (e) { toast(errText(e), 'err'); }
    }));
  }
  items.push(act(em.is_read ? t('markUnread') : t('markRead'), 'eye', async () => {
    try { await api.patch(`/api/emails/${em.id}`, { is_read: !em.is_read }); loadEmails(true); } catch (e) { toast(errText(e), 'err'); }
  }));
  // filing — this mail slides into one of the account's own folders
  if (can('archive')) {
    const movable = folders.filter((f) => f.id !== em.folder_id);
    if (movable.length) {
      items.push(h('div', { class: 'menu-act__label' }, t('moveTo')));
      for (const f of movable) {
        items.push(h('button', { class: 'btn menu-act', onclick: () => { m.close(); moveMail(em, f.id); } },
          h('span', { class: `fdot fdot--${f.color || 'amber'}` }, ''), f.name));
      }
    }
    if (em.folder_id) items.push(act(t('folderRemove'), 'x', () => moveMail(em, null)));
  }
  if (can('delete')) items.push(act(t('delete'), 'trash', () => confirmEmailDelete(1, em.address_id, async () => {
    try { await api.del(`/api/emails/${em.id}`); toast(t('deletedN'), 'ok', 1400); loadEmails(true); } catch (e) { toast(errText(e), 'err'); }
  }, true), 'btn btn--danger'));

  m = modal({
    title: (em.subject || '(no subject)').slice(0, 64), iconName: 'mail',
    body: [
      h('div', { class: 'menu-stack' }, items),
    ],
    footer: [h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel'))],
  });
}

// file one message — folder_id null puts it back in the plain inbox
async function moveMail(em, fid) {
  try {
    await api.patch(`/api/emails/${em.id}`, { folder_id: fid });
    em.folder_id = fid || null;
    toast(t('saved'), 'ok', 1200);
    loadEmails(true);
  } catch (e) { toast(errText(e), 'err'); }
}

// ---------- keyboard navigation (j/k/Enter/x/s/Escape) ----------
document.addEventListener('keydown', (e) => {
  const onReader = !!document.querySelector('.reader');
  if (!document.getElementById('email-list') && !onReader) return;   // only in mail context
  if (document.querySelector('.modal-back, .cmdk-back, .menu')) return; // nothing overlaying
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (onReader) {
    if (e.key === 'Escape') { e.preventDefault(); location.hash = '#/mail'; }
    return;
  }

  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter' || e.key === 'o') { openCursor(); }
  else if (e.key === '/') {  // the grown-up shortcut: slash jumps to search
    const si = document.querySelector('.mail__search');
    if (si) { e.preventDefault(); si.focus(); }
  }
  else if (e.key.toLowerCase() === 'x') { const em = visibleEmails()[cursorIdx]; if (em) { e.preventDefault(); toggleSelect(em.id); } }
  else if (e.key.toLowerCase() === 's') {
    const em = visibleEmails()[cursorIdx];
    if (em) {
      e.preventDefault(); vibrate(6);
      api.patch(`/api/emails/${em.id}`, { starred: !em.starred }).then(() => { em.starred = em.starred ? 0 : 1; loadEmails(true); }).catch(() => {});
    }
  }
  else if (e.key === 'Escape') {
    if (selected.size || selecting) { selected.clear(); selecting = false; drawList(); drawBulkBar(); }
  }
});

function moveCursor(dir) {
  const visible = visibleEmails();
  if (!visible.length) return;
  cursorIdx = Math.min(visible.length - 1, Math.max(0, cursorIdx + dir));
  drawList();
  document.querySelector('.email-row.is-cursor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openCursor() {
  const em = visibleEmails()[cursorIdx];
  if (!em) return;
  location.hash = `#/mail/m/${em.id}`;
}

/* ============================================================
   the dedicated email page — #/mail/m/:id
   a real route with a real back button, exactly like the big clients
   ============================================================ */
async function renderReader(root, id) {
  const wrap = h('div', { class: 'reader' });
  root.append(wrap);
  wrap.append(h('div', { class: 'reader__card glass card', style: { padding: '18px' } },
    h('div', { class: 'skel', style: { height: '26px', width: '55%' } }),
    h('div', { class: 'skel mt-2', style: { height: '220px' } })));

  let r;
  try { r = await api.get(`/api/emails/${id}`); }
  catch (e) {
    clear(wrap);
    wrap.append(h('div', { class: 'reader__top' }, backBtn()));
    wrap.append(h('div', { class: 'reader__card glass card reader__empty' },
      h('div', { class: 'empty' }, icon('mail'), h('div', { class: 'empty__t' }, t('error')), h('div', { class: 'empty__d' }, errText(e) || (e.message ?? '')))));
    return;
  }
  clear(wrap);
  await drawReader(wrap, r);

  // reading counts: refresh the unread badge quietly (shell listens)
  const me = await api.get('/api/auth/me').catch(() => null);
  if (me) { state.unread = me.unread ?? 0; window.dispatchEvent(new CustomEvent('cmail:unread-changed', { detail: state.unread })); }
}

function backBtn() {
  return h('button', { class: 'btn btn--ghost', onclick: () => { location.hash = '#/mail'; } },
    icon('arrow'), h('span', {}, t('backToInbox')));
}

async function drawReader(wrap, r) {
  const em = r.email;

  // ----- top bar: back · older/newer · star · delete -----
  let navIds = null;
  if (em.address_id) {
    try {
      // the already-painted list answers for free — a network round trip
      // only happens when the reader was entered cold (deep link)
      let ids;
      if (emails.length && emails[0]?.address_id === em.address_id) {
        ids = emails.map((x) => x.id);
      } else {
        const lr = await api.get(`/api/emails?address_id=${encodeURIComponent(em.address_id)}&limit=80`);
        ids = (lr.emails ?? []).map((x) => x.id);
      }
      const at = ids.indexOf(em.id);
      if (at > -1) navIds = { prev: ids[at + 1] ?? null, next: ids[at - 1] ?? null };
    } catch { /* context nav is best-effort */ }
  }

  // the reader's own actions obey the credential too — a permission the
  // guest does not hold simply has no button here
  const starBtn = can('star') ? h('button', { class: `btn btn--sm btn--ghost ${em.starred ? 'is-on' : ''}`, title: t('star') }, icon('star'), h('span', { class: 'hide-sm' }, t('star'))) : null;
  if (starBtn) starBtn.onclick = async () => {
    const on = !em.starred;
    try {
      await api.patch(`/api/emails/${em.id}`, { starred: on });
      em.starred = on ? 1 : 0;
      starBtn.classList.toggle('is-on', on);
    } catch (e) { toast(errText(e), 'err'); }
  };
  const delBtn = can('delete') ? h('button', { class: 'btn btn--sm btn--ghost', title: t('delete') }, icon('trash'), h('span', { class: 'hide-sm' }, t('delete'))) : null;
  if (delBtn) delBtn.onclick = () => confirmEmailDelete(1, em.address_id, async () => {
    try {
      await api.del(`/api/emails/${em.id}`);
      toast(t('deletedN'), 'ok', 1400);
      location.hash = '#/mail';
    } catch (e) { toast(errText(e), 'err'); }
  }, true);

  const navBtns = h('div', { class: 'reader__navbtns' });
  navBtns.append(
    h('button', { class: 'btn btn--sm btn--ghost', title: t('olderEmail'), disabled: !navIds?.prev, onclick: () => { if (navIds?.prev) location.hash = `#/mail/m/${navIds.prev}`; } }, icon('chevron')),
    h('button', { class: 'btn btn--sm btn--ghost', title: t('newerEmail'), disabled: !navIds?.next, onclick: () => { if (navIds?.next) location.hash = `#/mail/m/${navIds.next}`; } }, icon('chevron', 'rot-180')),
  );

  wrap.append(h('div', { class: 'reader__top' },
    backBtn(),
    navBtns,
    starBtn, delBtn));
  // ----- the email card -----
  const card = h('div', { class: 'reader__card glass' });
  wrap.append(card);

  const actions = h('div', { class: 'viewer__actions' });
  // reply obeys the same sending lock as the compose button — and a guest
  // without the compose permission never sees the plane at all. replying
  // to your own sent mail goes to the person it was sent TO, never to yourself
  const replyTo = em.direction === 'out' ? (em.to_addr || em.from_addr) : em.from_addr;
  if (can('compose')) {
    actions.append(
      h('button', {
        class: `btn btn--sm btn--ghost ${sendReady() ? '' : 'is-frozen'}`,
        title: sendReady() ? t('reply') : t('sendLockedTitle'),
        onclick: () => sendReady()
          ? openCompose({ to: replyTo, subject: `Re: ${em.subject ?? ''}` })
          : toast(t('sendLockedToast'), 'err'),
      }, icon('arrow'), h('span', { class: 'hide-sm' }, t('reply')), sendReady() ? '' : lockBadge('frozen', t('sendLockedTitle'))));
  }
  actions.append(
    h('button', { class: 'btn btn--sm btn--ghost', title: t('markUnread'), onclick: async () => {
      try {
        await api.patch(`/api/emails/${em.id}`, { is_read: false });
        toast(t('saved'), 'ok', 1200);
        location.hash = '#/mail';
      } catch (e) { toast(errText(e), 'err'); }
    } }, icon('eye'), h('span', { class: 'hide-sm' }, t('markUnread'))),
    h('button', { class: 'btn btn--sm btn--ghost', title: t('copy'), onclick: async () => { await copyText(em.from_addr); toast(t('copied'), 'ok', 1400); } }, icon('copy')),
  );

  const meta = h('div', { class: 'viewer__meta' },
    h('span', { class: 'avatar', style: { background: avatarColor(em.from_addr), width: '38px', height: '38px', borderRadius: '12px' } }, (em.from_name || em.from_addr).slice(0, 1).toUpperCase()),
    h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 700, fontSize: '13px' } }, em.from_name ? `${em.from_name} · ${em.from_addr}` : em.from_addr),
      h('div', { class: 'small muted' }, `${t('to')} ${em.to_addr} — ${new Date(em.received_at).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-GB')}`)),
    actions);

  card.append(h('div', { class: 'viewer__head' },
    h('h2', { class: 'viewer__subj reader__subj' }, em.subject || '(no subject)'),
    meta));

  // attachments row (above body, mail-client style)
  if (r.attachments?.length) {
    card.append(h('div', { class: 'attachments' },
      r.attachments.map((a) => a.available
        ? h('a', { class: 'att-chip', href: `/api/emails/attachment/${a.id}`, download: a.filename ?? 'file' }, icon('download'), a.filename ?? 'file', h('span', { class: 'faint small' }, fmtBytes(a.size)))
        : h('span', { class: 'att-chip', title: t('attachmentTooBig'), style: { opacity: .5 } }, icon('paperclip'), a.filename ?? 'file'))));
  }

  // ----- render mode state -----
  let mode = em.html_body ? 'html' : 'text';
  let narrow = false;
  const bodyWrap = h('div', { class: 'viewer__body' });

  const seg = h('div', { class: 'seg' });
  const bHtml = h('button', { type: 'button' }, icon('eye'), t('viewRendered'));
  const bText = h('button', { type: 'button' }, icon('code'), t('viewSource'));
  const bWidth = h('button', { type: 'button', class: 'chip', title: t('viewNarrow') }, icon('columns'), h('span', { class: 'hide-sm' }, t('viewNarrow')));
  seg.append(bHtml, bText);

  function drawSeg() {
    bHtml.classList.toggle('is-on', mode === 'html');
    bText.classList.toggle('is-on', mode === 'text');
    bHtml.style.display = em.html_body ? '' : 'none';
    bWidth.querySelector('span:not(.icn)').textContent = narrow ? t('viewWide') : t('viewNarrow');
    bWidth.style.display = mode === 'html' ? '' : 'none';
  }
  bHtml.onclick = () => { mode = 'html'; drawSeg(); drawBody(); };
  bText.onclick = () => { mode = 'text'; drawSeg(); drawBody(); };
  bWidth.onclick = () => { narrow = !narrow; drawBody(); };
  drawSeg();

  card.append(h('div', { class: 'mtools' }, seg, bWidth));

  function buildFrame() {
    const doc = sanitizeEmailHtml(em.html_body);
    const dir = detectDir(doc);
    const f = h('iframe', {
      class: `mail-frame ${narrow ? 'mail-frame--narrow' : ''}`,
      sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
      referrerpolicy: 'no-referrer',
      title: em.subject || 'email',
    });
    f.setAttribute('srcdoc',
      `<!doctype html><html dir="${dir}" lang="${doc.documentElement.getAttribute('lang') || 'en'}"><head>` +
      `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">` +
      `<style>${mailFrameCss()}</style>${doc.head.innerHTML}</head>` +
      `<body>${doc.body.innerHTML}</body></html>`);
    f.addEventListener('load', () => {
      try {
        const d = f.contentDocument;
        if (!d) return;
        const hh = Math.max(d.documentElement?.scrollHeight ?? 0, d.body?.scrollHeight ?? 0);
        if (hh > 120) f.style.height = `${hh + 20}px`;
        else f.style.height = '100%';
      } catch { f.style.height = '100%'; }
    });
    return f;
  }

  function drawBody() {
    clear(bodyWrap);
    if (mode === 'html' && em.html_body) {
      const frame = buildFrame();
      bodyWrap.append(h('div', { class: 'mail-frame-wrap' }, frame));
    } else {
      bodyWrap.append(h('div', { class: 'mail-frame-wrap' },
        h('div', { class: 'viewer__plain', style: { flex: '1', fontSize: '14.5px' } }, em.text_body || em.preview || '—')));
    }
  }
  drawBody();
  card.append(bodyWrap);

  // note panel — collapsible everywhere; open by default only when a note exists
  const noteBody = h('textarea', { class: 'input', rows: 3, placeholder: t('notePlaceholder') });
  if (r.note) noteBody.value = r.note.body;
  let noteColor = r.note?.color ?? 'amber';
  const colorRow = h('div', { class: 'note-colors' });
  for (const c of ['amber', 'mint', 'sky', 'rose', 'violet']) {
    colorRow.append(h('button', {
      class: `note-dot note-dot--${c} ${noteColor === c ? 'is-on' : ''}`,
      onclick: (e) => { noteColor = c; colorRow.querySelectorAll('.note-dot').forEach((d) => d.classList.remove('is-on')); e.currentTarget.classList.add('is-on'); saveNote(); },
    }));
  }
  let saveT = null;
  function saveNote() {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try { await api.put(`/api/emails/${em.id}/note`, { body: noteBody.value, color: noteColor }); } catch (e) { toast(errText(e), 'err'); }
    }, 600);
  }
  noteBody.addEventListener('input', saveNote);

  // a guest without the notes permission reads the note but cannot touch it
  const noteReadonly = !can('notes');
  if (noteReadonly) { noteBody.readOnly = true; noteBody.setAttribute('placeholder', t('noteLocked')); colorRow.style.display = 'none'; }
  const notePanel = h('div', { class: `note-panel ${r.note?.body ? 'has-note is-open' : ''}` });
  notePanel.append(
    h('button', { class: 'note-panel__head', onclick: () => notePanel.classList.toggle('is-open') },
      icon('note'), h('span', {}, t('noteTitle')),
      noteBody.value ? h('span', { class: 'note-panel__dot' }, '') : '',
      h('span', { class: 'note-panel__chev icn' }, icon('chevron'))),
    h('div', { class: 'note-panel__in' }, noteBody, colorRow));
  card.append(notePanel);

  // ----- advanced details: the message's paperwork, one tap away -----
  card.append(buildMailx(r, em));
}

// the "advanced details" drawer — for received mail: the delivery path and
// the authentication verdicts (SPF · DKIM · DMARC); for sent mail: who it
// went to and how it left. Everything copyable, nothing in the way.
function buildMailx(r, em) {
  const headers = Array.isArray(r.headers) ? r.headers : [];
  const rows = h('div', { class: 'mailx__in' });

  const addRow = (k, v, copyable = true) => {
    if (!v) return;
    const val = h('span', { class: 'mailx__v' }, String(v));
    rows.append(h('div', { class: 'mailx__row' },
      h('span', { class: 'mailx__k' }, k),
      val,
      copyable ? h('button', { class: 'icon-btn mailx__copy', title: t('copy'), 'aria-label': t('copy'), onclick: async () => { await copyText(String(v)); toast(t('copied'), 'ok', 1100); } }, icon('copy')) : ''));
  };

  const outgoing = em.direction === 'out';
  addRow(t('detailsFrom'), outgoing ? em.from_addr : (em.from_name ? `${em.from_name} — ${em.from_addr}` : em.from_addr));
  addRow(t('detailsTo'), em.to_addr);
  addRow(t('detailsDate'), new Date(em.received_at).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-GB'));
  addRow(t('detailsSize'), fmtBytes(em.size ?? 0), false);
  if (outgoing && em.provider) addRow(t('detailsVia'), em.provider);

  // the authentication verdicts, lifted out of Authentication-Results
  const authRaw = headers.filter((h2) => ['authentication-results', 'arc-authentication-results', 'received-spf'].includes(h2.k))
    .map((h2) => h2.v).join(' ');
  const verdict = (re) => authRaw.match(re)?.[1]?.toLowerCase() ?? null;
  const spf = verdict(/\bspf\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)/i);
  const dkim = verdict(/\bdkim\s*=\s*(pass|fail|none|temperror|permerror)/i);
  const dmarc = verdict(/\bdmarc\s*=\s*(pass|fail|none|temperror|permerror)/i);
  if (spf || dkim || dmarc) {
    const chipRow = h('div', { class: 'mailx__auth' });
    for (const [name, val] of [['SPF', spf], ['DKIM', dkim], ['DMARC', dmarc]]) {
      if (!val) continue;
      chipRow.append(h('span', { class: `chip ${val === 'pass' ? 'is-on' : 'chip--warn'}` }, `${name} · ${val}`));
    }
    rows.append(h('div', { class: 'mailx__row' },
      h('span', { class: 'mailx__k' }, t('detailsAuth')), chipRow));
  }

  for (const h2 of headers) {
    if (['from', 'to', 'subject'].includes(h2.k)) continue;
    addRow(h2.k, h2.v, false);
  }

  const head = h('summary', {},
    icon('code'), h('span', {}, t('detailsTitle')),
    h('span', { class: 'mailx__chev' }, icon('chevron')));
  const details = h('details', { class: 'mailx' }, head, rows);
  if (!headers.length && !outgoing) {
    rows.append(h('div', { class: 'small muted', style: { padding: '2px 0 6px' } }, t('detailsEmpty')));
  }
  if (headers.length) {
    head.append(h('button', {
      class: 'icon-btn mailx__copy', title: t('detailsCopyAll'), 'aria-label': t('detailsCopyAll'),
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        copyText(headers.map((x) => `${x.k}: ${x.v}`).join('\n')).then(() => toast(t('copied'), 'ok', 1200));
      },
    }, icon('copy')));
  }
  return details;
}

/* ---------- HTML email sanitizing & rendering ---------- */

// strip scripts / event handlers / dangerous urls — keep full visual structure
function sanitizeEmailHtml(raw) {
  const doc = new DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, link[rel="import"], base, form, input, button, textarea, select').forEach((n) => n.remove());
  for (const el of [...doc.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = String(attr.value ?? '');
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if (['href', 'src', 'srcset', 'xlink:href', 'action', 'formaction', 'background', 'poster'].includes(name)
        && /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i.test(val)) { el.removeAttribute(attr.name); continue; }
      if (name === 'style' && /expression\s*\(|javascript\s*:/i.test(val)) el.removeAttribute(attr.name);
    }
  }
  return doc;
}

function detectDir(doc) {
  const html = doc.documentElement;
  const langAttr = (html.getAttribute('lang') || doc.body?.getAttribute('dir') || html.getAttribute('dir') || '').toLowerCase();
  if (html.getAttribute('dir') === 'rtl' || langAttr.startsWith('fa') || langAttr.startsWith('ar') || langAttr.startsWith('he')) return 'rtl';
  const text = (doc.body?.textContent || '').slice(0, 800);
  const rtlChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return rtlChars > text.length * 0.25 ? 'rtl' : 'ltr';
}

// the base stylesheet injected into every rendered email
function mailFrameCss() {
  return `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font: 14.5px/1.7 -apple-system, 'Segoe UI', 'Vazirmatn', Tahoma, sans-serif;
      color: #20261f; background: transparent;
      padding: 18px 20px 26px;
      word-break: break-word; overflow-wrap: break-word;
      -webkit-text-size-adjust: 100%;
    }
    img, video { max-width: 100% !important; height: auto; border-radius: 6px; }
    table { max-width: 100% !important; border-collapse: collapse; }
    td, th { word-break: break-word; }
    a { color: #4a7a5a; }
    hr { border: 0; border-top: 1px solid #e4e8e0; margin: 18px 0; }
    blockquote { margin: 12px 0; padding: 4px 14px; border-inline-start: 3px solid #cdd8c6; color: #5a655a; }
    pre, code { font-family: ui-monospace, monospace; font-size: 12.5px; background: #f4f6f1; border-radius: 6px; }
    pre { padding: 12px 14px; overflow-x: auto; }
    code { padding: 1.5px 6px; }
    h1, h2, h3 { line-height: 1.4; }
    p { margin: 0 0 10px; }
    [data-cmail-removed] { display: none; }
  `;
}

// ---------- compose — the writing table, done the way the big clients do it ----------
// one honest window: inline rows instead of stacked labels, a body that grows
// with the message, a draft that survives a closed tab, mistakes said out loud
// next to the field instead of shouted from a toast
export async function openCompose(prefill = {}) {
  // a double-click used to stack two composers — one is enough
  if (document.querySelector('.modal--compose')) return;
  if (!state.addresses.length) await api.get('/api/addresses').then((r) => state.addresses = r.addresses ?? []).catch(() => {});

  const DRAFT_KEY = 'cmail_draft';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null'); } catch { saved = null; }
  const useSaved = !!(saved && (saved.to || saved.subject || saved.body) && !prefill.to && !prefill.subject);

  const fromSel = h('select', { class: 'input compose__sel' },
    state.addresses.map((a) => h('option', { value: a.id, selected: a.id === state.currentAddressId || undefined }, a.address)));
  // the active account may be missing from a stale list — never send from a blank choice
  if (!state.addresses.some((a) => a.id === fromSel.value) && state.addresses[0]) fromSel.value = state.addresses[0].id;
  const fromAva = h('span', { class: 'email-row__ava', style: { width: '26px', height: '26px', borderRadius: '9px', fontSize: '12px' } }, '');
  const syncFromAva = () => {
    const a = state.addresses.find((x) => x.id === fromSel.value);
    fromAva.textContent = (a?.address ?? '?').slice(0, 1).toUpperCase();
    fromAva.style.background = a ? avatarColor(a.address) : 'var(--acc)';
  };
  fromSel.addEventListener('change', () => { syncFromAva(); saveDraft(); });
  syncFromAva();

  const to = h('input', { class: 'input ltr compose__in', placeholder: 'name@example.com', value: useSaved ? (saved.to ?? '') : (prefill.to ?? '') });
  const subj = h('input', { class: 'input compose__in', placeholder: t('subject'), value: useSaved ? (saved.subject ?? '') : (prefill.subject ?? '') });
  const body = h('textarea', { class: 'input compose__body', placeholder: t('body') });
  if (useSaved) body.value = saved.body ?? '';
  const toErr = h('div', { class: 'compose__err hidden' }, icon('x'), h('span', {}, ''));

  // the draft rides in localStorage — closed tab, reload, nothing is lost
  const dNote = h('span', { class: 'compose__draft' }, useSaved ? t('draftRestored') : '');
  let dT = null;
  function saveDraft() {
    clearTimeout(dT);
    dT = setTimeout(() => {
      const d = { from: fromSel.value, to: to.value, subject: subj.value, body: body.value, at: Date.now() };
      if (d.to || d.subject || d.body) { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); dNote.textContent = t('draftSaved'); }
      else { localStorage.removeItem(DRAFT_KEY); dNote.textContent = ''; }
    }, 500);
  }
  to.addEventListener('input', saveDraft);
  subj.addEventListener('input', saveDraft);

  // the body grows with the message, up to a sane ceiling
  const grow = () => { body.style.height = 'auto'; body.style.height = `${Math.min(380, Math.max(170, body.scrollHeight))}px`; };
  body.addEventListener('input', () => { grow(); saveDraft(); });
  setTimeout(grow, 0);

  const btn = h('button', { class: 'btn btn--primary compose__send', type: 'button' }, icon('send'), h('span', {}, t('send')));

  // the footer is the send row: the send button LEADS the row (the first
  // thing the eye meets in RTL and LTR alike), the quiet cancel follows,
  // and the draft note trails at the far end — the old order buried the
  // send key in the corner where nobody looks
  const m = modal({
    title: t('composeTitle'), iconName: 'send', wide: true, cls: 'modal--compose',
    body: [
      h('div', { class: 'compose' },
        h('div', { class: 'compose__line' },
          h('span', { class: 'compose__k' }, t('from')),
          h('div', { class: 'compose__v compose__fromrow' }, fromAva, fromSel)),
        h('div', { class: 'compose__line' },
          h('span', { class: 'compose__k' }, t('to_')),
          h('div', { class: 'compose__v' }, to, toErr)),
        h('div', { class: 'compose__line' },
          h('span', { class: 'compose__k' }, t('subject')),
          subj),
        body),
    ],
    footer: [
      h('div', { class: 'compose__foot' },
        btn,
        h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
        h('span', { class: 'compose__foot-note' }, dNote)),
    ],
  });

  const send = async () => {
    const toVal = to.value.trim();
    const badTo = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toVal);
    const emptyBody = !body.value.trim();
    if (badTo || emptyBody) {
      toErr.querySelector('span').textContent = badTo ? t('invalidRecipient') : t('emptyBodyWarn');
      toErr.classList.remove('hidden');
      (badTo ? to : body).focus();
      return;
    }
    toErr.classList.add('hidden');
    btn.disabled = true;
    clear(btn);
    btn.append(h('span', { class: 'spin spin--inline' }, icon('refresh')), h('span', {}, t('sending')));
    island.sending();   // the island takes the news from here on
    try {
      const r = await api.post('/api/emails/send', {
        from_address_id: fromSel.value, to: toVal, subject: subj.value, text: body.value,
      });
      localStorage.removeItem(DRAFT_KEY);
      island.sent(r.id ?? '', toVal);
      m.close();
      // the sent mail joins the account immediately — the list tells the truth
      window.dispatchEvent(new CustomEvent('cmail:refresh-mail'));
    } catch (e) {
      island.hide();
      toast(errText(e), 'err');
      btn.disabled = false;
      clear(btn);
      btn.append(icon('send'), h('span', {}, t('send')));
    }
  };
  btn.addEventListener('click', send);
  // the big clients let you fire with the keyboard — Ctrl/Command + Enter
  const keysend = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } };
  for (const el of [to, subj, body]) el.addEventListener('keydown', keysend);
  setTimeout(() => to.focus(), 80);
}

// ---------- random local part ----------
function randLocal() {
  const words = ['swift', 'quiet', 'amber', 'noble', 'velvet', 'orbit', 'lunar', 'cobalt', 'ember', 'onyx', 'delta', 'echo', 'atlas', 'raven', 'frost', 'sable'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.random().toString(36).slice(2, 8);
  return `${w}.${n}`;
}

// ---------- create inbox modal (shared with addresses view) ----------
export async function createAddressModal(onDone) {
  try {
    if (!state.domains.length) {
      const r = await api.get('/api/addresses/domains');
      state.domains = r.domains ?? [];
    }
  } catch (e) { toast(errText(e), 'err'); return; }
  // only domains that finished their registration can hold a mailbox —
  // drafts and verifying ones stay out of the picker entirely
  const usable = state.domains.filter((d) => !d.status || d.status === 'verified' || d.status === 'unverified');
  if (!usable.length) {
    toast(t('noUsableDomain'), 'err');
    return;
  }

  let kind = 'temp';
  const kindRow = h('div', { class: 'row', style: { gap: '8px' } });
  const domainSel = h('select', { class: 'input' }, usable.map((d) => h('option', { value: d.name }, d.name)));
  const local = h('input', { class: 'input ltr', placeholder: 'name' });
  const labelIn = h('input', { class: 'input', placeholder: t('label') });
  const ttlSel = h('select', { class: 'input' },
    [['1', t('hour1')], ['6', t('hours6')], ['24', t('hours24')], ['72', t('days3')], ['168', t('days7')], ['720', t('days30')]]
      .map(([v, l]) => h('option', { value: v, selected: v === '24' || undefined }, l)));
  const ttlField = h('div', { class: 'field' }, h('label', {}, t('ttl')), ttlSel);

  function drawKind() {
    clear(kindRow);
    for (const [k, lab] of [['temp', t('temporary')], ['permanent', t('permanent')]]) {
      kindRow.append(h('button', {
        class: `chip ${kind === k ? 'is-on' : ''}`,
        onclick: () => { kind = k; drawKind(); ttlField.style.display = kind === 'temp' ? '' : 'none'; },
      }, icon(k === 'temp' ? 'clock' : 'mail'), lab));
    }
  }
  drawKind();

  const btn = h('button', { class: 'btn btn--primary', type: 'submit' }, icon('plus'), t('createAddress'));
  const m = modal({
    title: t('createAddress'), iconName: 'mail',
    body: [
      h('div', { class: 'field' }, h('label', {}, t('addrKind')), kindRow),
      h('div', { class: 'field' }, h('label', {}, t('domain')), domainSel),
      h('div', { class: 'field' },
        h('label', {}, t('localPart')),
        h('div', { class: 'row' },
          local,
          h('button', { class: 'btn btn--sm', title: t('random'), onclick: () => { local.value = randLocal(); } }, icon('refresh')))),
      ttlField,
      h('div', { class: 'field' }, h('label', {}, t('label')), labelIn),
    ],
    footer: [h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')), btn],
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api.post('/api/addresses', {
        local: local.value.trim() || '__random__',
        domain: domainSel.value,
        kind,
        ttl_hours: parseInt(ttlSel.value, 10),
        label: labelIn.value.trim(),
      });
      state.currentAddressId = r.address.id;
      localStorage.setItem('cmail_acct', r.address.id);
      toast(t('saved'), 'ok', 1400);
      m.close();
      onDone?.();
    } catch (e) { toast(errText(e), 'err'); btn.disabled = false; }
  });
}
