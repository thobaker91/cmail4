// Cmail — mailboxes view: every account gets its own card
// The old flat table is gone: accounts now live as cards — open one and its
// inbox takes over, copy / forward / extend / delete stay one press away.
import { api, state, errText } from '../api.js';
import { t } from '../i18n.js';
import { h, clear, icon, toast, confirmBox, copyText, timeAgo, fmtCountdown } from '../ui.js';
import { createAddressModal } from './mail.js';
import { avatarColor } from '../ui.js';

export async function renderAddresses(root) {
  const view = h('div', { class: 'view' });
  view.append(h('div', { class: 'page-head' },
    h('div', {}, h('div', { class: 'eyebrow' }, t('eyebrowAddresses')), h('h2', { class: 'page-title' }, t('addressesTitle')), h('div', { class: 'page-sub' }, t('addressesSub'))),
    h('button', { class: 'btn btn--primary', onclick: () => createAddressModal(load) }, icon('plus'), t('createAddress')),
  ));

  // the summary strip: how the fleet is doing, one glance
  const stats = h('div', { class: 'addr-stats' });
  const grid = h('div', { class: 'addr-grid', id: 'addr-grid' });
  view.append(stats, grid);
  root.append(view);

  let addresses = [];

  // which mailboxes does an active share hold? deleting one of them takes
  // the mailbox away from the shared user too — and if it was that
  // credential's LAST mailbox, the whole share goes suspended until the
  // admin assigns a mailbox again. The admin hears this BEFORE confirming.
  let shareMap = null;
  async function loadShareMap() {
    if (shareMap) return shareMap;
    const m = new Map();
    try {
      const r = await api.get('/api/share');
      for (const s of (r.shares ?? [])) {
        if (!s.active) continue;
        const ids = (s.address_ids ?? []).map(String).filter(Boolean);
        for (const aid of ids) m.set(aid, { name: s.label || s.username, multi: ids.length > 1 });
      }
    } catch { /* no shares / no permission — the plain confirm stays */ }
    shareMap = m;
    return m;
  }

  async function load() {
    try {
      const r = await api.get('/api/addresses');
      addresses = r.addresses ?? [];
      state.addresses = addresses;
      draw();
    } catch (e) { toast(errText(e), 'err'); }
  }

  function draw() {
    if (!grid?.isConnected) return;   // stale render — touch nothing
    const totalMail = addresses.reduce((s, a) => s + (a.total ?? 0), 0);
    const tempN = addresses.filter((a) => a.kind === 'temp').length;
    clear(stats);
    stats.append(
      statTile(t('statAccounts'), String(addresses.length), 'mail', ''),
      statTile(t('statTotalMail'), String(totalMail), 'inbox', ''),
      statTile(t('statTemp'), String(tempN), 'clock', tempN ? 'is-warm' : ''),
      statTile(t('statActive'), state.currentAddressId && addresses.some((a) => a.id === state.currentAddressId) ? (addresses.find((a) => a.id === state.currentAddressId)?.label || t('statActiveT')) : '—', 'zap', 'is-warm'),
    );

    const g = clear(grid);
    if (!addresses.length) {
      g.append(h('div', { class: 'glass card', style: { gridColumn: '1/-1' } },
        h('div', { class: 'empty' }, icon('mail'),
          h('div', { class: 'empty__t' }, t('noAccountsYet')),
          h('div', { class: 'empty__d' }, t('noAccountsSub')),
          h('button', { class: 'btn btn--primary mt-2', onclick: () => createAddressModal(load) }, icon('plus'), t('acctNew')))));
      return;
    }
    for (const a of addresses) g.append(acctCard(a));
  }

  function statTile(label, value, icn, cls) {
    return h('div', { class: `stat-tile glass ${cls}` },
      h('span', { class: 'stat-tile__icn' }, icon(icn)),
      h('div', {}, h('div', { class: 'stat-tile__n' }, value), h('div', { class: 'stat-tile__l' }, label)));
  }

  // one card = one account. clicking the card body jumps into its inbox —
  // switching accounts is the default gesture here, not a hidden action
  function acctCard(a) {
    const active = a.id === state.currentAddressId;
    const left = a.kind === 'temp' && a.expires_at ? a.expires_at - Date.now() : null;
    const card = h('div', { class: `acct-card glass ${active ? 'is-live' : ''}`, dataset: { id: a.id } },
      active ? h('span', { class: 'acct-card__live' }, icon('zap'), t('statActiveT')) : '',
      h('div', {
        class: 'acct-card__main', role: 'button', tabindex: '0',
        onclick: () => { state.currentAddressId = a.id; localStorage.setItem('cmail_acct', a.id); location.hash = '#/mail'; },
        onkeydown: (e) => { if (e.key === 'Enter') card.querySelector('.acct-card__main').click(); },
      },
        h('div', { class: 'acct-card__idrow' },
          h('span', { class: 'email-row__ava', style: { background: avatarColor(a.address), width: '42px', height: '42px', borderRadius: '14px', fontSize: '17px' } }, (a.label || a.address).slice(0, 1).toUpperCase()),
          h('div', { class: 'acct-card__id' },
            h('div', { class: 'acct-card__addr mono' }, a.address),
            h('div', { class: 'acct-card__tags' },
              h('span', { class: `kind-tag kind-tag--${a.kind === 'temp' ? 'temp' : 'perm'}` }, a.kind === 'temp' ? t('temporary') : t('permanent')),
              a.label ? h('span', { class: 'kind-tag kind-tag--label' }, a.label) : ''))),
        h('div', { class: 'acct-card__nums' },
          h('div', { class: 'acct-card__num' }, h('b', {}, String(a.total ?? 0)), h('span', {}, t('acctMails'))),
          h('div', { class: 'acct-card__num' }, h('b', {}, a.last_mail_at ? timeAgo(a.last_mail_at, t) : '—'), h('span', {}, t('lastMail'))),
          h('div', { class: 'acct-card__num' }, h('b', { class: left !== null && left < 3_600_000 ? 'is-urgent' : '' }, left === null ? t('never') : fmtCountdown(left, t)), h('span', {}, t('expires'))))),
      h('div', { class: 'acct-card__actions' },
        h('button', { class: 'btn btn--sm', onclick: async (e) => { e.stopPropagation(); await copyText(a.address); toast(t('copied'), 'ok', 1400); } }, icon('copy'), h('span', { class: 'hide-sm' }, t('copy'))),
        h('button', { class: 'btn btn--sm', onclick: (e) => { e.stopPropagation(); forwardModal(a); } }, icon('external'), h('span', { class: 'hide-sm' }, t('forwarding'))),
        a.kind === 'temp' ? h('button', { class: 'btn btn--sm', onclick: async (e) => { e.stopPropagation(); try { await api.patch(`/api/addresses/${a.id}`, { extend_hours: 24 }); toast(t('saved'), 'ok', 1400); load(); } catch (er) { toast(errText(er), 'err'); } } }, icon('clock'), h('span', { class: 'hide-sm' }, t('extend24'))) : '',
        h('button', { class: 'btn btn--sm btn--primary acct-card__open', onclick: (e) => { e.stopPropagation(); state.currentAddressId = a.id; localStorage.setItem('cmail_acct', a.id); location.hash = '#/mail'; } }, icon('inbox'), t('openInbox')),
        h('button', { class: 'icon-btn', title: t('deleteAddress'), onclick: async (e) => {
          e.stopPropagation();
          // the shared-user warning rides BEFORE the confirm — deleting a
          // mailbox that an active share holds is a two-sided decision
          const parts = [t('deleteAddressConfirm')];
          try {
            const map = await loadShareMap();
            const sh = map?.get(String(a.id));
            if (sh) {
              parts.push(`${t('delAddrSharedWarn')}${sh.name ? ` (${sh.name})` : ''}`);
              if (!sh.multi) parts.push(t('delAddrSharedLast'));
            }
          } catch { /* the plain confirm answers then */ }
          confirmBox(parts.join(' '), async () => {
            try { await api.del(`/api/addresses/${a.id}`); toast(t('deletedN'), 'ok', 1500); if (state.currentAddressId === a.id) { state.currentAddressId = null; localStorage.setItem('cmail_acct', ''); } load(); } catch (er) { toast(errText(er), 'err'); }
          });
        } }, icon('trash')),
      ));
    return card;
  }

  function forwardModal(a) {
    import('../ui.js').then(({ modal }) => {
      const fwd = h('input', { class: 'input ltr', value: a.forward_to ?? '', placeholder: 'backup@example.com' });
      const m = modal({
        title: t('forwarding'), iconName: 'external',
        body: [
          h('p', { class: 'small muted', style: { margin: 0 } }, t('forwardingHint')),
          h('div', { class: 'field' }, h('label', {}, `${t('forwarding')} — ${a.address}`), fwd),
        ],
        footer: [
          h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
          h('button', { class: 'btn btn--primary', onclick: async () => {
            try { await api.patch(`/api/addresses/${a.id}`, { forward_to: fwd.value.trim() }); toast(t('saved'), 'ok', 1400); m.close(); }
            catch (e) { toast(errText(e), 'err'); }
          } }, t('save')),
        ],
      });
    });
  }

  await load();
  // live countdown refresh
  const iv = setInterval(() => { if (!document.body.contains(view)) { clearInterval(iv); return; } draw(); }, 60_000);
}
