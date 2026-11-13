// Cmail — system health: top-of-page alert banners + the Settings health tab.
// One module, one data source (/api/admin/health). Banners only ever surface
// serious issues, each with the fix one press away — a member account never
// sees any of this.
import { api, errText } from './api.js';
import { t } from './i18n.js';
import { h, clear, icon, toast, confirmBox, timeAgo } from './ui.js';

let cache = null;
let cacheAt = 0;
const TTL = 60_000;

export async function getHealth(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  try {
    cache = await api.get('/api/admin/health');
    cacheAt = Date.now();
  } catch {
    cache = null; // non-admin or offline — banners stay silent
  }
  return cache;
}

export function invalidateHealth() { cache = null; cacheAt = 0; }

// ---------- banner models: every issue gets a title, a cause, a fix ----------
function issueBanners(health) {
  const out = [];
  const n = (detail) => parseInt(detail ?? '0', 10) || 0;

  for (const is of health.issues ?? []) {
    if (is.code === 'db_binding' || is.code === 'db_down') {
      out.push({
        code: is.code, severity: 'err',
        title: t('alertDb'), desc: t('alertDbDesc'),
        actions: [{ label: t('alertOpen'), icon: 'settings', fn: () => { location.hash = '#/settings'; } }],
      });
    }
    if (is.code === 'tables_missing') {
      out.push({
        code: is.code, severity: 'err',
        title: t('alertTables').replace('{n}', n(is.detail)),
        desc: t('alertTablesDesc').replace('{n}', n(is.detail)),
        actions: [{
          label: t('alertBuild'), icon: 'database', primary: true,
          fn: async (btn) => {
            btn.disabled = true;
            try {
              await api.post('/api/setup/tables/missing');
              toast(t('alertFixed'), 'ok');
              invalidateHealth();
              await renderInto(document.getElementById('sysalert'), true);
            } catch (e) { toast(errText(e), 'err'); btn.disabled = false; }
          },
        }],
      });
    }
    if (is.code === 'schema_outdated') {
      out.push({
        code: is.code, severity: 'err',
        title: t('alertSchema'), desc: t('alertSchemaDesc'),
        actions: [{
          label: t('alertRepair'), icon: 'refresh', primary: true,
          fn: async (btn) => {
            btn.disabled = true;
            try {
              await api.post('/api/admin/health/repair');
              toast(t('healthRepaired'), 'ok');
              invalidateHealth();
              await renderInto(document.getElementById('sysalert'), true);
            } catch (e) { toast(errText(e), 'err'); btn.disabled = false; }
          },
        }],
      });
    }
    if (is.code === 'cron_dead') {
      out.push({
        code: is.code, severity: 'warn',
        title: t('alertCron'), desc: t('alertCronDesc'),
        actions: [{ label: t('health'), icon: 'zap', fn: () => { location.hash = '#/settings'; } }],
      });
    }
    if (is.code === 'mail_stalled') {
      out.push({
        code: is.code, severity: 'warn',
        title: t('alertStalled'), desc: t('alertStalledDesc'),
        actions: [{ label: t('health'), icon: 'inbox', fn: () => { location.hash = '#/settings'; } }],
      });
    }
    if (is.code === 'domains_stuck') {
      out.push({
        code: is.code, severity: 'warn',
        title: t('alertDomains').replace('{n}', n(is.detail)),
        desc: t('alertDomainsDesc').replace('{n}', n(is.detail)),
        actions: [{ label: t('navDomains'), icon: 'globe', fn: () => { location.hash = '#/domains'; } }],
      });
    }
    if (is.code === 'expired_shares') {
      out.push({
        code: is.code, severity: 'warn',
        title: t('alertExpShares').replace('{n}', n(is.detail)),
        desc: t('alertExpSharesDesc'),
        actions: [{ label: t('shareTab'), icon: 'users', fn: () => { location.hash = '#/settings/share'; } }],
      });
    }
  }
  return out;
}

const dismissKey = (code) => `cmail_alert_off_${code}`;
const dismissed = (code) => sessionStorage.getItem(dismissKey(code)) === '1';

