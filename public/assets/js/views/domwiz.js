// Cmail — the domain connect wizard.
// One flow, two entrances (domains page + setup gate):
//   1 · connect  — a crisp guide through Email Routing, ending at "I connected it"
//   2 · verify   — a one-of-a-kind loop code the owner mails to their own domain;
//                  the inbox polls every few seconds until the worker confirms it
// Exit at any point → "save as draft, or leave for good?" — drafts resume
// exactly where they stopped, straight from the domains table.
import { api, errText } from '../api.js';
import { t, lang } from '../i18n.js';
import { h, clear, icon, toast, modal, copyText, vibrate } from '../ui.js';
import { copyLine, dnsTable } from './auth.js';

const POLL_MS = 4000;

const fa = lang === 'fa';
const faNum = (n) => fa ? String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]) : String(n);

// progress rail: two stations, the active one lit
function rail(active) {
  const st = (i, label) => h('div', { class: `wiz__st ${active === i ? 'is-on' : ''} ${active > i ? 'is-done' : ''}` },
    h('span', { class: 'wiz__st-n' }, active > i ? icon('check') : faNum(i)),
    h('span', { class: 'wiz__st-t' }, label));
  return h('div', { class: 'wiz__rail' }, st(1, t('wizStepConnect')), h('span', { class: 'wiz__rail-l' }), st(2, t('wizStepVerify')));
}

