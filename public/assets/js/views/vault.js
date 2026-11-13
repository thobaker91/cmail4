// Cmail — 2FA vault: named TOTP entries with live codes, glyphs and account scoping
import { api, state, errText } from '../api.js';
import { t } from '../i18n.js';
import { h, clear, icon, toast, modal, confirmBox, copyText, esc, glyphs, glyphCats, glyphTile, vibrate, fmtCountdown, lockBadge, avatarColor } from '../ui.js';
import { invalidateAccounts } from '../app.js';

const COLORS = { violet: '#a78bfa', sky: '#38bdf8', mint: '#34d399', amber: '#fbbf24', rose: '#fb7185' };
let entries = [];
let folders = [];
let tick = null;
let fscope = 'all';   // 'all' | 'none' | folder id (folders belong to the live account)

const tempAddress = (id) => {
  const a = (state.addresses ?? []).find((x) => x.id === id);
  return a && a.kind === 'temp' ? a : null;
};

// ---------- responsibility memory ----------
// a temporary address's vault is born frozen — snowflake and padlock beside
// the usual plus. The moment the owner accepts the deletion countdown, the
// grant is remembered for that address: the badge flips to the open shackle
// (or the flame) and the dialog never asks again for it.
const TEMP_AUTH_KEY = 'cmail_tempauth';
let tempAuth = {};
try { tempAuth = JSON.parse(localStorage.getItem(TEMP_AUTH_KEY) ?? '{}') ?? {}; } catch { tempAuth = {}; }

export function tempAuthorized(id) { return !!id && !!tempAuth[id]; }

export function grantTempAuth(id) {
  if (!id) return;
  tempAuth[id] = true;
  try { localStorage.setItem(TEMP_AUTH_KEY, JSON.stringify(tempAuth)); } catch { /* storage full — session-only then */ }
}

function pruneTempAuth() {
  const ids = new Set((state.addresses ?? []).map((a) => a.id));
  let changed = false;
  for (const k of Object.keys(tempAuth)) if (!ids.has(k)) { delete tempAuth[k]; changed = true; }
  if (changed) { try { localStorage.setItem(TEMP_AUTH_KEY, JSON.stringify(tempAuth)); } catch { /* */ } }
}

// ---------- the responsibility gate for temporary mailboxes ----------
// a code linked to a temporary address dies together with that address —
// by default the vault stays locked (a lock on the button) and the only
// way through is this dialog, where the owner sees exactly when everything
// will be deleted and accepts that responsibility
export function tempGuard(address, onAccept) {
  const left = address?.expires_at ? address.expires_at - Date.now() : 0;
  const when = left > 0 ? fmtCountdown(left, t) : t('soon');
  const m = modal({
    title: t('tempGuardTitle'), iconName: 'lock',
    body: [
      h('div', { class: 'temp-guard' },
        h('div', { class: 'temp-guard__addr mono' }, address?.address ?? ''),
        h('p', { class: 'temp-guard__text' }, t('tempGuardBody').replace('{when}', when)),
        h('div', { class: 'temp-guard__note' }, icon('alarm'), h('span', {}, t('tempGuardNote')))),
    ],
    footer: [
      h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
      h('button', { class: 'btn btn--danger', onclick: () => { m.close(); grantTempAuth(address?.id); onAccept?.(); } }, icon('lockOpen'), t('tempGuardYes')),
    ],
  });
}

