// Cmail — setup gate: nothing opens until every prerequisite is connected.
// Shows live status, a progress ring, and a complete fix-guide for each missing piece.
import { api, state, errText } from '../api.js';
import { t, lang, setLang } from '../i18n.js';
import { h, clear, icon, toast, confirmBox, copyText, vibrate } from '../ui.js';
import { setTheme } from '../app.js';
import { openDomainWizard } from './domwiz.js';

const RECHECK_EVERY = 20; // seconds (auto re-check for members)

export async function renderGate(root) {
  let offline = !state.setup;
  let timer = null;
  let count = RECHECK_EVERY;

  // root IS the auth stage (route() already gave it .view--auth) —
  // wrapping it again would double-pad the page and shove the card aside
  clear(root);
  const ctrls = h('div', { class: 'auth-ctrls' },
    h('button', { class: 'glass-btn', title: t('theme'), onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, icon('sun')),
    h('button', { class: 'glass-btn', title: t('language'), onclick: () => { setLang(lang === 'fa' ? 'en' : 'fa'); renderGate(root); } }, icon('globe')),
  );
  root.append(ctrls);
  const gate = h('div', { class: 'gate' });
  root.append(gate);

  // ---------- pieces ----------
  const ring = buildRing();
  const ringVal = ring.value;

  const head = h('header', { class: 'gate__head' },
    h('img', { class: 'gate__logo', src: 'assets/img/logo-dark.png', alt: 'Cmail' }),
    h('div', { class: 'gate__eyebrow' },
      h('span', { class: 'gate__dot', id: 'gate-dot' }),
      h('span', { id: 'gate-eyebrow' }, t('gateChecking'))),
    h('h1', { class: 'gate__title' }, t('gateTitle')),
    h('p', { class: 'gate__sub' }, t('gateSub')),
  );

  const card = h('section', { class: 'gate__card glass' });
  gate.append(head, card);

  // ---------- terminal / step helpers ----------
  const term = (cmd) => h('div', { class: 'term' },
    h('span', { class: 'term__sign' }, '$'),
    h('code', {}, cmd),
    h('button', { class: 'term__copy', title: t('copy'), onclick: async () => { await copyText(cmd); toast(t('copied'), 'ok', 1400); } }, icon('copy')));

  const step = (n, node) => h('div', { class: 'tut__step' }, h('span', { class: 'tut__n' }, String(n)), h('div', { class: 'tut__step-b' }, node));

  const tutPanel = (title, iconName, ...children) => h('div', { class: 'tut' },
    h('div', { class: 'tut__head' }, icon(iconName), h('b', {}, title)),
    ...children);

  // ---------- tutorials ----------
  // database: three shapes — no binding yet / binding ok, tables missing / all good
  function tutBinding() {
    return tutPanel(t('tutDbTitle'), 'database',
      step(1, t('bind1')),
      step(2, t('bind2')),
      step(3, t('bind3')),
      step(4, h('div', {}, t('bind4'), term('npx wrangler d1 create cmail-db'))),
    );
  }

  function tutInit() {
    const btn = h('button', { class: 'btn btn--primary init-cta', type: 'button' }, icon('database'), h('span', {}, t('initBtn')));
    const st = h('span', { class: 'init-st' });
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('is-busy');
      st.textContent = t('initRunning');
      try {
        await api.post('/api/setup/init', {});
        st.textContent = '';
        toast(t('initDone'), 'ok', 2000);
        await recheck(true);
        refreshInspector();
      } catch (err) {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        st.textContent = '';
        toast(errText(err), 'err');
      }
    });
    return tutPanel(t('initTitle'), 'database',
      h('p', { class: 'tut__d' }, t('initDesc')),
      h('div', { class: 'tut__cta init-row' }, btn, st),
      inspector(),
      h('details', { class: 'tut__manual' },
        h('summary', {}, t('initManual')),
        step(1, h('div', {}, t('initManualD'), term('npx wrangler d1 execute cmail-db --remote --file=schema.sql'))),
        step(2, h('div', {}, t('initManual2')), h('p', { class: 'small muted' }, t('initManual3')))),
    );
  }

  // ---------- the D1 inspector ----------
  // every expected table with its row count, one-button build for what is
  // missing, and a clean exit for tables that were never ours
  let inspWrap = null;
  function inspector() {
    inspWrap = h('div', { class: 'd1' }, h('div', { class: 'd1__load' }, t('loading')));
    fillInspector(inspWrap);
    return inspWrap;
  }
  function refreshInspector() { if (inspWrap) fillInspector(inspWrap); }

  async function fillInspector(box) {
    let r;
    try { r = await api.get('/api/setup/tables'); }
    catch { clear(box).append(h('p', { class: 'small muted' }, t('d1CantSee'))); return; }

    const missing = r.tables.filter((x) => !x.exists);
    const head = h('div', { class: 'd1__head' },
      h('b', {}, t('d1Title')),
      missing.length
        ? h('button', {
            class: 'btn btn--sm btn--primary', onclick: async (e) => {
              const b = e.currentTarget; b.disabled = true; b.classList.add('is-busy');
              try {
                await api.post('/api/setup/tables/missing', {});
                toast(t('d1Built'), 'ok', 1800);
                await recheck(true); refreshInspector();
              } catch (err) { toast(errText(err), 'err'); b.disabled = false; b.classList.remove('is-busy'); }
            },
          }, icon('zap'), t('d1CreateMissing'))
        : h('span', { class: 'dom-st dom-st--ok' }, h('i'), icon('check'), h('span', {}, t('d1AllGood'))));

    const grid = h('div', { class: 'd1__grid' });
    for (const tb of r.tables) {
      grid.append(h('div', { class: `d1__row ${tb.exists ? 'is-ok' : 'is-miss'}` },
        h('span', { class: 'd1__icn' }, icon(tb.exists ? 'check' : 'plus')),
        h('code', { class: 'd1__name' }, tb.name),
        h('span', { class: 'd1__rows' }, tb.exists ? `${lang === 'fa' ? toFa(tb.rows ?? 0) : (tb.rows ?? 0)} ${t('d1Rows')}` : t('d1MissingShort')),
        !tb.exists ? h('button', {
          class: 'btn btn--sm', onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true; b.classList.add('is-busy');
            try {
              await api.post(`/api/setup/tables/${tb.name}/create`, {});
              toast(t('d1Built'), 'ok', 1500);
              await recheck(false); refreshInspector();
            } catch (err) { toast(errText(err), 'err'); b.disabled = false; b.classList.remove('is-busy'); }
          },
        }, icon('plus'), t('d1CreateOne')) : null,
      ));
    }

    const extras = r.extras ?? [];
    const extraBox = extras.length ? h('div', { class: 'd1__extras' },
      h('div', { class: 'd1__extra-t' }, t('d1ExtraT')),
      ...extras.map((x) => h('div', { class: 'd1__row is-extra' },
        h('span', { class: 'd1__icn' }, icon('help')),
        h('code', { class: 'd1__name' }, x.name),
        h('span', { class: 'd1__rows' }, t('d1NotOurs')),
        h('button', {
          class: 'btn btn--sm btn--danger-ghost', onclick: () => confirmBox(t('d1DropConfirm'), async () => {
            try {
              await api.del(`/api/setup/tables/${x.name}`);
              toast(t('d1Dropped'), 'ok', 1600);
              refreshInspector();
            } catch (err) { toast(errText(err), 'err'); }
          }),
        }, icon('trash'), t('d1Drop'))))) : null;

    clear(box).append(head, grid, ...(extraBox ? [extraBox] : []));
  }

  function tutDatabase() {
    const s = state.setup || {};
    if (!s.db_binding) return tutBinding();
    return tutPanel(t('tutDbTitle'), 'database',
      s.tables ? h('p', { class: 'tut__d' }, t('checkDatabaseD')) : h('p', { class: 'tut__d' }, t('initDesc')),
      inspector());
  }

  function tutAdmin() {
    const kids = [h('p', { class: 'tut__d' }, state.setup?.tables ? t('tutAdminD') : t('setupNeedDbSub'))];
    // the create/login CTA only makes sense once the tables exist — on an
    // empty database the message above is the whole story
    if (state.setup?.tables) {
      kids.push(h('div', { class: 'tut__cta' },
        h('button', { class: 'btn btn--primary', onclick: () => { location.hash = '#/login'; } },
          icon('arrow'), state.setup?.admin_created && !state.user ? t('login') : t('goMakeAccess'))));
    }
    return tutPanel(t('tutAdminTitle'), 'user', ...kids);
  }

  function tutDomain() {
    const inp = h('input', { class: 'input ltr', placeholder: 'mail.example.com', inputmode: 'url' });
    const btn = h('button', { class: 'btn btn--primary' }, icon('plus'), t('addDomain'));
    const form = h('form', { class: 'gate__inline' },
      h('div', { class: 'field grow' }, h('label', {}, t('domainName')), inp), btn);
    const listBox = h('div', { class: 'gate__doms' });

    // every domain already in the system gets its own row: drafts and
    // verifying ones offer "continue" (the wizard resumes from the saved
    // stage), unverified ones can still be verified from here — nobody ever
    // has to retype a domain to reach its wizard again
    async function drawList() {
      clear(listBox);
      let list = [];
      try { list = (await api.get('/api/addresses/domains')).domains ?? []; } catch { return; }
      const chip = (st) => {
        const map = {
          verified: ['dom-st dom-st--ok', 'check', t('gateDomVerified')],
          unverified: ['dom-st dom-st--warn', 'shield', t('gateDomUnverified')],
          verifying: ['dom-st dom-st--wait', 'refresh', t('gateDomVerifying')],
          draft: ['dom-st dom-st--wait', 'edit', t('gateDomDraft')],
        };
        const [cls, icn, label] = map[st] ?? map.draft;
        return h('span', { class: cls }, h('i'), icon(icn), h('span', {}, label));
      };
      for (const d of list) {
        const resumable = d.status === 'draft' || d.status === 'verifying';
        const row = h('div', { class: 'gate__dom' },
          h('code', { class: 'ltr' }, d.name),
          chip(d.status),
          (resumable || d.status === 'unverified')
            ? h('button', {
                class: `btn btn--sm ${resumable ? 'btn--primary' : ''}`,
                onclick: async (e) => {
                  e.currentTarget.disabled = true;
                  openDomainWizard({ ...d, stage: d.stage ?? 1 }, { onDone: () => recheck(true), onExit: () => { recheck(true); drawList(); } });
                },
              }, icon(resumable ? 'arrow' : 'shield'), resumable ? t('gateDomContinue') : t('gateDomVerifyNow'))
            : null,
        );
        listBox.append(row);
      }
      if (list.length) listBox.classList.add('has-rows'); else listBox.classList.remove('has-rows');
    }
    drawList();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = inp.value.trim().toLowerCase();
      if (!name) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/setup/domain', { name });
        toast(t('saved'), 'ok', 1600);
        inp.value = '';
        // the connect wizard takes it from here — routing guide, loop code,
        // live polling — and the gate re-checks when it closes
        openDomainWizard({ id: r.id, name: r.name, status: 'draft', stage: 1 }, { onDone: () => recheck(true), onExit: () => { recheck(true); drawList(); } });
        btn.disabled = false;
      } catch (err) {
        btn.disabled = false;
        // the one that used to look like a dead "error happened": a domain
        // that already exists is not a failure — its wizard just opens
        if (err.code === 'domain_exists') {
          inp.value = '';
          toast(t('gateDomExists'), 'info', 2400);
          let list = [];
          try { list = (await api.get('/api/addresses/domains')).domains ?? []; } catch { }
          const d = list.find((x) => x.name === name);
          if (d) openDomainWizard({ ...d, stage: d.stage ?? 1 }, { onDone: () => recheck(true), onExit: () => { recheck(true); drawList(); } });
          else drawList();
        } else toast(errText(err), 'err');
      }
    });
    return tutPanel(t('tutDomainTitle'), 'globe',
      form,
      listBox,
      h('p', { class: 'tut__d' }, t('tutDomainLead')),
    );
  }

  function tutSending() {
    const prov = h('select', { class: 'input' },
      h('option', { value: 'brevo' }, 'Brevo — 300/day free'),
      h('option', { value: 'resend' }, 'Resend — 100/day free'));
    const key = h('input', { class: 'input ltr', placeholder: 'xkeysib-… / re_…', autocomplete: 'off' });
    const from = h('input', { class: 'input ltr', placeholder: 'no-reply@yourdomain.com' });
    const btn = h('button', { class: 'btn btn--primary' }, icon('check'), t('save'));
    const form = h('form', { class: 'gate__form' },
      h('div', { class: 'field' }, h('label', {}, t('provider')), prov),
      h('div', { class: 'field' }, h('label', {}, t('apiKey')), key),
      h('div', { class: 'field' }, h('label', {}, t('fromEmail')), from),
      btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        await api.put('/api/admin/settings', {
          sending_provider: prov.value,
          sending_api_key: key.value.trim(),
          sending_from_email: from.value.trim(),
        });
        toast(t('saved'), 'ok', 1600);
        await recheck();
      } catch (err) { toast(errText(err), 'err'); btn.disabled = false; }
    });

    // the live probe: put a real test message on the wire and see it land
    const testTo = h('input', { class: 'input ltr', placeholder: 'you@anywhere.com', type: 'email' });
    const testBtn = h('button', { class: 'btn' }, icon('send'), t('sendTestBtn'));
    const testRow = h('div', { class: 'gate__inline' },
      h('div', { class: 'field grow' }, h('label', {}, t('sendTestT')), testTo), testBtn);
    testBtn.addEventListener('click', async () => {
      if (testBtn.disabled) return;
      testBtn.disabled = true; testBtn.classList.add('is-busy');
      try {
        await api.post('/api/admin/test-send', { to: testTo.value.trim() });
        toast(t('sendTestOk'), 'ok', 2600);
      } catch (err) { toast(errText(err), 'err'); }
      testBtn.disabled = false; testBtn.classList.remove('is-busy');
    });

    return tutPanel(t('tutSendingTitle'), 'send',
      h('div', { class: 'chip-opt' }, icon('info'), t('gateOptional')),
      step(1, t('tutSending1')),
      step(2, h('div', {}, t('tutSending2'), form)),
      step(3, h('div', {}, t('tutSending3'), testRow)),
    );
  }

  const isAdmin = () => !!state.user && state.user.role === 'admin';
  const tutorials = {
    database: tutDatabase,
    admin: tutAdmin,
    domain: tutDomain,
    sending: tutSending,
  };

  function memberNote() {
    const kids = [h('p', { class: 'tut__d' }, t('gateAdminNote'))];
    if (!state.user && state.setup?.admin_created) {
      kids.push(h('div', { class: 'tut__cta' },
        h('button', { class: 'btn btn--primary', onclick: () => { location.hash = '#/login'; } }, icon('arrow'), t('login'))));
    }
    return h('div', { class: 'tut' },
      h('div', { class: 'tut__head' }, icon('info'), h('b', {}, t('gateTitle'))),
      ...kids);
  }

  // ---------- check rows ----------
  const CHECKS = [
    { id: 'database', name: () => t('checkDatabase'), desc: () => t('checkDatabaseD'), icn: 'database' },
    { id: 'admin', name: () => t('checkAdmin'), desc: () => t('checkAdminD'), icn: 'user' },
    { id: 'domain', name: () => t('checkDomain'), desc: () => t('checkDomainD'), icn: 'globe' },
    { id: 'sending', name: () => t('checkSending'), desc: () => t('checkSendingD'), icn: 'send' },
  ];

  function buildRing() {
    const R = 30, C = 2 * Math.PI * R;
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '38'); circle.setAttribute('cy', '38'); circle.setAttribute('r', String(R));
    circle.setAttribute('fill', 'none'); circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '6'); circle.setAttribute('stroke-linecap', 'round');
    circle.setAttribute('stroke-dasharray', String(C)); circle.setAttribute('stroke-dashoffset', String(C));
    circle.style.transform = 'rotate(-90deg)'; circle.style.transformOrigin = 'center';
    const track = circle.cloneNode();
    track.setAttribute('stroke', 'var(--field)'); track.removeAttribute('style');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 76 76'); svg.setAttribute('class', 'ring__svg');
    svg.append(track, circle);
    const val = h('div', { class: 'ring__val' }, '—');
    const wrap = h('div', { class: 'ring' }, svg, val);
    return { el: wrap, set(pct, label) {
      circle.style.strokeDashoffset = String(C * (1 - pct));
      val.textContent = label;
    } };
  }

  function checkRow(def, i) {
    const status = () => state.setup?.checks?.find((x) => x.id === def.id)?.ok;
    const pill = h('span', { class: 'check__pill' }, t('gateWaiting'));
    const icn = h('span', { class: 'check__icn' }, icon(def.icn));
    const opt = def.id === 'sending' ? h('span', { class: 'chip-opt' }, t('gateOptional')) : null;
    const row = h('div', { class: 'check', style: { animationDelay: `${i * 90}ms` } },
      icn,
      h('div', { class: 'check__txt' }, h('b', {}, def.name(), ' ', opt), h('span', {}, def.desc())),
      pill);
    const tutBox = h('div', { class: 'check__tut', style: { display: 'none' } });
    return { row, tutBox, def,
      refresh(animate) {
        const st = offline ? false : status();
        row.classList.toggle('is-ok', st === true);
        row.classList.toggle('is-bad', st === false);
        row.classList.toggle('is-unk', st == null);
        pill.textContent = st == null ? t('gateWaiting') : st ? t('gateConnected') : t('gateNotConnected');
        if (st === false) {
          icn.innerHTML = icon(def.icn).innerHTML;
          // the database step is public on purpose: a fresh deployment has no
          // session yet, and the one-click table setup must be reachable then.
          // same for the account step on a fresh install — someone has to be
          // able to reach the "create access" form in the first place. but the
          // form only exists once the tables do: offering it on an empty D1
          // used to strand Deploy-button users on a password form that could
          // never succeed.
          const freshAdmin = def.id === 'admin' && !state.setup?.admin_created && !!state.setup?.tables;
          const body = isAdmin() || def.id === 'database' || freshAdmin
            ? tutorials[def.id]?.() ?? memberNote()
            : memberNote();
          clear(tutBox).append(body);
          tutBox.style.display = '';
        } else {
          tutBox.style.display = 'none';
          clear(tutBox);
        }
        if (animate && st !== null) {
          row.classList.remove('pop'); void row.offsetWidth; row.classList.add('pop');
        }
      } };
  }

  const rows = CHECKS.map(checkRow);
  const checksBox = h('div', { class: 'gate__checks' }, rows.map((r) => [r.row, r.tutBox]).flat());

  // recheck button + auto label
  const reBtn = h('button', { class: 'btn btn--primary', onclick: () => recheck(true) }, icon('refresh'), t('gateRecheck'));
  const autoLbl = h('span', { class: 'gate__auto' });

  // ---------- draw ----------
  function drawCard() {
    clear(card);
    if (offline) { drawOffline(); return; }
    // the ring counts required connections only — the optional one rides along
    const checks = state.setup?.checks ?? [];
    const req = checks.filter((x) => !x.optional);
    const okN = req.filter((x) => x.ok).length;
    const total = Math.max(req.length, 1);
    ring.set(okN / total, `${lang === 'fa' ? toFa(okN) : okN}`);
    const allOk = state.setup?.ready ?? okN === total;

    const top = h('div', { class: 'gate__top' },
      ring.el,
      h('div', { class: 'gate__top-txt' },
        h('h2', {}, allOk ? t('gateAllOk') : `${lang === 'fa' ? toFa(okN) : okN} ${t('gateOf')} ${lang === 'fa' ? toFa(total) : total} ${lang === 'fa' ? 'اتصال برقرار است' : 'connections up'}`),
        h('p', {}, allOk ? t('gateAllOkSub') : (state.user ? t('gateHintFix') : t('gateAdminNote'))),
        h('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } }, reBtn, autoLbl)));
    card.append(top, checksBox);
    rows.forEach((r) => r.refresh(false));

    if (allOk) {
      card.classList.add('is-done');
      const stay = location.hash.includes('stay');
      if (!card.dataset.celebrated) {
        card.dataset.celebrated = '1';
        celebrate();
      }
      if (stay && state.user) {
        clear(reBtn);
        reBtn.append(icon('inbox'), t('navMail'));
        reBtn.onclick = () => { location.hash = '#/mail'; };
        autoLbl.textContent = '';
      } else if (!stay) {
        setTimeout(() => { location.hash = state.user ? '#/mail' : '#/login'; }, 1500);
      }
    } else {
      card.classList.remove('is-done');
      delete card.dataset.celebrated;
    }
    updateEyebrow();
  }

  // success moment: one-shot confetti burst in accent colors
  function celebrate() {
    vibrate([10, 40, 10, 40, 18]);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#b9cda3', '#a7cbd6', '#cab6da', '#e3c795', '#93c793', '#ffffff'];
    const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    for (let i = 0; i < 56; i++) {
      const p = h('i');
      const round = Math.random() > .6;
      p.style.cssText =
        `left:${Math.random() * 100}vw;` +
        `background:${colors[i % colors.length]};` +
        `width:${round ? 8 : 6 + Math.random() * 4}px;height:${round ? 8 : 10 + Math.random() * 8}px;` +
        `border-radius:${round ? '50%' : '2px'};` +
        `animation-duration:${2.2 + Math.random() * 1.8}s;` +
        `animation-delay:${Math.random() * .7}s;` +
        `transform:rotate(${Math.random() * 360}deg);`;
      box.append(p);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 5200);
  }

  function drawOffline() {
    ring.set(0, '—');
    card.append(
      h('div', { class: 'gate__top' },
        h('div', { class: 'illus-plate illus-plate--sm' }, h('img', { src: 'assets/img/offline.webp', alt: '', width: '720', height: '720', decoding: 'async' })),
        h('div', { class: 'gate__top-txt' },
          h('h2', {}, t('offlineTitle')),
          h('p', {}, t('offlineD')),
          h('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } }, reBtn))),
      h('div', { class: 'tut', style: { marginTop: '14px' } },
        step(1, term('cd cmail && npm run dev')),
        step(2, t('offlineStep2'))),
    );
    updateEyebrow();
  }

  function updateEyebrow() {
    const dot = document.getElementById('gate-dot');
    const lbl = document.getElementById('gate-eyebrow');
    if (!dot || !lbl) return;
    dot.classList.toggle('is-off', offline);
    lbl.textContent = offline ? t('network') : t('onlineBadge');
  }

  async function recheck(manual) {
    if (manual) { reBtn.disabled = true; reBtn.classList.add('spin'); }
    try {
      const s = await api.get('/api/setup/status');
      if (s?.ready !== undefined) state.setup = s;
      offline = false;
      if (manual) toast(t('onlineBadge'), 'ok', 1400);
    } catch {
      offline = true;
      if (manual) toast(t('network'), 'err');
    }
    if (manual) { reBtn.disabled = false; reBtn.classList.remove('spin'); }
    count = RECHECK_EVERY;
    drawCard();
  }

  // auto re-check loop
  timer = setInterval(async () => {
    if (offline) { count = RECHECK_EVERY; autoLbl.textContent = ''; return; }
    if (state.setup?.ready) { autoLbl.textContent = ''; return; }
    count -= 1;
    autoLbl.textContent = `${t('gateAutoIn')} ${lang === 'fa' ? toFa(Math.max(count, 0)) : Math.max(count, 0)}${t('gateSeconds')}`;
    if (count <= 0) {
      count = RECHECK_EVERY;
      try {
        const s = await api.get('/api/setup/status');
        const before = JSON.stringify(state.setup?.checks ?? []);
        state.setup = s; offline = false;
        if (JSON.stringify(s.checks ?? []) !== before) drawCard();
      } catch { offline = true; drawCard(); }
    }
  }, 1000);

  // first paint: staggered
  drawCard();
  if (!state.setup) await recheck(false);
}

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
function toFa(n) { return String(n).replace(/\d/g, (d) => FA_DIGITS[+d]); }
