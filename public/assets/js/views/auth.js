// Cmail — views: first-run access creation + login (owner AND share guest) / 2FA
// Single-user ecosystem: the first visit creates the one account, then it is
// login-only. Since v3.0.0 the sign-in card carries two doors: the owner's
// account door and the shared-access door (بخش ورود اشتراکی) — the credential
// an admin handed out signs the guest straight into its shared mailboxes.
import { api, state, errText } from '../api.js';
import { t, lang, setLang } from '../i18n.js';
import { h, clear, icon, toast, copyText, vibrate, shareFrozen } from '../ui.js';
import { setTheme } from '../app.js';

// shared recovery copy-lines (used on the login page AND in the help view)
export function recoveryCopyLine(text) {
  const btn = h('button', { class: 'btn btn--sm btn--ghost', onclick: async () => { await copyText(text); toast(t('copied'), 'ok', 1500); } }, icon('copy'));
  return h('div', { class: 'copy-line' }, h('span', {}, text), btn);
}

export function stepRow(n, title, desc) {
  return h('div', { class: 'step-row' }, h('span', { class: 'step-row__num' }, String(n)),
    h('div', { class: 'step-row__body' }, h('h4', {}, title), h('p', {}, desc)));
}

// the account-recovery panel: how to get the username / reset the password from D1 Console
export function recoveryPanel({ open = false } = {}) {
  const body = h('div', { class: 'rec-body' });
  body.append(
    h('p', { class: 'small muted rec-lead' }, t('loginHelpSub')),
    stepRow(1, t('recStep1'), ''),
    recoveryCopyLine('SELECT username FROM users;'),
    stepRow(2, t('recStep3'), ''),
    recoveryCopyLine("UPDATE users SET password_hash = 'pbkdf2$100000$Y21haWwtcmVjb3Zlci1zYWx0MQ==$lvVylyVdxsS9Ji19drxw9ko72vDhlyHCDf5dSIC9Z/c=' WHERE role = 'admin';"),
    h('div', { class: 'rec-warn' }, icon('shield'), h('span', {}, t('recWarn'))),
  );
  return h('details', { class: `auth-help ${open ? 'is-open' : ''}`, open }, h('summary', {}, icon('help'), t('loginHelp')), body);
}