export async function renderVault(root) {
  // the vault opens on the account you are actually in — one account, one
  // room: its codes, its folders, nothing from any other account. switching
  // happens only in the avatar circle at the top of the page.
  const addBtn = h('button', { class: 'btn btn--primary' });
  function refreshAddBtn() {
    clear(addBtn);
    const sid = state.currentAddressId;
    const tmp = tempAddress(sid);
    if (tmp && !tempAuthorized(tmp.id)) {
      addBtn.className = 'btn btn--primary is-frozen';
      addBtn.append(icon('plus'), lockBadge('frozen', t('vaultFrozen')), t('addCode'));
      addBtn.onclick = () => tempGuard(tmp, () => { refreshAddBtn(); entryModal(null, { addressId: sid, onDone: load }); });
    } else {
      addBtn.className = 'btn btn--primary';
      addBtn.append(icon('plus'), tmp ? lockBadge('flame', t('vaultFlame')) : '', t('addCode'));
      addBtn.onclick = () => entryModal(null, { addressId: sid, onDone: load });
    }
  }

  // the identity chip beside the title: whose vault this is. a temporary
  // account wears the frozen badge until the responsibility is granted —
  // then the flame rides along instead
  const idChip = h('div', { class: 'vault-id', id: 'vault-id' });

  const view = h('div', { class: 'view' });
  view.append(h('div', { class: 'page-head' },
    h('div', {}, h('div', { class: 'eyebrow' }, t('eyebrowVault')), h('h2', { class: 'page-title' }, t('vaultTitle')), h('div', { class: 'page-sub' }, t('vaultSub'))),
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, idChip, addBtn),
  ));

  const fchips = h('div', { class: 'vault-filters vault-filters--folders' });
  const searchIn = h('input', { class: 'input', type: 'search', placeholder: t('searchVault'), style: { marginBottom: '14px' } });
  searchIn.addEventListener('input', () => draw(searchIn.value.trim().toLowerCase()));

  const grid = h('div', { class: 'vault-grid', id: 'vault-grid' });
  view.append(fchips, searchIn, grid);
  root.append(view);

  await api.get('/api/addresses').then((r) => state.addresses = r.addresses ?? []).catch(() => {});
  // grants for addresses that no longer exist are quietly retired
  pruneTempAuth();
  // a guest landing straight on the vault picks its first shared mailbox —
  // the vault opens on the account you are actually in, guests included
  if (state.user?.role === 'share' && !state.currentAddressId && state.addresses?.length) {
    state.currentAddressId = state.addresses[0].id;
    try { localStorage.setItem('cmail_acct', state.currentAddressId); } catch { /* private mode */ }
  }

  await load();

  clearInterval(tick);
  tick = setInterval(() => {
    if (!document.body.contains(grid)) { clearInterval(tick); return; }
    updateRings();
  }, 1000);

  function drawIdChip() {
    clear(idChip);
    const a = (state.addresses ?? []).find((x) => x.id === state.currentAddressId);
    if (!a) return;
    const locked = a.kind === 'temp' && !tempAuthorized(a.id);
    idChip.append(
      h('span', { class: 'email-row__ava', style: { background: avatarColor(a.address), width: '30px', height: '30px', borderRadius: '10px', fontSize: '12.5px' } }, (a.label || a.address).slice(0, 1).toUpperCase()),
      h('span', { class: 'vault-id__addr mono' }, a.address),
      h('span', { class: `kind-tag kind-tag--${a.kind === 'temp' ? 'temp' : 'perm'}` }, a.kind === 'temp' ? t('temporary') : t('permanent')),
      a.kind === 'temp' ? lockBadge(locked ? 'frozen' : 'flame', locked ? t('vaultFrozen') : t('vaultFlame')) : '');
  }

  function drawFchips() {
    clear(fchips);
    const mk2 = (key, label, icn) => h('button', {
      class: `chip ${fscope === key ? 'is-on' : ''}`,
      onclick: (e) => { fscope = key; fchips.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on')); e.currentTarget.classList.add('is-on'); vibrate(5); draw(); },
    }, icn ? icon(icn) : '', label);
    fchips.append(mk2('all', t('folderAll'), 'folder'));
    for (const f of folders) {
      const c = h('button', {
        class: `chip ${fscope === f.id ? 'is-on' : ''}`,
        onclick: (e) => { fscope = f.id; fchips.querySelectorAll('.chip').forEach((x) => x.classList.remove('is-on')); e.currentTarget.classList.add('is-on'); vibrate(5); draw(); },
      }, icon(f.icon || 'folder'), f.name, h('span', { class: 'faint' }, String(f.count ?? 0)));
      fchips.append(c);
    }
    fchips.append(mk2('none', t('folderNone'), 'inbox'));
    fchips.append(h('button', { class: 'chip chip--manage', onclick: () => foldersModal() }, icon('edit'), t('folderManage')));
  }

  async function load() {
    try {
      // codes and folders both ride on the live account — two rooms, two keys
      const sid = state.currentAddressId ?? '__none__';
      const [r, fr] = await Promise.all([
        api.get(`/api/totp?address_id=${encodeURIComponent(sid)}`),
        api.get(`/api/totp/folders?address_id=${encodeURIComponent(sid)}`).catch(() => ({ folders: [] })),
      ]);
      entries = r.entries ?? [];
      folders = fr.folders ?? [];
      drawIdChip();
      refreshAddBtn();
      drawFchips();
      draw();
    } catch (e) { toast(errText(e), 'err'); }
  }

  // folder manager: create, rename, delete — the user owns the grouping
  function foldersModal() {
    const listWrap = h('div', { class: 'fld-list' });
    const nameIn = h('input', { class: 'input', maxlength: '40', placeholder: t('folderNamePh') });
    let newIcon = null;
    const newPreview = glyphTile(newIcon, 'var(--acc)', '?');
    const pickWrap = h('div', { class: 'glyph-picker-wrap' });
    pickWrap.append(glyphPicker(newIcon, (id) => {
      newIcon = id;
      const fresh = glyphTile(id, 'var(--acc)', '?');
      newPreview.className = fresh.className;
      newPreview.setAttribute('style', fresh.getAttribute('style') ?? '');
      newPreview.append(...fresh.childNodes);
      pickWrap.classList.remove('is-open');
    }));
    const pickBtn = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => pickWrap.classList.toggle('is-open') }, icon('spark'), t('glyphPick'));

    function drawList() {
      clear(listWrap);
      if (!folders.length) {
        listWrap.append(h('div', { class: 'small muted', style: { padding: '6px 2px 10px' } }, t('folderEmptyHint')));
      }
      for (const f of folders) {
        const ren = h('input', { class: 'input', value: f.name, maxlength: '40' });
        let fIcon = f.icon ?? null;
        const icoTile = glyphTile(fIcon, 'var(--acc)', (f.name || '?').slice(0, 1));
        const ipick = h('div', { class: 'glyph-picker-wrap' });
        ipick.append(glyphPicker(fIcon, (id) => {
          fIcon = (fIcon === id) ? null : id;
          const fresh = glyphTile(fIcon, 'var(--acc)', (ren.value || '?').slice(0, 1));
          icoTile.className = fresh.className;
          icoTile.setAttribute('style', fresh.getAttribute('style') ?? '');
          icoTile.append(...fresh.childNodes);
          ipick.classList.remove('is-open');
          save(f.id, ren, fIcon);
        }));
        const save = async (id, input, ic) => {
          try {
            await api.patch(`/api/totp/folders/${id}`, { name: input.value.trim() || f.name, icon: ic });
            const me = folders.find((x) => x.id === id);
            if (me) { me.name = input.value.trim() || me.name; me.icon = ic; }
            drawFchips(); draw();
          } catch (e) { toast(errText(e), 'err'); }
        };
        ren.addEventListener('change', () => save(f.id, ren, fIcon));
        listWrap.append(h('div', { class: 'fld-row' },
          h('div', { style: { position: 'relative', display: 'flex', gap: '8px', alignItems: 'center' } },
            h('button', { class: 'fld-ico', type: 'button', title: t('glyphPick'), onclick: () => ipick.classList.toggle('is-open') }, icoTile),
            ipick,
            h('div', { class: 'grow' }, ren,
              h('div', { class: 'small faint', style: { marginTop: '2px' } }, `${f.count ?? 0} ${t('folderKeyCount')}`))),
          h('button', {
            class: 'icon-btn', title: t('folderDelete'),
            onclick: () => confirmBox(t('folderDeleteConfirm'), async () => {
              try {
                await api.del(`/api/totp/folders/${f.id}`);
                folders = folders.filter((x) => x.id !== f.id);
                if (fscope === f.id) fscope = 'all';
                drawList(); drawFchips(); draw();
                toast(t('deletedN'), 'ok', 1400);
              } catch (e) { toast(errText(e), 'err'); }
            }),
          }, icon('trash'))));
      }
    }
    drawList();

    const createBtn = h('button', { class: 'btn btn--primary', type: 'button', onclick: async () => {
      if (!nameIn.value.trim()) { toast(t('folderNamePh'), 'err'); return; }
      createBtn.disabled = true;
      try {
        // the folder is born inside THIS account — never shared with the others
        const r = await api.post('/api/totp/folders', { name: nameIn.value.trim(), icon: newIcon, address_id: state.currentAddressId ?? undefined });
        folders.push(r.folder);
        nameIn.value = ''; newIcon = null;
        const fresh = glyphTile(null, 'var(--acc)', '?');
        newPreview.className = fresh.className;
        newPreview.setAttribute('style', fresh.getAttribute('style') ?? '');
        newPreview.append(...fresh.childNodes);
        drawList(); drawFchips(); draw();
        toast(t('saved'), 'ok', 1200);
      } catch (e) { toast(errText(e), 'err'); }
      createBtn.disabled = false;
    } }, icon('plus'), t('folderAdd'));

    modal({
      title: t('folderManage'), iconName: 'folder', wide: true,
      body: [
        h('p', { class: 'small muted', style: { margin: '0 0 10px' } }, t('folderScopeHint')),
        listWrap,
        h('div', { class: 'fld-new' },
          h('div', { class: 'row', style: { alignItems: 'center', gap: '10px' } }, newPreview,
            h('div', { class: 'grow' }, h('div', { class: 'field' }, h('label', {}, t('folderNew')), nameIn)),
            h('div', { style: { alignSelf: 'flex-end', paddingBottom: '2px' } }, pickBtn)),
          pickWrap,
          h('div', { class: 'modal__foot', style: { marginTop: '8px' } }, createBtn)),
      ],
      footer: [h('button', { class: 'btn btn--ghost', onclick: () => { m.close(); load(); } }, t('done'))],
    });
  }

  function draw(q = '') {
    if (!grid?.isConnected) return;   // stale render — touch nothing
    refreshAddBtn();
    const g = clear(grid);
    let list = entries.filter((e) => !q || (e.name + ' ' + (e.issuer ?? '')).toLowerCase().includes(q));
    if (fscope === 'none') list = list.filter((e) => !e.folder_id);
    else if (fscope !== 'all') list = list.filter((e) => e.folder_id === fscope);
    if (!list.length) {
      g.append(h('div', { class: 'glass card', style: { gridColumn: '1/-1' } },
        h('div', { class: 'empty' }, icon('key'), h('div', { class: 'empty__t' }, t('vaultEmpty')), h('div', { class: 'empty__d' }, t('vaultEmptySub')))));
      return;
    }
    for (const e of list) g.append(totpCard(e));
  }

  function totpCard(e) {
    const color = COLORS[e.color] ?? e.color ?? '#7c8cff';
    const acc = state.addresses.find((a) => a.id === e.address_id);
    const fld = folders.find((f) => f.id === e.folder_id);
    const codeEl = h('div', { class: 'totp-code', dataset: { id: e.id }, html: formatCode(e.code ?? '', e.digits) });
    const ring = ringSvg(e.remaining ?? 0, e.period ?? 30, color);

    const card = h('div', { class: 'glass totp-card', style: { '--tc': color }, dataset: { id: e.id, period: e.period ?? 30 } },
      h('div', { class: 'totp-card__top' },
        glyphTile(e.icon, color, (e.issuer || e.name).slice(0, 1)),
        h('div', { class: 'grow' },
          h('div', { class: 'totp-card__name' }, e.name),
          h('div', { class: 'totp-card__issuer' }, e.issuer ?? '')),
        h('div', { class: 'row', style: { gap: '0' } },
          h('button', { class: 'icon-btn', title: t('edit'), onclick: (ev) => { ev.stopPropagation(); entryModal(e, { onDone: load }); } }, icon('edit')),
          h('button', { class: 'icon-btn', title: t('deleteEntry'), onclick: (ev) => { ev.stopPropagation(); confirmBox(t('deleteEntryConfirm'), async () => { await api.del(`/api/totp/${e.id}`); entries = entries.filter((x) => x.id !== e.id); invalidateAccounts(); draw(); toast(t('deletedN'), 'ok', 1500); }); } }, icon('trash')),
        )),
      fld ? h('button', {
        class: 'totp-card__acc chip', onclick: (ev) => { ev.stopPropagation(); fscope = fld.id; draw(); },
      }, icon(fld.icon || 'folder'), fld.name) : '',
      acc && acc.kind === 'temp' && acc.expires_at
        ? h('span', { class: 'totp-temp', title: t('tempGuardTitle') }, icon('clock'), h('span', { class: 'mono' }, fmtCountdown(acc.expires_at - Date.now(), t))) : '',
      h('div', { class: 'totp-card__code-row' },
        codeEl, ring));

    card.addEventListener('click', async () => {
      if (e.code) { await copyText(e.code); toast(t('codeCopied'), 'ok', 1400); }
    });

    // periodic refresh per entry
    const iv = setInterval(async () => {
      if (!document.body.contains(card)) { clearInterval(iv); return; }
      if ((e.remaining ?? 0) <= 1) {
        try {
          const r = await api.get('/api/totp/codes');
          for (const c of r.codes ?? []) {
            const entry = entries.find((x) => x.id === c.id);
            if (entry) { entry.code = c.code; entry.remaining = c.remaining; }
          }
          codeEl.innerHTML = formatCode(e.code ?? '', e.digits);
        } catch { /* ignore */ }
      }
    }, 1000);

    return card;
  }

  function ringSvg(remaining, period, color) {
    const R = 14;
    const C = 2 * Math.PI * R;
    const svg = h('svg', { class: 'totp-ring', viewBox: '0 0 34 34', style: { '--tc': color } });
    svg.append(
      h('circle', { class: 'bg', cx: 17, cy: 17, r: R }),
      h('circle', { class: 'fg', cx: 17, cy: 17, r: R, 'stroke-dasharray': String(C), 'stroke-dashoffset': String(C * (1 - remaining / period)) }),
    );
    svg.dataset.remaining = remaining;
    svg.dataset.period = period;
    return svg;
  }

  function updateRings() {
    document.querySelectorAll('.totp-ring').forEach((svg) => {
      const R = 14, C = 2 * Math.PI * R;
      let rem = Number(svg.dataset.remaining) - 1;
      const period = Number(svg.dataset.period);
      if (rem <= 0) rem = period; // wrap handled by codes refresh
      svg.dataset.remaining = rem;
      svg.querySelector('.fg')?.setAttribute('stroke-dashoffset', String(C * (1 - rem / period)));
    });
    // also decrement in-memory remaining
    for (const e of entries) e.remaining = Math.max(0, (e.remaining ?? 1) - 1);
  }
}

