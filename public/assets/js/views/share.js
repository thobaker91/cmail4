// Cmail — the Share pane (Settings → اشتراک‌گذاری), v3.0.0 r6
// One credential, MANY mailboxes, one permission list. The admin hands a
// guest a username/password (shown exactly once), picks which mailboxes the
// guest may enter, what the guest may do, how many browsers may stay signed
// in, until when — and even leaves a welcome note the guest reads the moment
// it lands. r6 completes the lifecycle: credentials stay VIEWABLE and can be
// REGENERATED anytime, every device/session is listed and killable one by
// one, and suspension is the admin's own hand — with the choice that the
// remaining subscription time keeps burning or stands perfectly still while
// suspended (the leftover time shows on the chip and on the guest's frozen
// page either way).
import { api, state, errText } from '../api.js';
import { t, lang } from '../i18n.js';
import { h, clear, icon, toast, modal, confirmBox, copyText, vibrate, timeAgo } from '../ui.js';

const PERMS = [
  ['read', 'sharePermRead'],
  ['star', 'sharePermStar'],
  ['archive', 'sharePermArchive'],
  ['delete', 'sharePermDelete'],
  ['compose', 'sharePermCompose'],
  ['notes', 'sharePermNotes'],
];

// device-cap presets — 0 means “as many browsers as it takes”
const DEVICE_CAPS = [
  [0, 'shareDev0'],
  [1, 'shareDev1'],
  [2, 'shareDev2'],
  [3, 'shareDev3'],
];

// friendly random generators — unambiguous letters only (no 0/O, 1/l)
const ALPHA = 'abcdefghjkmnpqrstuvwxyz';
const ALNUM = 'abcdefghjkmnpqrstuvwxyz23456789';
function rnd(n, pool = ALNUM) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => pool[b % pool.length]).join('');
}
const genUsername = () => `guest-${rnd(5)}`;
const genPassword = () => `Cm-${rnd(4)}-${rnd(4)}-${rnd(4)}`;

function dhms(ms) {
  if (ms <= 0) return t('expired');
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return lang === 'fa' ? `${d ? d + ' روز و ' : ''}${hh}:${mm}:${ss}` : `${d ? d + 'd ' : ''}${hh}:${mm}:${ss}`;
}

// a human line for a raw User-Agent — device + platform, short and honest
function deviceName(ua) {
  const s = String(ua || '');
  const os = /iPhone/i.test(s) ? 'iPhone'
    : /iPad/i.test(s) ? 'iPad'
    : /Android/i.test(s) ? 'Android'
    : /Windows/i.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux' : '';
  const br = /Edg\//i.test(s) ? 'Edge'
    : /OPR\//i.test(s) ? 'Opera'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Safari\//i.test(s) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ') || t('shareDevUnknown');
}

// the mailbox picker: one chip per address, tap to include / exclude.
// `selected` is a Set that the chips keep in sync.
function mailboxPicker(addresses, selected) {
  const grid = h('div', { class: 'share-addrgrid' });
  const chips = addresses.map((a) => {
    const chip = h('button', {
      class: `chip share-addr ${selected.has(a.id) ? 'is-on' : ''}`, type: 'button',
      title: a.address,
      onclick: (e) => {
        vibrate(5);
        if (selected.has(a.id)) { selected.delete(a.id); e.currentTarget.classList.remove('is-on'); }
        else { selected.add(a.id); e.currentTarget.classList.add('is-on'); }
      },
    }, icon('mail'), h('span', { class: 'share-addr__t' }, a.label || a.address),
      h('span', { class: 'share-addr__n mono' }, a.address.split('@')[1] ?? ''));
    grid.append(chip);
    return chip;
  });
  if (!chips.length) grid.append(h('span', { class: 'small muted' }, t('shareNoAddress')));
  return grid;
}

