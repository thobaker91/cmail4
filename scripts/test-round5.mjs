// Cmail — round 5 end-to-end API tests: lock screen + share access
// Run with wrangler dev on :8787 (local D1). Prints PASS/FAIL per test.
const BASE = 'http://127.0.0.1:8787';
let cookie = '';       // owner session
let gcookie = '';      // guest session
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

async function req(method, path, body, useCookie = cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(useCookie ? { cookie: useCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* html */ }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

// ---------- 0. status ----------
const st = await req('GET', '/api/setup/status', null, '');
ok('status ready', st.status === 200 && st.data?.ready === true, JSON.stringify(st.data?.slice?.(0, 100)));
ok('version 2.9.5', st.data?.version === '2.9.5');

// ---------- 1. owner login (local admin: erfan / local test pass) ----------
// password unknown → use recovery hash path: set via direct D1? Instead try common local test cred
// The local DB was seeded in earlier rounds; try 'erfan' / 'Test-Local-1234'
let login = await req('POST', '/api/auth/login', { username: 'erfan', password: 'Test-Local-1234' }, '');
if (!(login.data?.ok)) {
  // fall back: admin_created may be false → create
  const st2 = await req('GET', '/api/setup/status', null, '');
  if (st2.data?.admin_created === false) {
    login = await req('POST', '/api/setup/admin', { username: 'erfan', password: 'Test-Local-1234' }, '');
    ok('owner created', !!login.data?.ok);
    if (login.setCookie) cookie = login.setCookie.split(';')[0];
  } else {
    console.log('NOTE: cannot login with test creds — owner has another password.');
    console.log('Set one via: npx wrangler d1 execute cmail-db --local --command "UPDATE users SET password_hash = \'pbkdf2$100000$Y21haWwtcmVjb3Zlci1zYWx0MQ==$lvVylyVdxsS9Ji19drxw9ko72vDhlyHCDf5dSIC9Z/c=\'"');
    process.exit(1);
  }
} else {
  ok('owner login', true);
  if (login.setCookie) cookie = login.setCookie.split(';')[0];
}
if (!cookie && login.setCookie) cookie = login.setCookie.split(';')[0];
ok('cookie set', !!cookie);

// ---------- 2. lock_mode default ----------
const me1 = await req('GET', '/api/auth/me');
ok('me returns lock_mode=totp default', me1.data?.lock_mode === 'totp', `got ${me1.data?.lock_mode}`);
const setGet = await req('GET', '/api/admin/settings');
ok('admin settings has lock_mode', setGet.data?.settings?.lock_mode === 'totp');

// ---------- 3. switch lock mode to password ----------
const setPut = await req('PUT', '/api/admin/settings', { lock_mode: 'password' });
ok('set lock_mode=password', setPut.data?.ok === true);
const me2 = await req('GET', '/api/auth/me');
ok('me returns lock_mode=password', me2.data?.lock_mode === 'password');
// badge condition: 2FA off but password mode → verify-unlock with password works
const vu = await req('POST', '/api/auth/verify-unlock', { mode: 'password', password: 'WRONG-pw' });
ok('unlock wrong password rejected', vu.status === 401);
const vu2 = await req('POST', '/api/auth/verify-unlock', { mode: 'password', password: 'Test-Local-1234' });
ok('unlock correct password accepted', vu2.data?.ok === true, JSON.stringify(vu2.data));

// ---------- 4. 2FA on → totp unlock requires real code ----------
// enable 2FA with a real secret we generate (RFC 6238 test flow via API)
const start = await req('POST', '/api/auth/totp/start');
ok('totp start', !!start.data?.secret);
// generate valid TOTP locally (SHA1, 6 digits, 30s) — node crypto
const { createHmac } = await import('node:crypto');
function totpCode(secretB32, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '')) bits += A.indexOf(c.toUpperCase()).toString(2).padStart(5, '0');
  const counter = Math.floor(t / 30000);
  const cb = Buffer.alloc(8);
  cb.writeBigUInt64BE(BigInt(counter));
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const h = createHmac('sha1', key).update(cb).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
const en = await req('POST', '/api/auth/totp/enable', { secret: start.data.secret, code: totpCode(start.data.secret) });
ok('totp enable with real code', en.data?.ok === true, JSON.stringify(en.data));
const vu3 = await req('POST', '/api/auth/verify-unlock', { mode: 'totp', code: '000000' });
ok('unlock bad totp rejected', vu3.status === 401);
const vu4 = await req('POST', '/api/auth/verify-unlock', { mode: 'totp', code: totpCode(start.data.secret) });
ok('unlock real totp accepted', vu4.data?.ok === true, JSON.stringify(vu4.data));
// totp unlock feeds the grace timer — verify setting recorded
const gr = await req('PUT', '/api/admin/settings', { totp_grace_min: 5 });
ok('grace set', gr.data?.ok === true);
// switch lock mode back to totp (2FA now on → badge stays)
await req('PUT', '/api/admin/settings', { lock_mode: 'totp' });

// ---------- 5. share create ----------
const addrs = await req('GET', '/api/addresses');
const addr = addrs.data?.addresses?.[0];
ok('addresses exist', !!addr, JSON.stringify(addrs.data?.slice?.(0, 80)));
const shBad = await req('POST', '/api/share', { address_id: addr.id, username: 'guest-x1', password: 'short', perms: ['read'] });
ok('weak share password rejected', shBad.status === 400);
const sh = await req('POST', '/api/share', {
  address_id: addr.id, username: 'guest-x1', password: 'Guest-Pass-99',
  label: 'تست مهمان', perms: ['read', 'star'], expires_at: Date.now() + 3600_000,
});
ok('share created', sh.data?.ok === true && sh.data.share?.username === 'guest-x1', JSON.stringify(sh.data));
const shareId = sh.data?.share?.id;
const shDup = await req('POST', '/api/share', { address_id: addr.id, username: 'guest-x1', password: 'Guest-Pass-99' });
ok('duplicate share username rejected', shDup.status === 409);

// ---------- 6. share login ----------
const shNope = await req('POST', '/api/auth/login', { username: 'guest-x1', password: 'wrong-pass' }, '');
ok('guest wrong password rejected', shNope.status === 401);
const shLogin = await req('POST', '/api/auth/login', { username: 'guest-x1', password: 'Guest-Pass-99' }, '');
ok('guest login ok, role=share', shLogin.data?.user?.role === 'share', JSON.stringify(shLogin.data));
if (shLogin.setCookie) gcookie = shLogin.setCookie.split(';')[0];
ok('guest cookie', !!gcookie);
const meG = await req('GET', '/api/auth/me', null, gcookie);
ok('guest me has share ctx', meG.data?.user?.share?.address_id === addr.id, JSON.stringify(meG.data?.user?.share));
ok('guest sees own unread scope', typeof meG.data?.unread === 'number');

// ---------- 7. guest scoping ----------
const gList = await req('GET', '/api/emails?limit=10', null, gcookie);
ok('guest list ok', gList.data?.ok === true);
const gStats = await req('GET', '/api/emails/stats', null, gcookie);
ok('guest stats scoped (addresses=1)', gStats.data?.stats?.addresses === 1, JSON.stringify(gStats.data?.stats));
const gVault = await req('GET', '/api/totp', null, gcookie);
ok('guest vault forbidden', gVault.status === 403);
const gAddrPost = await req('POST', '/api/addresses', { local: 'zzz', domain: addr.address.split('@')[1] }, gcookie);
ok('guest cannot create address', gAddrPost.status === 403);
const gAdmin = await req('GET', '/api/admin/settings', null, gcookie);
ok('guest admin forbidden', gAdmin.status === 403);
const gPw = await req('POST', '/api/auth/password', { current: 'x', next: 'whatever-123' }, gcookie);
ok('guest cannot change panel password', gPw.status === 403);
const gShares = await req('GET', '/api/share', null, gcookie);
ok('guest cannot list shares', gShares.status === 403);
const gUnlock = await req('POST', '/api/auth/verify-unlock', { mode: 'password', password: 'Guest-Pass-99' }, gcookie);
ok('guest cannot use lock', gUnlock.status === 403);

// ---------- 8. guest permission enforcement ----------
const firstMail = (gList.data?.emails ?? [])[0];
if (firstMail) {
  const gStar = await req('PATCH', `/api/emails/${firstMail.id}`, { starred: true }, gcookie);
  ok('guest star allowed (star perm)', gStar.data?.ok === true, JSON.stringify(gStar.data));
  const gDel = await req('DELETE', `/api/emails/${firstMail.id}`, null, gcookie);
  ok('guest delete forbidden (no perm)', gDel.status === 403);
  const gBulk = await req('POST', '/api/emails/bulk', { ids: [firstMail.id], action: 'delete' }, gcookie);
  ok('guest bulk delete forbidden', gBulk.status === 403);
  const gBulk2 = await req('POST', '/api/emails/bulk', { ids: [firstMail.id], action: 'star' }, gcookie);
  ok('guest bulk star allowed', gBulk2.data?.ok === true);
  const gSend = await req('POST', '/api/emails/send', { from_address_id: addr.id, to: 'x@y.com', subject: 's', text: 't' }, gcookie);
  ok('guest compose forbidden', gSend.status === 403);
} else { console.log('NOTE: no emails in shared mailbox — perm tests skipped partially'); }

// ---------- 9. owner sees guest in sessions ----------
const sess = await req('GET', '/api/admin/sessions');
const guestRow = (sess.data?.sessions ?? []).find((s) => s.share);
ok('guest session visible with badge', !!guestRow, JSON.stringify(sess.data?.sessions?.slice(0, 2)));

// ---------- 10. share list audit ----------
const shList = await req('GET', '/api/share');
const row = (shList.data?.shares ?? []).find((x) => x.id === shareId);
ok('share audit row exists', !!row);
ok('share audit shows live session', row?.live_sessions === 1, `got ${row?.live_sessions}`);
ok('share audit shows online flag', row?.online === true);

// ---------- 11. edit perms → delete allowed ----------
const edit = await req('PATCH', `/api/share/${shareId}`, { perms: ['read', 'delete'] });
ok('edit perms ok', edit.data?.ok === true);
const gList2 = await req('GET', '/api/emails?limit=10', null, gcookie);
const m2 = (gList2.data?.emails ?? [])[0];
if (m2) {
  const gDel2 = await req('DELETE', `/api/emails/${m2.id}`, null, gcookie);
  ok('guest delete allowed after perm change', gDel2.data?.ok === true, JSON.stringify(gDel2.data));
}

// ---------- 12. revoke → guest 401 ----------
const rv = await req('POST', `/api/share/${shareId}/revoke`);
ok('revoke ok', rv.data?.ok === true);
const gAfter = await req('GET', '/api/auth/me', null, gcookie);
ok('guest killed after revoke (401)', gAfter.status === 401);
const shLogin2 = await req('POST', '/api/auth/login', { username: 'guest-x1', password: 'Guest-Pass-99' }, '');
ok('revoked guest cannot login', shLogin2.status === 401);

// ---------- 13. unrevoke via edit (expires_at reset) then delete ----------
const unrv = await req('PATCH', `/api/share/${shareId}`, { expires_at: Date.now() + 3600_000, unrevoke: true });
ok('unrevoke ok', unrv.data?.ok === true);
const shLogin3 = await req('POST', '/api/auth/login', { username: 'guest-x1', password: 'Guest-Pass-99' }, '');
ok('unrevoked guest can login again', shLogin3.data?.user?.role === 'share', JSON.stringify(shLogin3.data));
if (shLogin3.setCookie) gcookie = shLogin3.setCookie.split(';')[0];
const del = await req('DELETE', `/api/share/${shareId}`);
ok('hard delete ok', del.data?.ok === true);
const gAfter2 = await req('GET', '/api/auth/me', null, gcookie);
ok('guest session cascaded away after delete', gAfter2.status === 401);

// ---------- 14. expiry auto-logout ----------
const shExp = await req('POST', '/api/share', { address_id: addr.id, username: 'guest-x2', password: 'Guest-Pass-98', perms: ['read'], expires_at: Date.now() + 1500 });
ok('short-expiry share created', shExp.data?.ok === true);
const expLogin = await req('POST', '/api/auth/login', { username: 'guest-x2', password: 'Guest-Pass-98' }, '');
ok('guest2 login', expLogin.data?.user?.role === 'share');
const g2c = expLogin.setCookie?.split(';')[0] ?? '';
await new Promise((r) => setTimeout(r, 1800));
const g2me = await req('GET', '/api/auth/me', null, g2c);
ok('expired guest session dead (401)', g2me.status === 401, `got ${g2me.status}`);
await req('DELETE', `/api/share/${shExp.data?.share?.id}`);

// ---------- 15. cleanup: disable 2FA (leave env tidy), reset lock mode ----------
const dis = await req('POST', '/api/auth/totp/disable', { code: totpCode(start.data.secret) });
ok('2FA disabled back', dis.data?.ok === true, JSON.stringify(dis.data));
await req('PUT', '/api/admin/settings', { totp_grace_min: 0, lock_mode: 'totp' });

console.log(`\n==== ${pass} passed · ${fail} failed ====`);
process.exit(fail ? 1 : 0);