export function renderLogin(root) {
  // root IS the auth stage (route() already gave it .view--auth) — no extra
  // wrapper, or the double padding shoves the card off-center on desktop
  clear(root);
  // living aurora backdrop — the sign-in stage breathes with the accent color
  root.append(h('div', { class: 'auth-aurora', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  const wrap = h('div', { class: 'auth-wrap' });
  root.append(wrap);

  // header controls
  const ctrls = h('div', { class: 'auth-ctrls' },
    h('button', { class: 'glass-btn', title: t('theme'), onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, icon('sun')),
    h('button', { class: 'glass-btn', title: t('language'), onclick: () => { setLang(lang === 'fa' ? 'en' : 'fa'); clear(root); renderLogin(root); } }, icon('globe')),
  );
  root.append(ctrls);

  const logo = h('img', { class: 'auth-logo', src: 'assets/img/logo-dark.png', alt: 'Cmail' });
  wrap.append(logo);
  wrap.append(h('p', { class: 'auth-foot' }, t('tagline')));

  const firstRun = !state.setup?.admin_created;
  const withUsername = state.setup?.login_username !== false;
  let pending = null;
  let form = null;
  // which door is open — 'account' (owner / first run) or 'share' (guest)
  let door = 'account';

  const card = h('div', { class: 'auth-card glass' });
  wrap.append(card);

  // ---------- the two doors: account ↔ shared access ----------
  // a slim segmented control above the card; the guest door only exists once
  // the admin account exists (before that there is nothing to share yet)
  let seg = null;
  if (!firstRun) {
    const accBtn = h('button', { class: 'auth-seg__btn is-on', type: 'button' }, icon('user'), t('loginTabAccount'));
    const shareBtn = h('button', { class: 'auth-seg__btn', type: 'button' }, icon('users'), t('loginTabShare'));
    accBtn.addEventListener('click', () => {
      if (door === 'account') return;
      door = 'account'; vibrate(5);
      accBtn.classList.add('is-on'); shareBtn.classList.remove('is-on');
      drawLogin();
    });
    shareBtn.addEventListener('click', () => {
      if (door === 'share') return;
      door = 'share'; vibrate(5);
      shareBtn.classList.add('is-on'); accBtn.classList.remove('is-on');
      drawShareLogin();
    });
    seg = h('div', { class: 'auth-seg', role: 'tablist' }, accBtn, shareBtn);
    wrap.append(seg);
  }

  function field(label, type, name, value, autofocus) {
    const input = h('input', { class: 'input', type, name, value, autocomplete: type === 'password' ? (firstRun ? 'new-password' : 'current-password') : 'username', required: true });
    // autofocus belongs to pointer devices only: on phones, focusing an input
    // the moment the page opens pops the keyboard and scrolls the page — the
    // load-moment jump users reported on "some devices"
    if (autofocus && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) setTimeout(() => input.focus(), 60);
    return h('div', { class: 'field' }, h('label', {}, label), input);
  }

  function shakeCard() {
    vibrate([12, 50, 12]);
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 600);
  }

  function afterAuth() {
    location.hash = state.setup?.ready ? '#/mail' : '#/status';
  }

  function drawCreate() {
    clear(card);
    card.append(
      h('h2', { class: 'auth-title' }, t('createTitle')),
      h('p', { class: 'auth-sub' }, t('createSub')),
    );
    form = h('form', { class: 'auth-form' });
    if (withUsername) form.append(field(t('username'), 'text', 'username', '', true));
    form.append(field(t('password'), 'password', 'password', ''));
    form.append(field(t('confirmPassword'), 'password', 'confirm', ''));

    const submitBtn = h('button', { class: 'btn btn--primary', type: 'submit', style: { marginTop: '4px' } },
      icon('plus'), t('createAccess'));
    form.append(submitBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form).entries());
      if (fd.password !== fd.confirm) { toast(t('passwordMismatch'), 'err'); shakeCard(); return; }
      submitCreate(fd);
    });
    card.append(form);
    card.append(h('p', { class: 'auth-note' }, icon('shield'), t('createNote')));
  }

  function drawLogin() {
    clear(card);
    card.append(
      h('h2', { class: 'auth-title' }, t('loginTitle')),
      h('p', { class: 'auth-sub' }, withUsername ? t('loginSub') : t('loginSubPass')),
    );
    form = h('form', { class: 'auth-form' });
    if (withUsername) form.append(field(t('username'), 'text', 'username', '', true));
    form.append(field(t('password'), 'password', 'password', '', !withUsername));

    const submitBtn = h('button', { class: 'btn btn--primary', type: 'submit', style: { marginTop: '4px' } },
      icon('arrow'), t('login'));
    form.append(submitBtn);
    form.addEventListener('submit', (e) => { e.preventDefault(); submitLogin(Object.fromEntries(new FormData(form).entries()), 'account'); });
    card.append(form);
    card.append(recoveryPanel());
  }

  // ---------- the shared-access door ----------
  function drawShareLogin() {
    clear(card);
    card.append(
      h('div', { class: 'auth-share__sigil', 'aria-hidden': 'true' }, icon('users')),
      h('h2', { class: 'auth-title' }, t('shareLoginTitle')),
      h('p', { class: 'auth-sub' }, t('shareLoginSub')),
    );
    form = h('form', { class: 'auth-form' });
    form.append(field(t('username'), 'text', 'username', '', true));
    form.append(field(t('password'), 'password', 'password', ''));

    const submitBtn = h('button', { class: 'btn btn--primary', type: 'submit', style: { marginTop: '4px' } },
      icon('users'), t('shareLoginBtn'));
    form.append(submitBtn);
    form.addEventListener('submit', (e) => { e.preventDefault(); submitLogin(Object.fromEntries(new FormData(form).entries()), 'share'); });
    card.append(form);
    card.append(h('p', { class: 'auth-note' }, icon('key'), t('shareLoginHint')));
  }

  // the honest fresh-install answer: no credential form exists yet because
  // the database has no tables (Deploy-button flow provisions an empty D1)
  // or the system state is unknown — the setup gate owns both cases
  function drawDbPending() {
    clear(card);
    card.append(
      h('h2', { class: 'auth-title' }, t('setupNeedDbTitle')),
      h('p', { class: 'auth-sub' }, t('setupNeedDbSub')),
    );
    const btn = h('button', { class: 'btn btn--primary', type: 'button', style: { width: '100%' } },
      icon('database'), t('setupNeedDbBtn'));
    btn.addEventListener('click', () => { location.hash = '#/status'; });
    card.append(h('div', { class: 'auth-form' }, btn));
  }

  async function submitCreate(fd) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api.post('/api/setup/admin', { username: (fd.username ?? '').trim(), password: fd.password });
      state.user = r.user;
      if (state.setup) state.setup.admin_created = true;
      toast(t('welcomeAccess'), 'ok', 2200);
      afterAuth();
    } catch (e) {
      // a raw D1 error must never strand a fresh install on a form that can
      // never succeed — hand the visitor to the gate that builds the tables
      if (e?.code === 'tables_missing') {
        toast(t('setupNeedDbToast'), 'err', 2600);
        setTimeout(() => { location.hash = '#/status'; }, 900);
        return;
      }
      toast(errText(e), 'err');
      shakeCard();
      btn.disabled = false;
    }
  }

  async function submitLogin(fd, fromDoor) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api.post('/api/auth/login', { username: (fd.username ?? '').trim(), password: fd.password });
      if (r.totp_required) { pending = r.pending; drawTotp(); return; }
      state.user = r.user;
      // the credential the admin handed out may carry a welcome note — the
      // guest reads it the second it lands, straight from its own admin
      if (fromDoor === 'share' && r.user?.share?.note) toast(r.user.share.note, 'info', 6000);
      afterAuth();
      // an emptied share suspends at the door — the frozen waiting room
      // answers instead of a broken empty inbox, and melts on its own when
      // the first new email lands
      if (fromDoor === 'share' && r.suspended) shareFrozen(r.user?.share ?? null);
    } catch (e) {
      toast(errText(e), 'err');
      shakeCard();
      btn.disabled = false;
    }
  }

  function drawTotp() {
    clear(card);
    card.append(
      h('h2', { class: 'auth-title' }, t('totpTitle')),
      h('p', { class: 'auth-sub' }, t('totpSub')),
    );
    const codeInput = h('input', {
      class: 'input mono', style: { textAlign: 'center', fontSize: '22px', letterSpacing: '8px' },
      inputmode: 'numeric', autocomplete: 'one-time-code', name: 'totp', maxlength: '8',
      placeholder: '••••••', pattern: '[0-9]*',
    });
    const btn = h('button', { class: 'btn btn--primary', type: 'submit', style: { width: '100%' } }, icon('shield'), t('verify'));
    const back = h('button', { class: 'btn btn--ghost', type: 'button', style: { width: '100%' } }, icon('arrow'), t('totpBack'));
    const f = h('form', { class: 'auth-form' },
      h('div', { class: 'field' }, h('label', {}, t('totpTitle')), codeInput), btn, back);
    back.addEventListener('click', () => (door === 'share' ? drawShareLogin() : drawLogin()));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await api.post('/api/auth/login/totp', { pending, code: codeInput.value.trim() });
        state.user = r.user;
        afterAuth();
      } catch (err) {
        toast(errText(err), 'err');
        shakeCard();
        btn.disabled = false;
        codeInput.value = '';
        if (err.code === 'pending_expired') {
          // the 5-minute window closed — send the user back to the password
          // step instead of leaving them on a form that can never succeed
          setTimeout(() => (door === 'share' ? drawShareLogin() : drawLogin()), 900);
          return;
        }
        codeInput.focus();
      }
    });
    card.append(f);
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) setTimeout(() => codeInput.focus(), 60);
  }

  // hard guard: while the database state is unknown or the tables are not
  // built yet, NO credential form is drawn — the setup gate is the only door
  const dbPending = !state.setup || !state.setup.tables;
  if (dbPending) { drawDbPending(); return; }
  if (firstRun) drawCreate(); else drawLogin();
}

export function dnsTable(rows) {
  return h('table', { class: 'dns-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Priority'))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
}

export function copyLine(text) {
  const btn = h('button', { class: 'btn btn--sm btn--ghost', onclick: async () => { await copyText(text); toast(t('copied'), 'ok', 1500); } }, icon('copy'));
  return h('div', { class: 'copy-line' }, h('span', {}, text), btn);
}
