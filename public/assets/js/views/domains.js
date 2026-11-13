// Cmail — domains view (admin)
// No more flat table: every domain gets a card of its own — big name, a live
// status pill with a pulse, the lifecycle as a small progress trail, the two
// switches right on the card, and the numbers underneath. The page opens with
// a stat strip so the whole fleet is visible in one glance.
import { api, errText } from '../api.js';
import { t, lang } from '../i18n.js';
import { h, clear, icon, toast, modal, confirmBox, copyText, timeAgo } from '../ui.js';
import { openDomainWizard } from './domwiz.js';

export async function renderDomains(root) {
  const view = h('div', { class: 'view' });
  view.append(h('div', { class: 'page-head' },
    h('div', {}, h('div', { class: 'eyebrow' }, t('eyebrowDomains')), h('h2', { class: 'page-title' }, t('domainsTitle')), h('div', { class: 'page-sub' }, t('domainsSub'))),
    h('button', { class: 'btn btn--primary', onclick: () => addModal(load) }, icon('plus'), t('addDomain')),
  ));

  const stats = h('div', { class: 'dom-stats' });
  const grid = h('div', { class: 'dom-grid', id: 'dom-grid' });
  view.append(stats, grid, h('div', { class: 'mt-2' }, routingHelp()));
  root.append(view);

  async function load() {
    try {
      const r = await api.get('/api/addresses/domains');
      draw(r.domains ?? []);
    } catch (e) { toast(errText(e), 'err'); }
  }

  function draw(domains) {
    if (!grid?.isConnected) return;   // stale render — touch nothing
    const verified = domains.filter((d) => d.status === 'verified' || d.status === 'unverified').length;
    const pending = domains.filter((d) => d.status === 'draft' || d.status === 'verifying').length;
    const boxes = domains.reduce((s, d) => s + (d.address_count ?? 0), 0);
    clear(stats);
    stats.append(
      domStat('domStatTotal', domains.length, 'globe', ''),
      domStat('domStatVerified', verified, 'shield', verified ? 'is-ok' : ''),
      domStat('domStatPending', pending, 'clock', pending ? 'is-warm' : ''),
      domStat('domStatBoxes', boxes, 'mail', ''),
    );

    const g = clear(grid);
    if (!domains.length) {
      g.append(h('div', { class: 'glass card', style: { gridColumn: '1/-1' } },
        h('div', { class: 'empty' }, icon('globe'),
          h('div', { class: 'empty__t' }, t('domEmptyT')),
          h('div', { class: 'empty__d' }, t('domEmptyD')),
          h('button', { class: 'btn btn--primary mt-2', onclick: () => addModal(load) }, icon('plus'), t('addDomain')))));
      return;
    }
    for (const d of domains) g.append(domainCard(d));
  }

  function domStat(key, n, icn, cls) {
    return h('div', { class: `dom-stat glass ${cls}` },
      h('span', { class: 'dom-stat__icn' }, icon(icn)),
      h('div', {}, h('div', { class: 'dom-stat__n' }, String(n)), h('div', { class: 'dom-stat__l' }, t(key))));
  }

  // one card per domain — registration state first, live health after it
  function domainCard(d) {
    const unfinished = d.status === 'draft' || d.status === 'verifying';
    const stage = d.status === 'draft' ? 1 : d.status === 'verifying' ? 2 : 3;

    // the lifecycle trail: saved → code → live
    const trail = h('div', { class: 'dom-card__trail' });
    const stages = [['domTrailSaved', 1], ['domTrailCode', 2], ['domTrailLive', 3]];
    stages.forEach(([key, n], idx) => {
      if (idx > 0) trail.append(h('span', { class: 'dom-trail__sep' }));
      trail.append(h('span', { class: `dom-trail ${n <= stage ? 'is-done' : ''} ${n === stage && unfinished ? 'is-now' : ''}` }, h('i'), h('span', {}, t(key))));
    });

    const head = h('div', { class: 'dom-card__head' },
      h('span', { class: 'dom-card__globe' }, icon('globe')),
      h('div', { class: 'dom-card__namebox' },
        h('div', { class: 'dom-card__name mono', onclick: async () => { await copyText(d.name); toast(t('copied'), 'ok', 1300); }, title: t('copy') }, d.name, icon('copy')),
        h('div', { class: 'dom-card__status' }, statusChip(d))),
    );
    if (unfinished) {
      head.append(h('button', { class: 'btn btn--sm btn--primary', onclick: () => continueWizard(d) }, icon('zap'), t('domContinue')));
    }

    const swActive = h('div', { class: `switch ${d.active ? 'is-on' : ''}` });
    swActive.onclick = async () => {
      try { await api.patch(`/api/addresses/domains/${d.id}`, { active: !d.active }); load(); } catch (er) { toast(errText(er), 'err'); }
    };
    const swCatch = h('div', { class: `switch ${d.catch_all ? 'is-on' : ''}` });
    swCatch.onclick = async () => {
      try { await api.patch(`/api/addresses/domains/${d.id}`, { catch_all: !d.catch_all }); load(); } catch (er) { toast(errText(er), 'err'); }
    };

    const nums = h('div', { class: 'dom-card__nums' },
      h('div', { class: 'dom-card__num' }, h('b', {}, String(d.address_count ?? 0)), h('span', {}, t('addressesN'))),
      h('div', { class: 'dom-card__num' }, h('b', {}, d.last_mail ? timeAgo(d.last_mail, t) : '—'), h('span', {}, t('lastMail'))),
    );

    const actions = h('div', { class: 'dom-card__actions' },
      h('button', { class: 'btn btn--sm', onclick: () => dnsCheckModal(d) }, icon('zap'), h('span', { class: 'hide-sm' }, t('dnsCheckBtn'))),
      h('button', { class: 'btn btn--sm', onclick: () => dnsModal(d.name) }, icon('help'), h('span', { class: 'hide-sm' }, t('dnsGuide'))),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'icon-btn', title: t('delete'), onclick: () => confirmBox(t('confirm'), async () => {
        try { await api.del(`/api/addresses/domains/${d.id}`); load(); } catch (er) { toast(errText(er), 'err'); }
      }) }, icon('trash')),
    );

    const card = h('div', { class: `dom-card glass ${unfinished ? 'dom-card--wip' : ''} ${!unfinished && d.last_mail ? 'is-alive' : ''}` },
      trail, head,
      h('div', { class: 'dom-card__switches' },
        h('div', { class: 'set-row set-row--card' },
          h('div', {}, h('div', { class: 'set-row__t' }, t('active')), h('div', { class: 'set-row__d' }, t('domActiveD'))), swActive),
        h('div', { class: 'set-row set-row--card' },
          h('div', {}, h('div', { class: 'set-row__t' }, t('catchAll')), h('div', { class: 'set-row__d' }, t('domCatchD'))), swCatch)),
      nums, actions);
    return card;
  }

  // registration lifecycle first (draft → verifying → verified / skipped),
  // then the running health of a live domain
  function statusChip(d) {
    if (d.status === 'draft') return chip('dom-st--draft', 'domDraft', 'edit');
    if (d.status === 'verifying') return chip('dom-st--verify', 'domVerifying', 'clock');
    if (d.status === 'unverified') return chip('dom-st--unv', 'domUnverified', 'shield');
    const st = !d.active ? ['dom-st--off', 'domOff']
      : !d.catch_all ? ['dom-st--warn', 'domNoCatch']
      : d.last_mail ? ['dom-st--ok', 'domHealthy']
      : ['dom-st--warn', 'domAwaiting'];
    const kids = [h('i'), h('span', {}, t(st[1]))];
    if (st[0] === 'dom-st--ok' && d.last_mail) {
      kids.push(h('span', { class: 'faint', style: { fontWeight: 600 } }, `· ${timeAgo(d.last_mail, t)}`));
    }
    return h('span', { class: `dom-st ${st[0]}`, title: t(st[1]) }, ...kids);
  }

  function chip(cls, key, icn) {
    return h('span', { class: `dom-st ${cls}`, title: t(key) }, h('i'), icon(icn), h('span', {}, t(key)));
  }

  // an unfinished domain reopens the wizard exactly where it stopped —
  // the rail inside tells the owner what is still missing
  function continueWizard(d) {
    openDomainWizard(d, { onDone: () => load(), onExit: () => load() });
  }

  function addModal(onDone) {
    const name = h('input', { class: 'input ltr', placeholder: 'mail.example.com' });
    const label = h('input', { class: 'input', placeholder: t('label') });
    const catchAll = h('div', { class: 'switch is-on' });
    const m = modal({
      title: t('addDomain'), iconName: 'globe',
      body: [
        h('div', { class: 'field' }, h('label', {}, t('domainName')), name),
        h('div', { class: 'field' }, h('label', {}, t('label')), label),
        h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-row__t' }, t('catchAll'))), catchAll),
      ],
      footer: [
        h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
        h('button', { class: 'btn btn--primary', onclick: async () => {
          try {
            const r = await api.post('/api/addresses/domains', { name: name.value.trim().toLowerCase(), label: label.value.trim(), catch_all: catchAll.classList.contains('is-on') });
            toast(t('saved'), 'ok', 1400);
            m.close();
            onDone();
            // the moment it exists, the connect wizard takes over —
            // that is where the real guide lives
            openDomainWizard(r.domain, { onDone, onExit: onDone });
          } catch (e) { toast(errText(e), 'err'); }
        } }, t('save')),
      ],
    });
    catchAll.addEventListener('click', () => catchAll.classList.toggle('is-on'));
  }

  // the live reality-check: the worker asks a real resolver (DNS-over-HTTPS)
  // whether MX and SPF actually exist right now — no guessing, no refresh
  function dnsCheckModal(d) {
    const box = h('div', { class: 'dns-check' }, h('div', { class: 'small muted', style: { padding: '10px 2px' } }, t('loading')));
    const m = modal({
      wide: true,
      title: `${t('dnsCheckT')} — ${d.name}`, iconName: 'zap',
      body: [box],
      footer: [
        h('button', { class: 'btn', onclick: () => run() }, icon('refresh'), t('gateRecheck')),
        h('button', { class: 'btn btn--primary', onclick: () => m.close() }, t('done')),
      ],
    });

    const verdict = (ok, okTxt, badTxt, warmTxt) => {
      const cls = ok ? 'is-ok' : (warmTxt ? 'is-warm' : 'is-bad');
      return h('div', { class: `dns-line ${cls}` },
        h('span', { class: 'dns-line__icn' }, icon(ok ? 'check' : 'x')),
        h('div', {}, h('b', {}, ok ? okTxt : (warmTxt || badTxt)), ok || !warmTxt ? h('span', { class: 'small muted' }, badTxt) : ''));
    };

    async function run() {
      clear(box).append(h('div', { class: 'small muted', style: { padding: '10px 2px' } }, t('loading')));
      let r;
      try { r = await api.get(`/api/addresses/domains/${d.id}/dns-check`); }
      catch (e) { clear(box).append(h('div', { class: 'dns-line is-bad' }, h('span', { class: 'dns-line__icn' }, icon('x')), h('div', {}, h('b', {}, t('error')), h('span', { class: 'small muted' }, errText(e))))); return; }
      const c = r.check;
      clear(box).append(
        verdict(c.mx_cloudflare, t('dnsMxOk'), t('dnsMxBad'), c.mx_ok ? t('dnsMxOther') : ''),
        c.mx_records?.length ? h('div', { class: 'dns-records mono' }, c.mx_records.map((x) => h('div', {}, x))) : '',
        verdict(c.spf_cloudflare, t('dnsSpfOk'), t('dnsSpfBad'), c.spf_ok ? t('dnsSpfOther') : ''),
        c.spf_record ? h('div', { class: 'dns-records mono' }, h('div', {}, c.spf_record)) : '',
        h('p', { class: 'small faint', style: { margin: '10px 2px 0' } }, t('dnsCheckNote')),
      );
    }
    run();
  }

  function dnsModal(domain) {
    const m = modal({
      wide: true,
      title: `${t('dnsGuide')} — ${domain}`, iconName: 'help',
      body: [
        h('table', { class: 'dns-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Priority'))),
          h('tbody', {},
            h('tr', {}, h('td', {}, 'MX'), h('td', {}, '@'), h('td', {}, h('code', {}, 'route1.mx.cloudflare.net')), h('td', {}, '10')),
            h('tr', {}, h('td', {}, 'MX'), h('td', {}, '@'), h('td', {}, h('code', {}, 'route2.mx.cloudflare.net')), h('td', {}, '20')),
            h('tr', {}, h('td', {}, 'MX'), h('td', {}, '@'), h('td', {}, h('code', {}, 'route3.mx.cloudflare.net')), h('td', {}, '30')),
            h('tr', {}, h('td', {}, 'TXT (SPF)'), h('td', {}, '@'), h('td', {}, h('code', {}, 'v=spf1 include:_spf.mx.cloudflare.net ~all')), h('td', {}, '—')),
          )),
        h('div', { class: 'step-list' },
          step(lang === 'fa'
            ? 'در داشبورد Cloudflare دامنه را باز کن و از منوی Email گزینهٔ Email Routing را روشن کن — رکوردهای MX را خودش می‌سازد.'
            : 'Open the domain in the Cloudflare dashboard and enable Email Routing from the Email menu — the MX records are created for you.'),
          step(lang === 'fa'
            ? 'در تب Routing → Catch-all address، اقدام (Action) را روی Send to Worker بگذار و ورکر Cmail را انتخاب کن؛ این همان چیزی است که نامه‌ها را به پنل می‌آورد.'
            : 'In Routing → Catch-all address, set the Action to Send to Worker and pick the Cmail worker — this is what brings the mail into the panel.'),
          step(lang === 'fa'
            ? 'بعد از ذخیره، دکمهٔ «بررسی DNS» روی کارت دامنه واقعیت رکوردها را همان لحظه نشان می‌دهد؛ اگر بعد از چند دقیقه هنوز MX ندیدی، DNS هنوز پخش نشده است، صبور باش.'
            : 'Once saved, the domain card’s “DNS check” button shows the live record truth; if MX is still missing minutes later, DNS is still propagating — give it a moment.'),
        ),
      ],
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, t('cancel'))],
    });
  }

  function step(text) {
    return h('div', { class: 'step-row' }, h('span', { class: 'step-row__num' }, '•'), h('div', { class: 'step-row__body' }, h('p', {}, text)));
  }

  function routingHelp() {
    return h('details', { class: 'guide' },
      h('summary', {}, icon('info'), lang === 'fa' ? 'چطور چند دامنه اضافه کنم؟' : 'How do I add multiple domains?'),
      h('p', { class: 'small muted' },
        lang === 'fa'
          ? 'هر دامنه (یا ساب‌دامنه) باید روی همان اکانت Cloudflare ثبت باشد. برای هر کدام سه قدم کافی است: ۱) Email Routing را روشن کن ۲) دامنه را همین‌جا اضافه کن ۳) ویزارد وصل‌کردن را تا تأیید جلو ببر. اگر وسط کار ببینی و بروی، ثبتِ ناتمام در همین صفحه می‌ماند و از همان‌جا ادامه پیدا می‌کند؛ تا وقتی کامل نشده، برایش صندوق ساخته نمی‌شود. بعد از تأیید هم دکمهٔ «بررسی DNS» روی هر کارت، سلامت رکوردها را زنده نشان می‌دهد.'
          : 'Each domain (or subdomain) must live on your Cloudflare account. Three steps per domain: 1) enable Email Routing, 2) add the domain here, 3) walk the connect wizard through verification. Leave mid-way and the unfinished registration stays right here, resuming where it stopped — mailboxes stay locked until it completes. After verification, each card’s “DNS check” button shows the live health of its records.'));
  }

  await load();
}