function formatCode(code, digits = 6) {
  if (!code) return '<span class="dim">——————</span>';
  const mid = Math.ceil(code.length / 2);
  return `${esc(code.slice(0, mid))} <span class="dim">${esc(code.slice(mid))}</span>`;
}

// ---------- glyph picker: 48 built-in marks, grouped ----------
function glyphPicker(current, onPick) {
  const wrap = h('div', { class: 'glyph-picker' });
  const grid = h('div', { class: 'glyph-picker__grid' });

  function drawGrid(catKey) {
    clear(grid);
    const catLabel = h('div', { class: 'glyph-picker__cat' }, t(`cat_${catKey}`));
    grid.append(catLabel);
    for (const id of glyphCats[catKey]) {
      const b = h('button', {
        type: 'button', class: `glyph-cell ${current === id ? 'is-on' : ''}`, title: id,
        onclick: () => { onPick(id); wrap.querySelectorAll('.glyph-cell').forEach((c) => c.classList.remove('is-on')); b.classList.add('is-on'); },
      }, h('span', { class: 'glyph-cell__mark', html: glyphs[id] }));
      grid.append(b);
    }
  }

  const tabs = h('div', { class: 'glyph-picker__tabs' });
  const first = Object.keys(glyphCats)[0];
  for (const key of Object.keys(glyphCats)) {
    tabs.append(h('button', {
      type: 'button', class: `chip ${key === first ? 'is-on' : ''}`,
      onclick: (e) => { tabs.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on')); e.currentTarget.classList.add('is-on'); drawGrid(key); },
    }, t(`cat_${key}`)));
  }
  wrap.append(tabs, grid);
  drawGrid(first);
  return wrap;
}

// ---------- add/edit modal ----------
export function entryModal(entry = null, opts = {}) {
  const name = h('input', { class: 'input', value: entry?.name ?? '', placeholder: t('entryName') });
  const issuer = h('input', { class: 'input', value: entry?.issuer ?? '', placeholder: 'GitHub' });
  const secret = h('input', { class: 'input ltr mono', placeholder: 'JBSWY3DPEHPK3PXP' });
  const uri = h('input', { class: 'input ltr mono', placeholder: 'otpauth://totp/…' });
  const algo = h('select', { class: 'input' }, ['SHA1', 'SHA256', 'SHA512'].map((a) => h('option', { value: a, selected: (entry?.algo ?? 'SHA1') === a || undefined }, a)));
  const digits = h('select', { class: 'input' }, [6, 8].map((d) => h('option', { value: d, selected: (entry?.digits ?? 6) === d || undefined }, String(d))));
  const period = h('input', { class: 'input', type: 'number', min: 15, max: 120, value: entry?.period ?? 30 });
  let color = entry?.color ?? 'violet';
  let glyph = entry?.icon ?? null;
  let addressId = entry?.address_id ?? opts.addressId ?? null;
  const colorRow = h('div', { class: 'row' });
  for (const [k, v] of Object.entries(COLORS)) {
    colorRow.append(h('button', {
      class: `note-dot ${`note-dot--${k}`} ${color === k ? 'is-on' : ''}`,
      style: { background: v },
      onclick: (e) => { color = k; colorRow.querySelectorAll('.note-dot').forEach((d) => d.classList.remove('is-on')); e.currentTarget.classList.add('is-on'); },
    }));
  }

  // glyph preview + picker toggle
  const preview = glyphTile(glyph, COLORS[color] ?? color, (issuer.value || name.value || '?').slice(0, 1));
  const pickBtn = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => pickerWrap.classList.toggle('is-open') }, icon('spark'), t('glyphPick'));
  const pickerWrap = h('div', { class: 'glyph-picker-wrap' });
  pickerWrap.append(glyphPicker(glyph, (id) => {
    glyph = (glyph === id) ? null : id;
    clear(preview);
    const fresh = glyphTile(glyph, COLORS[color] ?? color, (issuer.value || name.value || '?').slice(0, 1));
    preview.className = fresh.className;
    preview.setAttribute('style', fresh.getAttribute('style') ?? '');
    preview.append(...fresh.childNodes);
    pickerWrap.classList.remove('is-open');
  }));

  // mailbox link (its 2FA then lives on that account only) — a guest always
  // keeps the key inside one of its shared mailboxes: the unlinked option
  // would only answer 403, so it is not offered at all
  const isGuest = state.user?.role === 'share';
  const addrSel = h('select', { class: 'input' },
    ...(isGuest ? [] : [h('option', { value: '', selected: !addressId || undefined }, t('acctUnlinked'))]),
    state.addresses.map((a) => h('option', { value: a.id, selected: a.id === addressId || undefined }, a.label || a.address)));
  // temporary accounts keep their vault locked — the button wears a lock and
  // only the responsibility dialog opens it
  const tempWarn = h('div', { class: 'temp-guard temp-guard--inline', style: { display: tempAddress(addressId) ? '' : 'none' } },
    icon('lock'), h('span', {}, t('tempGuardInline')));

  // folder link — the picker only ever offers the folders of the chosen
  // account: groupings of account B are invisible while the key sits in A
  let folderId = entry?.folder_id ?? null;
  const fldSel = h('select', { class: 'input' });
  const fldField = h('div', { class: 'field' }, h('label', {}, t('folderField')), fldSel);
  async function syncFolderOptions() {
    let opts = [];
    if (addressId) {
      try {
        const fr = await api.get(`/api/totp/folders?address_id=${encodeURIComponent(addressId)}`);
        opts = fr.folders ?? [];
      } catch { opts = []; }
    }
    clear(fldSel);
    fldSel.append(h('option', { value: '', selected: !folderId || undefined }, t('folderNone')));
    for (const f of opts) fldSel.append(h('option', { value: f.id, selected: f.id === folderId || undefined }, f.name));
    // the saved folder belongs to another account → let go of it quietly
    if (folderId && !opts.some((f) => f.id === folderId)) { folderId = null; fldSel.value = ''; }
    fldField.style.display = opts.length ? '' : 'none';
  }
  syncFolderOptions();
  addrSel.addEventListener('change', () => {
    addressId = addrSel.value || null;
    const tmp = !!tempAddress(addressId);
    tempWarn.style.display = tmp ? '' : 'none';
    folderId = null;
    syncFolderOptions();
    if (!entry) drawSaveBtn();
  });
  fldSel.addEventListener('change', () => { folderId = fldSel.value || null; });

  const secretFields = entry ? [] : [
    h('div', { class: 'field' }, h('label', {}, t('secret')), secret),
    h('div', { class: 'field' }, h('label', {}, t('orPasteUri')), uri),
    h('div', { class: 'row row--wrap' },
      h('div', { class: 'field grow' }, h('label', {}, t('algo')), algo),
      h('div', { class: 'field grow' }, h('label', {}, t('digits')), digits),
      h('div', { class: 'field grow' }, h('label', {}, t('period')), period)),
  ];

  const qrBtn = entry ? h('button', { class: 'btn', type: 'button', onclick: async () => {
    const w = window.open(`/api/totp/${entry.id}/qr`, '_blank', 'width=380,height=480');
    if (!w) toast(t('error'), 'err');
  } }, icon('qr'), t('qr')) : null;

  const secretBtn = entry ? h('button', { class: 'btn', type: 'button', onclick: async () => {
    try {
      const r = await api.get(`/api/totp/${entry.id}/secret`);
      const m2 = modal({
        title: t('showSecret'), iconName: 'key',
        body: [h('div', { class: 'copy-line' }, h('span', {}, r.secret),
          h('button', { class: 'btn btn--sm btn--ghost', onclick: async () => { await copyText(r.secret); toast(t('copied'), 'ok', 1400); } }, icon('copy')))],
      });
    } catch (e) { toast(errText(e), 'err'); }
  } }, icon('eye'), t('showSecret')) : null;

  const refreshCard = () => { vibrate(6); invalidateAccounts(); if (opts.onDone) opts.onDone(); };

  const doSave = async () => {
    if (entry) {
      try {
        await api.patch(`/api/totp/${entry.id}`, { name: name.value.trim(), issuer: issuer.value.trim(), color, icon: glyph, address_id: addressId, folder_id: folderId });
        toast(t('saved'), 'ok', 1400); m.close(); refreshCard();
      } catch (e) { toast(errText(e), 'err'); }
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.post('/api/totp', {
        name: name.value.trim(), issuer: issuer.value.trim(),
        secret: secret.value.trim(), uri: uri.value.trim(),
        algo: algo.value, digits: parseInt(digits.value, 10), period: parseInt(period.value, 10) || 30,
        color, icon: glyph, address_id: addressId, folder_id: folderId,
      });
      toast(t('saved'), 'ok', 1400); m.close(); refreshCard();
    } catch (e) { toast(errText(e), 'err'); saveBtn.disabled = false; }
  };

  // the save button mirrors the lock state of the chosen account: frozen
  // (snowflake + padlock) until the responsibility is granted, then the
  // flame — the code is accepted and will burn with the address
  const saveBtn = entry
    ? h('button', { class: 'btn btn--primary', onclick: doSave }, t('save'))
    : h('button', { class: 'btn btn--primary' });
  function drawSaveBtn() {
    if (entry) return;
    clear(saveBtn);
    const tmp = tempAddress(addressId);
    if (tmp && !tempAuthorized(tmp.id)) {
      saveBtn.className = 'btn btn--primary is-frozen';
      saveBtn.append(icon('plus'), lockBadge('frozen', t('vaultFrozen')), t('addCode'));
    } else {
      saveBtn.className = 'btn btn--primary';
      saveBtn.append(icon('plus'), tmp ? lockBadge('flame', t('vaultFlame')) : '', t('addCode'));
    }
  }
  if (!entry) {
    drawSaveBtn();
    saveBtn.onclick = () => {
      const tmp = tempAddress(addressId);
      if (tmp && !tempAuthorized(tmp.id)) tempGuard(tmp, () => { drawSaveBtn(); doSave(); });
      else doSave();
    };
  }

  const extraRow = h('div', { class: 'row row--wrap' }, qrBtn, secretBtn);

  const m = modal({
    title: entry ? t('edit') : t('addCode'), iconName: 'key',
    body: [
      h('div', { class: 'row', style: { alignItems: 'center', gap: '12px' } },
        preview,
        h('div', { class: 'grow' },
          h('div', { class: 'field' }, h('label', {}, t('entryName')), name),
          h('div', { class: 'field' }, h('label', {}, t('issuer')), issuer)),
        h('div', { style: { alignSelf: 'flex-end', paddingBottom: '2px' } }, pickBtn)),
      pickerWrap,
      ...secretFields,
      h('div', { class: 'field' }, h('label', {}, t('acct2fa')), addrSel),
      tempWarn,
      fldField,
      h('div', { class: 'field' }, h('label', {}, t('color')), colorRow),
      extraRow,
    ],
    footer: [h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')), saveBtn],
  });
}