// ---------- banner strip ----------
export async function renderInto(host, force = false) {
  if (!host) return;
  const health = await getHealth(force);
  clear(host);
  if (!health || health.status === 'ok') { host.hidden = true; return; }
  const banners = issueBanners(health).filter((b) => !dismissed(b.code));
  if (!banners.length) { host.hidden = true; return; }
  host.hidden = false;
  for (const b of banners.slice(0, 3)) {
    const actions = h('div', { class: 'alert-card__acts' });
    for (const a of b.actions) {
      const btn = h('button', { class: `btn btn--sm ${a.primary ? 'btn--primary' : 'btn--ghost'}` },
        icon(a.icon), a.label);
      btn.addEventListener('click', () => a.fn(btn));
      actions.append(btn);
    }
    actions.append(h('button', {
      class: 'icon-btn alert-card__x', title: t('alertDismiss'), 'aria-label': t('alertDismiss'),
      onclick: () => { sessionStorage.setItem(dismissKey(b.code), '1'); host.contains(card) && card.remove(); if (!host.children.length) host.hidden = true; },
    }, icon('x')));
    const card = h('div', { class: `alert-card alert-card--${b.severity}` },
      h('span', { class: 'alert-card__pulse', 'aria-hidden': 'true' }),
      h('div', { class: 'alert-card__body' },
        h('div', { class: 'alert-card__t' }, b.title),
        h('div', { class: 'alert-card__d' }, b.desc)),
      actions);
    host.append(card);
  }
}