export async function sharePane() {
  const pane = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

  let addresses = [];
  try { addresses = (await api.get('/api/addresses')).addresses ?? []; } catch { /* drawn empty */ }
  let shares = [];
  try { shares = (await api.get('/api/share')).shares ?? []; } catch (e) { toast(errText(e), 'err'); }

  // ---------- create card ----------
  // the mailbox set — at least one, as many as exist
  const picked = new Set(addresses.length ? [addresses[0].id] : []);
  const picker = mailboxPicker(addresses, picked);
  const labelIn = h('input', { class: 'input', placeholder: t('shareLabelPh'), maxlength: '60' });

  const userIn = h('input', { class: 'input ltr mono', value: genUsername(), maxlength: '32', autocomplete: 'off' });
  const passIn = h('input', { class: 'input ltr mono', value: genPassword(), maxlength: '64', autocomplete: 'off' });
  const dice = (input, gen) => h('button', {
    class: 'btn btn--sm btn--ghost', title: t('shareDice'), type: 'button',
    onclick: () => { input.value = gen(); vibrate(5); },
  }, icon('spark'));

  // device cap — how many browsers may hold this credential at once
  let deviceCap = 0;
  const devRow = h('div', { class: 'row row--wrap' },
    ...DEVICE_CAPS.map(([n, key]) => h('button', {
      class: `chip ${n === 0 ? 'is-on' : ''}`, type: 'button',
      onclick: (e) => {
        vibrate(5); deviceCap = n;
        devRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on'));
        e.currentTarget.classList.add('is-on');
      },
    }, t(key))));

  // the welcome note — the guest reads it right after its first sign-in
  const noteIn = h('textarea', { class: 'input', rows: '2', maxlength: '240', placeholder: t('shareNotePh') });

  // expiry presets — chips + one custom datetime field
  let expiryMs = 24 * 3600_000; // default: one day
  const customIn = h('input', { class: 'input ltr', type: 'datetime-local', style: { maxWidth: '230px' } });
  const presetRow = h('div', { class: 'row row--wrap' },
    ...[[1, 'shareH1'], [8, 'shareH8'], [24, 'shareD1'], [72, 'shareD3'], [168, 'shareD7'], [0, 'shareNever']].map(([h_, key]) =>
      h('button', {
        class: 'chip', type: 'button',
        onclick: (e) => {
          vibrate(5);
          expiryMs = h_ * 3600_000;
          presetRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on'));
          e.currentTarget.classList.add('is-on');
        },
      }, t(key))));

  // permission toggles — read is always on (the floor)
  const permState = { read: true, star: true, archive: true, delete: false, compose: false, notes: true };
  const permRow = h('div', { class: 'row row--wrap' },
    ...PERMS.map(([p, key]) => h('button', {
      class: `chip ${permState[p] ? 'is-on' : ''}`, type: 'button',
      style: p === 'read' ? { opacity: '.65', pointerEvents: 'none' } : {},
      onclick: (e) => {
        vibrate(5);
        permState[p] = !permState[p];
        e.currentTarget.classList.toggle('is-on', permState[p]);
      },
    }, t(key))));

  const createBtn = h('button', { class: 'btn btn--primary' }, icon('plus'), t('shareCreate'));
  createBtn.addEventListener('click', async () => {
    if (!addresses.length) { toast(t('shareNoAddress'), 'err'); return; }
    if (!picked.size) { toast(t('sharePickOne'), 'err'); return; }
    createBtn.disabled = true;
    try {
      const expiresAt = expiryMs > 0 ? Date.now() + expiryMs : null;
      const r = await api.post('/api/share', {
        address_ids: [...picked],
        username: userIn.value.trim(),
        password: passIn.value,
        label: labelIn.value.trim() || undefined,
        perms: Object.keys(permState).filter((p) => permState[p]),
        expires_at: expiresAt,
        max_devices: deviceCap,
        guest_note: noteIn.value.trim() || undefined,
      });
      showCredsModal(t('shareCreated'), r.share.username, r.share.password, (r.share.addresses ?? []));
      // fresh dice for the next guest + refresh the list
      userIn.value = genUsername();
      passIn.value = genPassword();
      noteIn.value = '';
      await fill();
    } catch (e) { toast(errText(e), 'err'); }
    createBtn.disabled = false;
  });

  pane.append(h('div', { class: 'glass card' },
    h('h3', { style: { margin: '0 0 4px', fontSize: '15px' } }, t('shareNewTitle')),
    h('p', { class: 'small muted', style: { margin: '0 0 12px' } }, t('shareNewSub')),
    h('div', { class: 'field' }, h('label', {}, t('shareMailboxes')), picker,
      h('p', { class: 'small muted', style: { margin: '6px 2px 0' } }, t('shareMailboxesHint'))),
    h('div', { class: 'field mt-1' }, h('label', {}, t('shareLabel')), labelIn),
    h('div', { class: 'mt-1', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      h('div', { class: 'field' }, h('label', {}, t('username')), h('div', { class: 'row' }, userIn, dice(userIn, genUsername))),
      h('div', { class: 'field' }, h('label', {}, t('password')), h('div', { class: 'row' }, passIn, dice(passIn, genPassword)))),
    h('div', { class: 'field mt-1' }, h('label', {}, t('sharePerms')), permRow),
    h('div', { class: 'field mt-1' }, h('label', {}, t('shareDevices')), devRow,
      h('p', { class: 'small muted', style: { margin: '6px 2px 0' } }, t('shareDevicesHint'))),
    h('div', { class: 'field mt-1' }, h('label', {}, t('shareNote')), noteIn),
    h('div', { class: 'field mt-1' }, h('label', {}, t('shareExpiry')), presetRow, h('div', { class: 'small muted', style: { margin: '6px 0' } }, t('shareCustom')), customIn),
    h('div', { class: 'row mt-2' }, createBtn),
  ));

  // ---------- audit list ----------
  const list = h('div', { class: 'share-list' });
  const listCard = h('div', { class: 'glass card' },
    h('h3', { style: { margin: '0 0 4px', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' } }, t('shareListTitle'),
      h('button', { class: 'icon-btn', title: t('refresh'), 'aria-label': t('refresh'), onclick: () => fill() }, icon('refresh'))),
    h('p', { class: 'small muted', style: { margin: '0 0 12px' } }, t('shareListSub')),
    list);
  pane.append(listCard);

  async function fill() {
    clear(list);
    list.append(h('div', { class: 'small muted', style: { padding: '6px 2px' } }, t('loading')));
    try { shares = (await api.get('/api/share')).shares ?? []; } catch (e) { clear(list).append(h('div', { class: 'small muted', style: { padding: '6px 2px' } }, errText(e))); return; }
    clear(list);
    if (!shares.length) { list.append(h('div', { class: 'small muted', style: { padding: '10px 2px' } }, t('shareEmpty'))); return; }
    const t0 = Date.now();
    for (const s of shares) {
      const active = s.active;
      const addrList = (s.addresses ?? []).filter(Boolean);
      const shown = addrList.slice(0, 3);
      const more = addrList.length - shown.length;
      // remaining time — a frozen countdown stands still at frozen_at
      const leftMs = s.expires_at
        ? (s.time_frozen && s.frozen_at ? Number(s.expires_at) - Number(s.frozen_at) : Number(s.expires_at) - t0)
        : null;
      const row = h('div', { class: `share-row ${active ? '' : 'is-off'}` },
        h('div', { class: 'share-row__main' },
          h('div', { class: 'share-row__name' },
            s.online && active ? h('span', { class: 'share-row__live', title: t('shareOnline') }) : '',
            s.label || s.username,
            h('span', { class: `chip ${active ? 'is-on' : ''}` },
              s.revoked_at ? t('shareRevoked') : active ? t('shareActive') : t('shareExpired')),
            s.suspended ? h('span', { class: 'chip chip--warn', title: t('shareSuspendedChip') }, icon('snow'), t('shareSuspendedChip'),
              leftMs !== null ? h('span', { class: 'mono', style: { opacity: '.85' } }, dhms(leftMs)) : '') : '',
            s.time_frozen && s.suspended ? h('span', { class: 'chip', title: t('shareFrozenTag') }, icon('snow'), t('shareFrozenTag')) : '',
            s.max_devices > 0 ? h('span', { class: 'chip', title: t('shareDevices') }, icon('monitor'), `${s.max_devices}`) : '',
            s.guest_note ? h('span', { class: 'chip', title: s.guest_note }, icon('note'), t('shareNoteChip')) : ''),
          h('div', { class: 'share-row__meta mono' },
            shown.join('  ·  ') || s.address || '—',
            more > 0 ? `  +${more}` : '',
            s.live_sessions > 0 ? ` · ${t('shareInside')}: ${s.live_sessions}` : '',
            s.last_seen_at ? ` · ${t('shareSeen')}: ${timeAgo(s.last_seen_at, t)}` : ''),
          h('div', { class: 'share-row__perms' },
            ...String(s.perms || '').split(',').filter(Boolean).map((p) => {
              const def = PERMS.find((x) => x[0] === p);
              return h('span', { class: 'chip' }, def ? t(def[1]) : p);
            }),
            h('span', { class: 'chip mono share-cd' },
              s.revoked_at ? '' : (leftMs !== null ? dhms(leftMs) : t('shareNoLimit')))),
        ),
        h('div', { class: 'share-row__acts' },
          h('button', { class: 'btn btn--sm', title: t('shareEdit'), onclick: () => editModal(s) }, icon('settings'), t('shareEdit')),
          active ? (s.suspended && s.suspended_at
            ? h('button', { class: 'btn btn--sm', title: t('shareUnsuspendBtn'), onclick: () => unsuspendFlow(s) }, icon('sun'), t('shareUnsuspendBtn'))
            : h('button', { class: 'btn btn--sm', title: t('shareSuspendBtn'), onclick: () => suspendFlow(s) }, icon('snow'), t('shareSuspendBtn'))) : '',
          s.live_sessions > 0 ? h('button', { class: 'btn btn--sm', title: t('shareKick'), onclick: () => confirmBox(t('shareKickConfirm'), async () => {
            try { await api.post(`/api/share/${s.id}/kick`, {}); toast(t('devKicked'), 'ok', 1600); fill(); } catch (e) { toast(errText(e), 'err'); }
          }, false) }, icon('logout'), t('shareKick')) : '',
          !s.revoked_at && active ? h('button', { class: 'btn btn--sm btn--danger-ghost', title: t('shareRevoke'), onclick: () => confirmBox(t('shareRevokeConfirm'), async () => {
            try { await api.post(`/api/share/${s.id}/revoke`, {}); toast(t('shareRevokedDone'), 'ok', 1800); fill(); } catch (e) { toast(errText(e), 'err'); }
          }) }, icon('lock'), t('shareRevoke')) : '',
          h('button', { class: 'btn btn--sm btn--danger-ghost', title: t('shareDelete'), onclick: () => confirmBox(t('shareDeleteConfirm'), async () => {
            try { await api.del(`/api/share/${s.id}`); toast(t('shareDeletedDone'), 'ok', 1800); fill(); } catch (e) { toast(errText(e), 'err'); }
          }) }, icon('trash'), t('shareDelete')),
        ));
      list.append(row);
    }
  }

  // ---------- manual suspension: the admin's hand with a time choice ----------
  function suspendFlow(s) {
    // freeze = true → the countdown stands still while suspended; the frozen
    // span is handed back on unsuspend. freeze = false → time keeps burning.
    let freeze = true;
    const chipF = h('button', { class: 'chip is-on', type: 'button' }, icon('snow'), t('shareSuspendFreeze'));
    const chipB = h('button', { class: 'chip', type: 'button' }, icon('clock'), t('shareSuspendTick'));
    const row = h('div', { class: 'row row--wrap' }, chipF, chipB);
    const pick = (v, btn) => {
      freeze = v; vibrate(5);
      row.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on'));
      btn.classList.add('is-on');
    };
    chipF.addEventListener('click', () => pick(true, chipF));
    chipB.addEventListener('click', () => pick(false, chipB));
    const m = modal({
      title: `${t('shareSuspendBtn')} — ${s.label || s.username}`, iconName: 'snow',
      body: [
        h('p', { class: 'small muted', style: { margin: '0 0 10px' } }, t('shareSuspendDesc')),
        h('div', { class: 'field' }, h('label', {}, t('shareSuspendTimeQ')), row,
          h('p', { class: 'small muted', style: { margin: '6px 2px 0' } }, t('shareSuspendTimeHint'))),
      ],
      footer: [
        h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
        h('button', { class: 'btn btn--primary', onclick: async () => {
          try {
            await api.post(`/api/share/${s.id}/suspend`, { freeze_time: freeze });
            toast(t('shareSuspendedDone'), 'ok', 2400);
            m.close();
            fill();
          } catch (e) { toast(errText(e), 'err'); }
        } }, icon('snow'), t('shareSuspendBtn')),
      ],
    });
  }

  async function unsuspendFlow(s) {
    try {
      const r = await api.post(`/api/share/${s.id}/unsuspend`, {});
      toast(r.time_frozen === false ? t('shareUnsuspendedDone') : t('saved'), 'ok', 2400);
      fill();
    } catch (e) { toast(errText(e), 'err'); }
  }

  // ---------- credentials: the one-glance modal (create + regenerate) ----------
  function credLine(value) {
    return h('div', { class: 'copy-line' }, h('span', { class: 'mono' }, value),
      h('button', { class: 'btn btn--sm btn--ghost', onclick: async () => { await copyText(value); toast(t('copied'), 'ok', 1300); } }, icon('copy')));
  }
  function showCredsModal(title, username, password, mailboxes = []) {
    const mboxList = h('div', { class: 'share-cred-box' },
      ...mailboxes.map((a) => h('span', { class: 'chip mono' }, a)));
    const credAll = h('button', { class: 'btn btn--sm', onclick: async () => {
      await copyText(`${t('username')}: ${username}\n${t('password')}: ${password}`);
      toast(t('copied'), 'ok', 1400);
    } }, icon('copy'), t('shareCopyBoth'));
    const m = modal({
      title, iconName: 'users',
      body: [
        h('p', { class: 'small muted', style: { margin: '0 0 10px' } }, t('shareOnce')),
        mailboxes.length ? h('div', { class: 'field' }, h('label', {}, t('shareMailboxes')), mboxList) : '',
        h('div', { class: 'field' }, h('label', {}, t('username')), credLine(username)),
        h('div', { class: 'field' }, h('label', {}, t('password')), credLine(password)),
        credAll,
      ],
      footer: [h('button', { class: 'btn btn--primary', onclick: () => m.close() }, t('done'))],
    });
  }

  // regenerate the credential — new username and/or password, shown once,
  // optionally signing every live guest browser out at the same moment
  function regenModal(s) {
    const userIn2 = h('input', { class: 'input ltr mono', value: s.username, maxlength: '32', autocomplete: 'off' });
    const passIn2 = h('input', { class: 'input ltr mono', value: genPassword(), maxlength: '64', autocomplete: 'off' });
    const kickChk = h('input', { type: 'checkbox', checked: '' });
    const m = modal({
      title: `${t('shareRegen')} — ${s.label || s.username}`, iconName: 'key',
      body: [
        h('p', { class: 'small muted', style: { margin: '0 0 10px' } }, t('shareRegenHint')),
        h('div', { class: 'field' }, h('label', {}, t('username')), h('div', { class: 'row' }, userIn2,
          h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => { userIn2.value = genUsername(); vibrate(5); } }, icon('spark')))),
        h('div', { class: 'field' }, h('label', {}, t('password')), h('div', { class: 'row' }, passIn2,
          h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => { passIn2.value = genPassword(); vibrate(5); } }, icon('spark')))),
        h('label', { class: 'row', style: { gap: '8px', alignItems: 'center', cursor: 'pointer' } }, kickChk, h('span', { class: 'small' }, t('shareRegenKick'))),
      ],
      footer: [
        h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
        h('button', { class: 'btn btn--primary', onclick: async () => {
          try {
            const r = await api.post(`/api/share/${s.id}/regenerate`, {
              username: userIn2.value.trim(),
              password: passIn2.value,
              kick: !!kickChk.checked,
            });
            m.close();
            await fill();
            showCredsModal(t('shareRegenDone'), r.username, r.password, (s.addresses ?? []));
          } catch (e) { toast(errText(e), 'err'); }
        } }, icon('spark'), t('shareRegen')),
      ],
    });
  }

  // ---------- devices & sessions: see them, kill each one ----------
  function sessionsBox(s) {
    const wrap = h('div', { class: 'share-devs' });
    const status = h('div', { class: 'small muted', style: { padding: '4px 2px' } }, t('loading'));
    const refreshBtn = h('button', { class: 'btn btn--sm btn--ghost', onclick: () => load() }, icon('refresh'), t('refresh'));
    const kickAllBtn = h('button', { class: 'btn btn--sm btn--danger-ghost', onclick: () => confirmBox(t('shareKickConfirm'), async () => {
      try { const r = await api.post(`/api/share/${s.id}/kick`, {}); toast(`${t('devKicked')} (${r.removed ?? 0})`, 'ok', 1800); load(); fill(); } catch (e) { toast(errText(e), 'err'); }
    }, false) }, icon('logout'), t('shareKick'));
    const head = h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } }, refreshBtn, kickAllBtn);
    wrap.append(status, head);
    async function load() {
      clear(status);
      status.append(h('span', { class: 'small muted' }, t('loading')));
      let rows = [];
      try {
        const r = await api.get(`/api/share/${s.id}/sessions`);
        rows = r.sessions ?? [];
      } catch (e) { clear(status).append(h('span', { class: 'small muted' }, errText(e))); return; }
      clear(status);
      if (!rows.length) { status.append(h('span', { class: 'small muted' }, t('shareDevicesEmpty'))); return; }
      status.append(h('span', { class: 'small muted' }, `${t('shareInside')}: ${rows.length}`));
      for (const d of rows) {
        const kill = h('button', { class: 'btn btn--sm btn--danger-ghost', title: t('shareDeviceDisable'), onclick: () => confirmBox(t('shareDeviceConfirm'), async () => {
          try { await api.del(`/api/share/${s.id}/sessions/${d.token}`); toast(t('shareDeviceDisabled'), 'ok', 1600); load(); fill(); } catch (e) { toast(errText(e), 'err'); }
        }) }, icon('logout'), t('shareDeviceDisable'));
        wrap.append(h('div', { class: 'share-dev' },
          h('span', { class: 'share-dev__ic' }, icon(deviceName(d.ua) === t('shareDevUnknown') ? 'cpu' : 'monitor')),
          h('div', { class: 'share-dev__t' },
            h('b', {}, deviceName(d.ua)),
            h('span', { class: 'small muted mono' }, `${d.ip || '—'} · ${timeAgo(d.created_at, t)}${d.left_ms ? ' · ' + dhms(d.left_ms) : ''}`)),
          kill));
      }
    }
    load();
    return wrap;
  }

  // ---------- edit modal: credentials + devices + suspension + the rest ----------
  function editModal(s) {
    const pickedEdit = new Set((s.address_ids ?? [s.address_id]).filter(Boolean));
    const picker2 = mailboxPicker(addresses, pickedEdit);
    const perms = new Set(String(s.perms || '').split(',').filter(Boolean));
    const permRow2 = h('div', { class: 'row row--wrap' },
      ...PERMS.map(([p, key]) => h('button', {
        class: `chip ${perms.has(p) ? 'is-on' : ''}`, type: 'button',
        style: p === 'read' ? { opacity: '.65', pointerEvents: 'none' } : {},
        onclick: (e) => {
          if (p === 'read') return;
          vibrate(5);
          if (perms.has(p)) { perms.delete(p); e.currentTarget.classList.remove('is-on'); }
          else { perms.add(p); e.currentTarget.classList.add('is-on'); }
        },
      }, t(key))));

    // ---- credentials (viewable, regenerable) ----
    const credUser = h('span', { class: 'mono' }, s.username);
    const credPass = h('span', { class: 'mono', style: { letterSpacing: '2px' } }, '••••••••');
    const eyeBtn = h('button', { class: 'btn btn--sm btn--ghost', title: t('shareCredReveal'), onclick: async () => {
      try {
        const r = await api.get(`/api/share/${s.id}/credential`);
        credPass.textContent = r.password;
        credPass.style.letterSpacing = 'normal';
        eyeBtn.disabled = true;
      } catch (e) { toast(e?.error === 'no_stored_password' ? t('shareCredNoStore') : errText(e), 'err'); }
    } }, icon('eye'), t('shareCredReveal'));
    const credBox = h('div', { class: 'share-cred' },
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        h('span', { class: 'chip' }, icon('user'), credUser),
        h('span', { class: 'chip' }, icon('key'), credPass), eyeBtn),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '8px' } },
        h('button', { class: 'btn btn--sm', onclick: () => regenModal(s) }, icon('spark'), t('shareRegen')),
        h('span', { class: 'small muted', style: { alignSelf: 'center' } }, s.has_password ? '' : t('shareCredNoStore'))));

    // ---- suspension status ----
    const suspBox = s.suspended && s.suspended_at
      ? h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { class: 'chip chip--warn' }, icon('snow'), s.time_frozen ? t('shareSuspendFrozenOn') : t('shareSuspendedChip')),
          h('button', { class: 'btn btn--sm', onclick: () => unsuspendFlow(s) }, icon('sun'), t('shareUnsuspendBtn')))
      : s.suspended
        ? h('p', { class: 'small muted', style: { margin: 0 } }, t('shareSuspendAutoNote'))
        : h('button', { class: 'btn btn--sm', onclick: () => suspendFlow(s) }, icon('snow'), t('shareSuspendBtn'));

    let devCap = Number(s.max_devices ?? 0) || 0;
    const devRow2 = h('div', { class: 'row row--wrap' },
      ...DEVICE_CAPS.map(([n, key]) => h('button', {
        class: `chip ${devCap === n ? 'is-on' : ''}`, type: 'button',
        onclick: (e) => {
          vibrate(5); devCap = n;
          devRow2.querySelectorAll('.chip').forEach((cc) => cc.classList.remove('is-on'));
          e.currentTarget.classList.add('is-on');
        },
      }, t(key))));

    const noteIn2 = h('textarea', { class: 'input', rows: '2', maxlength: '240', placeholder: t('shareNotePh') });
    noteIn2.value = s.guest_note ?? '';

    let newExpiry = s.expires_at;
    const dt = h('input', { class: 'input ltr', type: 'datetime-local', style: { maxWidth: '230px' } });
    if (s.expires_at) {
      const d = new Date(s.expires_at);
      const pad = (n) => String(n).padStart(2, '0');
      dt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const extendChips = h('div', { class: 'row row--wrap', style: { marginTop: '6px' } },
      ...[[1, 'shareH1'], [8, 'shareH8'], [24, 'shareD1'], [72, 'shareD3'], [168, 'shareD7']].map(([h_, key]) =>
        h('button', { class: 'chip', type: 'button', onclick: () => { vibrate(5); newExpiry = Date.now() + h_ * 3600_000; toast(`${t('sharePicked')} ${t(key)}`, 'ok', 1200); } }, t(key))),
      h('button', { class: 'chip', type: 'button', onclick: () => { vibrate(5); newExpiry = null; toast(t('sharePicked') + ' ' + t('shareNever'), 'ok', 1200); } }, t('shareNever')));

    const m = modal({
      title: `${t('shareEdit')} — ${s.label || s.username}`, iconName: 'settings', wide: true,
      body: [
        h('div', { class: 'field' }, h('label', {}, t('shareCredTitle')), credBox),
        h('div', { class: 'field mt-1' }, h('label', {}, t('shareMailboxes')), picker2),
        h('div', { class: 'field mt-1' }, h('label', {}, t('sharePerms')), permRow2),
        h('div', { class: 'field mt-1' }, h('label', {}, t('shareDevices')), devRow2),
        h('div', { class: 'field mt-1' }, h('label', {}, t('shareDevicesTitle')), sessionsBox(s)),
        h('div', { class: 'field mt-1' }, h('label', {}, t('shareSuspendTitle')), suspBox),
        h('div', { class: 'field mt-1' }, h('label', {}, t('shareNote')), noteIn2),
        h('div', { class: 'field mt-1' }, h('label', {}, t('shareExpiry')), extendChips, h('div', { class: 'small muted', style: { margin: '6px 0' } }, t('shareCustomExact')), dt),
      ],
      footer: [
        h('button', { class: 'btn btn--ghost', onclick: () => m.close() }, t('cancel')),
        h('button', { class: 'btn btn--primary', onclick: async () => {
          if (!pickedEdit.size) { toast(t('sharePickOne'), 'err'); return; }
          let exp = newExpiry;
          if (dt.value) {
            const v = new Date(dt.value).getTime();
            if (Number.isFinite(v)) exp = v;
          }
          try {
            await api.patch(`/api/share/${s.id}`, {
              perms: [...perms],
              address_ids: [...pickedEdit],
              max_devices: devCap,
              guest_note: noteIn2.value.trim(),
              expires_at: exp,
            });
            toast(t('saved'), 'ok');
            m.close();
            fill();
          } catch (e) { toast(errText(e), 'err'); }
        } }, t('save')),
      ],
    });
  }

  await fill();
  return pane;
}