export function openDomainWizard(domain, { onDone, onExit } = {}) {
  let pollTimer = null;
  let alive = true;

  const m = modal({
    wide: true,
    title: `${t('wizTitle')} — ${domain.name}`,
    iconName: 'globe',
    onClose: () => { alive = false; if (pollTimer) clearInterval(pollTimer); },
  });
  const body = m.body;

  const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

  // ---------- exit dialog: save as draft, or leave for good ----------
  function exitDialog() {
    const ex = modal({
      title: t('wizExitT'), iconName: 'info',
      body: [h('p', { class: 'wiz__exit-d' }, t('wizExitD'))],
      footer: [
        h('button', {
          class: 'btn btn--danger', onclick: async () => {
            ex.close(); stopPoll(); alive = false;
            try { await api.del(`/api/addresses/domains/${domain.id}`); toast(t('wizDropped'), 'ok', 1800); } catch (e) { toast(errText(e), 'err'); }
            m.close(); onExit?.();
          },
        }, icon('trash'), t('wizExitDrop')),
        h('button', {
          class: 'btn btn--primary', onclick: async () => {
            try { await api.post(`/api/addresses/domains/${domain.id}/wizard`, { action: 'draft' }); toast(t('wizSaved'), 'ok', 1800); } catch (e) { toast(errText(e), 'err'); }
            ex.close(); stopPoll(); alive = false; m.close(); onDone?.({ ...domain, status: 'draft' });
          },
        }, icon('check'), t('wizExitSave')),
      ],
    });
  }

  // ---------- stage 1 · connect ----------
  function stageConnect() {
    stopPoll();
    clear(body).append(
      rail(1),
      h('p', { class: 'wiz__lead' }, t('wizConnLead'), ' ', h('b', { class: 'mono ltr' }, domain.name)),
      guide(),
      h('div', { class: 'wiz__foot' },
        h('button', { class: 'btn btn--ghost', onclick: exitDialog }, icon('logout'), t('wizExit')),
        h('button', {
          class: 'btn btn--primary', onclick: async () => {
            try {
              const r = await api.post(`/api/addresses/domains/${domain.id}/wizard`, { action: 'connect' });
              vibrate([8, 30, 8]);
              stageVerify(r);
            } catch (e) { toast(errText(e), 'err'); }
          },
        }, icon('check'), t('wizConnDone')),
      ),
    );
  }

  function guide() {
    const lnk = h('a', { class: 'btn btn--sm', href: 'https://dash.cloudflare.com', target: '_blank', rel: 'noopener' },
      icon('external'), 'Cloudflare Dashboard');
    return h('div', { class: 'wiz__guide' },
      guideStep('globe', t('wizConn1'), lnk),
      guideStep('mail', t('wizConn2')),
      guideStep('columns', t('wizConn3')),
      guideStep('check', t('wizConn4')),
      h('details', { class: 'tut__manual wiz__dns' },
        h('summary', {}, t('wizDnsToggle')),
        dnsTable([
          ['MX', '@', 'route1.mx.cloudflare.net', '10'],
          ['MX', '@', 'route2.mx.cloudflare.net', '20'],
          ['MX', '@', 'route3.mx.cloudflare.net', '30'],
        ]),
        copyLine('v=spf1 include:_spf.mx.cloudflare.net ~all')),
    );
  }

  function guideStep(icn, text, extra) {
    return h('div', { class: 'wiz__gstep' },
      h('span', { class: 'wiz__gicn' }, icon(icn)),
      h('div', { class: 'wiz__gtxt' }, h('p', {}, text), extra ? extra : null));
  }

  // ---------- stage 2 · verify ----------
  function stageVerify(state) {
    // state: {status, stage, verify_code, verify_expires, verify_address}
    const addr = state.verify_address ?? `${state.verify_code}@${domain.name}`;
    let expiry = state.verify_expires ?? 0;

    const codeChip = h('div', { class: 'wiz__code' },
      h('code', { class: 'ltr' }, addr),
      h('button', {
        class: 'icon-btn', title: t('copy'), onclick: async () => { await copyText(addr); toast(t('copied'), 'ok', 1400); },
      }, icon('copy')));

    const liveDot = h('span', { class: 'wiz__pulse' });
    const liveTxt = h('span', {}, t('wizPolling'));
    const expireTxt = h('span', { class: 'wiz__exp' });

    const panel = h('div', { class: 'wiz__verify' },
      rail(2),
      h('p', { class: 'wiz__lead' }, t('wizVerifyLead')),
      codeChip,
      h('div', { class: 'wiz__howto' }, t('wizVerifyHow')),
      h('div', { class: 'wiz__live' }, liveDot, liveTxt, expireTxt),
      h('div', { class: 'wiz__foot' },
        h('button', { class: 'btn btn--ghost', onclick: exitDialog }, icon('logout'), t('wizExit')),
        h('button', { class: 'btn', onclick: () => resend() }, icon('refresh'), t('wizResend')),
        h('button', { class: 'btn btn--ghost wiz__skip', onclick: skipDialog }, icon('shield'), t('wizSkip')),
      ),
    );
    clear(body).append(panel);

    async function resend() {
      try {
        const r = await api.post(`/api/addresses/domains/${domain.id}/wizard`, { action: 'connect' });
        toast(t('wizResent'), 'ok', 1600);
        stageVerify(r);
      } catch (e) { toast(errText(e), 'err'); }
    }

    // the loop: every few seconds, ask the worker whether the code mail landed
    async function tick() {
      if (!alive) return;
      try {
        const r = await api.get(`/api/addresses/domains/${domain.id}/verify`);
        const d = r.domain ?? {};
        if (d.status === 'verified') { success(); return; }
        if (d.code_expired) {
          liveTxt.textContent = t('wizExpired');
          liveDot.classList.add('is-bad');
          expireTxt.textContent = '';
          return;
        }
        expiry = d.verify_expires ?? expiry;
      } catch { /* transient network blip — keep pulsing */ }
    }

    function success() {
      stopPoll(); vibrate([10, 40, 10, 40, 18]);
      clear(body).append(
        h('div', { class: 'wiz__done' },
          h('div', { class: 'wiz__done-icn' }, icon('check')),
          h('h3', {}, t('wizVerifiedT')),
          h('p', {}, t('wizVerifiedD')),
          h('div', { class: 'wiz__foot wiz__foot--c' },
            h('button', { class: 'btn btn--primary', onclick: () => { m.close(); onDone?.({ ...domain, status: 'verified', stage: 3 }); } },
              icon('inbox'), t('wizFinish'))),
        ));
    }

    stopPoll();
    liveDot.classList.add('is-on');
    tick();
    pollTimer = setInterval(tick, POLL_MS);

    // expiry countdown, second by second
    const cd = setInterval(() => {
      if (!alive) { clearInterval(cd); return; }
      const left = expiry - Date.now();
      if (left <= 0) { expireTxt.textContent = ''; return; }
      const h2 = Math.floor(left / 3600_000), m2 = Math.floor((left % 3600_000) / 60_000);
      expireTxt.textContent = `${t('wizCodeExpire')} · ${faNum(h2)}:${faNum(String(m2).padStart(2, '0'))}`;
    }, 1000);
  }

  function skipDialog() {
    const sk = modal({
      title: t('wizSkipWarnT'), iconName: 'alarm',
      body: [h('p', { class: 'wiz__warn-d' }, t('wizSkipWarnD'))],
      footer: [
        h('button', { class: 'btn', onclick: () => sk.close() }, t('cancel')),
        h('button', {
          class: 'btn btn--danger', onclick: async () => {
            try {
              await api.post(`/api/addresses/domains/${domain.id}/wizard`, { action: 'skip', confirm: true });
              toast(t('wizUnverifiedDone'), 'info', 2600);
              sk.close(); stopPoll(); alive = false; m.close();
              onDone?.({ ...domain, status: 'unverified', stage: 3 });
            } catch (e) { toast(errText(e), 'err'); }
          },
        }, t('wizSkipYes')),
      ],
    });
  }

  // ---------- entry point: resolve the saved stage ----------
  (async () => {
    try {
      const r = await api.get(`/api/addresses/domains/${domain.id}/verify`);
      const d = r.domain ?? {};
      domain = { ...domain, ...d };
      if (d.status === 'verifying') stageVerify(d);
      else if (d.status === 'draft' && d.stage >= 2) {
        // resume: reactivate the loop, then open the verify step
        const rr = await api.post(`/api/addresses/domains/${domain.id}/wizard`, { action: 'resume' });
        stageVerify(rr);
        clear(body).prepend(h('div', { class: 'wiz__resume' }, icon('info'), t('wizResumeD')));
      } else if (d.status === 'unverified') {
        // skipped verification earlier — coming back later must still offer
        // the real code loop, not just a dead end
        clear(body).append(
          h('div', { class: 'wiz__done' },
            h('div', { class: 'wiz__done-icn is-warn' }, icon('shield')),
            h('h3', {}, t('domUnverified')),
            h('p', {}, t('wizUnverifiedDone')),
            h('div', { class: 'wiz__foot wiz__foot--c' },
              h('button', {
                class: 'btn', onclick: async () => {
                  try {
                    const r = await api.post(`/api/addresses/domains/${domain.id}/wizard`, { action: 'connect' });
                    stageVerify(r);
                  } catch (e) { toast(errText(e), 'err'); }
                },
              }, icon('refresh'), t('gateDomVerifyNow')),
              h('button', { class: 'btn btn--primary', onclick: () => { m.close(); onDone?.({ ...domain, status: 'unverified', stage: 3 }); } }, t('wizFinish')))));
      } else stageConnect();
    } catch {
      stageConnect(); // offline or not found — the guide is still the safe default
    }
  })();
}