// ---------- Settings → Health tab ----------
export async function healthPane() {
  const pane = h('div', { class: 'health' });

  // warm cache paints the whole panel instantly — the skeleton only shows
  // on a cold first visit, and fresh data lands quietly on top of it
  let lastSig = '';
  const paint = async (hp, force) => {
    const health = await getHealth(force);
    if (!document.body.contains(hp)) return;
    if (!health) {
      clear(hp);
      hp.append(h('div', { class: 'empty' }, icon('info'), h('div', { class: 'empty__t' }, t('error')), h('div', { class: 'empty__d' }, t('healthAdminOnly'))));
      return;
    }
    // identical report → leave the pixels alone (no flicker, no lost focus)
    const sig = JSON.stringify(health);
    if (sig === lastSig) return;
    lastSig = sig;
    draw(hp, health);
  };

  function draw(hp, health) {
    clear(hp);

    // ----- hero state -----
    const st = health.status;
    const hero = h('div', { class: `glass card health__hero health__hero--${st}` },
      h('span', { class: 'health__pulse', 'aria-hidden': 'true' }),
      h('div', { class: 'grow' },
        h('div', { class: 'health__state' }, t(st === 'ok' ? 'healthStateOk' : st === 'warn' ? 'healthStateWarn' : 'healthStateErr')),
        h('div', { class: 'small muted' }, t(st === 'ok' ? 'healthStateOkSub' : st === 'warn' ? 'healthStateWarnSub' : 'healthStateErrSub'))),
      h('span', { class: 'chip' }, `${t('healthVersion')} ${health.version || '?'}`));
    hp.append(hero);

    const grid = h('div', { class: 'health__grid' });

    // ----- D1 card -----
    const db = health.db ?? {};
    grid.append(h('div', { class: 'glass card' },
      h('h3', { style: { margin: '0 0 10px', fontSize: '15px' } }, icon('database'), ' ', t('healthCardD1')),
      kv(t('healthDbBinding'), chip(db.binding ? t('healthDbConnected') : t('healthDbDown'), db.binding)),
      kv(t('healthDbConnected'), chip(db.connected ? t('yes') : t('no'), db.connected)),
      kv(t('healthLatency'), h('span', { class: 'mono' }, db.latency_ms != null ? `${db.latency_ms} ms` : '—')),
    ));

    // ----- tables & schema card -----
    const tablesCard = h('div', { class: 'glass card' });
    const needRepair = (health.tables ?? []).filter((x) => !x.exists || x.missing_cols.length);
    const head = h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } },
      h('h3', { style: { margin: 0, fontSize: '15px' } }, icon('database'), ' ', t('healthCardTables')),
      needRepair.length ? h('button', {
        class: 'btn btn--sm btn--primary',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.post('/api/admin/health/repair');
            toast(t('healthRepaired'), 'ok');
            invalidateHealth(); paint(pane, true);
          } catch (err) { toast(errText(err), 'err'); e.currentTarget && (e.currentTarget.disabled = false); }
        },
      }, icon('refresh'), t('healthRepairAll')) : '');
    tablesCard.append(head);

    const grid2 = h('div', { class: 'health__tables' });
    for (const tb of health.tables ?? []) {
      const state = !tb.exists ? 'missing' : tb.missing_cols.length ? 'repair' : 'ok';
      const label = state === 'missing' ? t('d1MissingShort') : state === 'repair' ? `${tb.missing_cols.length} ${t('healthColsMissing')}` : t('healthColsOk');
      const row = h('div', { class: `health__table health__table--${state}` },
        h('span', { class: 'mono health__table-name' }, tb.name),
        h('span', { class: 'small muted' }, tb.exists ? `${tb.rows ?? '—'} ${t('d1Rows')}` : '—'),
        h('span', { class: `chip ${state === 'ok' ? 'is-on' : ''} ${state !== 'ok' ? 'chip--warn' : ''}` }, label),
        state !== 'ok' ? h('button', {
          class: 'btn btn--sm',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.post(`/api/setup/tables/${encodeURIComponent(tb.name)}/create`);
              toast(t('d1Built'), 'ok');
              invalidateHealth(); paint(pane, true);
            } catch (err) { toast(errText(err), 'err'); e.currentTarget.disabled = false; }
          },
        }, icon('plus'), state === 'missing' ? t('d1CreateOne') : t('alertRepair')) : '');
      grid2.append(row);
    }
    tablesCard.append(grid2);

    if ((health.extras ?? []).length) {
      const ex = h('div', { class: 'health__extras' }, h('div', { class: 'small muted', style: { margin: '10px 0 6px' } }, `${t('d1ExtraT')} (${health.extras.length})`));
      for (const name of health.extras) {
        ex.append(h('div', { class: 'health__table health__table--extra' },
          h('span', { class: 'mono health__table-name' }, name),
          h('span', { class: 'small muted' }, t('d1NotOurs')),
          h('button', {
            class: 'btn btn--sm btn--danger-ghost',
            onclick: () => confirmBox(t('d1DropConfirm'), async () => {
              try {
                await api.del(`/api/setup/tables/${encodeURIComponent(name)}`);
                toast(t('d1Dropped'), 'ok');
                invalidateHealth(); paint(pane, true);
              } catch (err) { toast(errText(err), 'err'); }
            }),
          }, icon('trash'), t('d1Drop'))));
      }
      tablesCard.append(ex);
    }
    grid.append(tablesCard);

    // ----- background card -----
    const cr = health.cron ?? {};
    grid.append(h('div', { class: 'glass card' },
      h('h3', { style: { margin: '0 0 10px', fontSize: '15px' } }, icon('clock'), ' ', t('healthCardBg')),
      kv(t('healthCronLast'),
        cr.last_run
          ? h('span', {}, timeAgo(cr.last_run, t), cr.dead ? h('span', { class: 'chip chip--warn', style: { marginInlineStart: '8px' } }, t('healthCronDead')) : '')
          : chip(t('healthCronNever'), false)),
      cr.dead ? h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, t('healthCronDeadHint')) : '',
    ));

    // ----- mail flow card -----
    const mf = health.mail ?? {};
    const mailCard = h('div', { class: 'glass card' },
      h('h3', { style: { margin: '0 0 10px', fontSize: '15px' } }, icon('inbox'), ' ', t('healthCardMail')),
      kv(t('healthLastMail'), mf.last_mail ? h('span', {}, timeAgo(mf.last_mail, t)) : chip(t('healthNever'), false)),
      kv(t('navMail'), h('span', {}, String(mf.emails_total ?? 0))),
      kv(t('navAddresses'), h('span', {}, String(mf.addresses_total ?? 0))),
      kv(t('healthReadyDomains'), h('span', {}, (mf.ready_domains ?? []).join('، ') || '—')),
    );
    if ((mf.stuck_domains ?? []).length) {
      mailCard.append(kv(t('healthStuckDomains'), h('span', { class: 'chip chip--warn' }, String(mf.stuck_domains.length))));
    }
    mailCard.append(h('details', { class: 'health__checklist' },
      h('summary', {}, icon('help'), t('healthChecklist')),
      h('ol', {}, [t('healthCheck1'), t('healthCheck2'), t('healthCheck3')].map((s) => h('li', {}, s)))));
    grid.append(mailCard);

    hp.append(grid);
    hp.append(h('p', { class: 'small muted', style: { margin: '10px 2px 0', opacity: .8 } }, icon('refresh'), ' ', t('healthAutoRefresh')));
  }

  // cold visit: a tiny skeleton, then the report — warm visit: the panel is
  // simply there, and fresh numbers land quietly behind it
  if (cache && Date.now() - cacheAt < TTL) {
    await paint(pane, false);
    paint(pane, true);
  } else {
    pane.append(h('div', { class: 'empty' }, h('div', { class: 'skel', style: { height: '90px', width: '100%' } })));
    await paint(pane, true);
  }
  const iv = setInterval(() => {
    if (!document.body.contains(pane)) { clearInterval(iv); return; }
    if (document.hidden || document.querySelector('.modal-back')) return;
    paint(pane, true);
  }, 30_000);
  return pane;
}

// ---------- small helpers ----------
function chip(label, ok) {
  return h('span', { class: `chip ${ok ? 'is-on' : 'chip--warn'}` }, label);
}
function kv(k, v) {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-row__t' }, k), h('div', { class: 'row', style: { gap: '6px' } }, v));
}
