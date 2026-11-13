<div align="center">

# Deploying Cmail

**From zero to your own mail ecosystem — three routes, one outcome.**

[نصب به فارسی](docs/DEPLOY.fa.md) · [Usage guide](docs/USAGE.md) · [Back to README](../README.md)

</div>

---

## Prerequisites

- A **Cloudflare account** — the free plan is plenty (Workers, D1, Email Routing and the cron all sit inside it).
- For the terminal routes: **Node.js 18+**.
- For receiving mail: a **domain on your Cloudflare account** (any zone — the wizard walks you through Email Routing).

## Choose your route

| Route | Style | Time | What you touch |
|---|---|---|---|
| **0 — One click** | browser, button | ~2 min | press the **Deploy to Cloudflare** button below |
| **1 — One command** | terminal, automated | ~3 min | `bash deploy.sh` does everything |
| **2 — Fully graphical** | browser only, zero commands | ~7 min | Dashboard: create DB → paste worker → one binding |
| **3 — Terminal, step by step** | manual, explicit | ~5 min | wrangler commands |

---

## Route 0 — one click (the Deploy button)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Erfan-8910/Cmail)

Press the button and Cloudflare does the cloning, provisioning and shipping on its own:

1. **Press Deploy** — Cloudflare copies the repo into your own GitHub, creates a **fresh D1 database**, wires the binding and deploys the Worker. (The repository must be public for the button to see it.)
2. **Open the app** at the URL Cloudflare shows — the **setup gate** takes over: build the tables with one press, create the admin account.
3. **Connect your domain** — the wizard walks Email Routing on your own zone (mail receiving always lives in your Cloudflare, so the domain must sit in the same account).
4. Your code, your repo: the button already placed the project in your GitHub with a CI pipeline — every push rebuilds and redeploys.

The pipeline's Deploy step runs the repo's `npm run deploy`, which resolves the D1 binding on its own (finds the database by name, creates one if there truly is none) — so the build never dies on a placeholder database id, even when an existing database is reused.

> **Testing on the same account as an existing install?** The button matches databases **by name** — if `cmail-db` already exists (your live Cmail), the flow reuses it and the new Worker shows that install's data, login screen included. That is the real database talking, not a bug. For a clean first-run experience use a fresh Cloudflare account, or rename the existing database first (D1 → your database → Rename) and rename it back afterwards.

The routes below still work exactly the same — for hands-on installs and terminal tastes.

## Route 1 — one command (terminal)

```bash
git clone https://github.com/Erfan-8910/Cmail.git
cd Cmail
bash deploy.sh
```

The installer handles everything: creates the D1 database, applies the schema, generates a strong random `APP_SECRET`, deploys the Worker, and prints your panel URL. When it finishes, open the URL — the setup screen takes over from there.

## Route 2 — fully graphical, zero commands

Five steps. No SQL, no folder uploads — only your browser and the Cloudflare dashboard.

**1) Create the database**

- Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) → **Storage & Databases → D1 SQL Database → Create**
- Name it `cmail-db` and create it. That's it — creating tables is Cmail's own job now.

**2) Create the Worker and paste the code**

- **Workers & Pages → Create → Workers → Create Worker**
- Name it `cmail` and **Deploy** once with the default code.
- Click **Edit code**, delete the default code, paste the full content of the prebuilt [`worker.js`](https://github.com/Erfan-8910/Cmail/releases/download/v3.0.1/worker.js) and **Deploy**.

**3) The only binding you need: D1**

- Back on the Worker: **Settings → Bindings → Add**
- Type **D1 database** → variable name: `DB` → database: `cmail-db` → Save / Deploy.
- (Optional but recommended) also add a **Secret**: name `APP_SECRET` → value: a long random string. This is the app's internal encryption key — create it once, never change it.

**4) Schedule the cleanup**

- **Settings → Trigger Events → Cron Triggers → Add** and enter: `17 * * * *`

**5) Done — open your Worker URL**

- The **D1 step** opens first: every expected table with its status. Anything missing gets built with one button — individually or all at once — and stray tables you don't recognize get a clean Drop button (the expected ones are protected).
- Then it asks you to **choose a username and password** — these become your keys.
- Next it opens the **domain connect wizard** by itself, and treats outgoing mail as the optional bonus it is — with a test probe whenever you want it.

> 💡 Shortcut: on **Workers & Pages → Create** you can connect your GitHub fork instead (Connect to Git) and let Cloudflare build automatically. Replace `REPLACE_WITH_D1_ID` in `wrangler.jsonc` with the real database id first.

## Route 3 — terminal, step by step

<details open>
<summary><b>For terminal people</b></summary>

```bash
git clone https://github.com/Erfan-8910/Cmail.git
cd Cmail
npm install
npx wrangler login

npx wrangler d1 create cmail-db
#   paste the returned database_id into wrangler.jsonc (REPLACE_WITH_D1_ID)
npx wrangler d1 migrations apply cmail-db --remote
npx wrangler secret put APP_SECRET     # a long random string
npx wrangler deploy
```

The CLI path applies tables as migrations (`0001`–`0005`); to build everything in one shot instead: `npx wrangler d1 execute cmail-db --remote --file=schema.sql`.

Then in the dashboard: your domain → **Email → Email Routing** → enable it → **Catch-all address → Action: Send to Worker → cmail**.

</details>

## Manual tables — one file, console-proof

<details>
<summary><b>Creating tables by hand from the dashboard</b> (open)</summary>

If you ever need to build the schema outside the app, there is exactly one file: [`schema.sql`](../schema.sql). Why it is safe where older files weren't:

- **its comments carry no semicolons and no quotes** — the exact thing that derailed the Console's statement splitter and produced the "errors and won't import" reports;
- **every statement is `IF NOT EXISTS`** — on a fresh, half-built, or already-complete database, pasting it again never errors;
- it carries the final shape of all 11 tables and 15 indexes, domain-lifecycle columns included.

Run it from the dashboard: **Storage & Databases → D1 → cmail-db → Console** → paste the whole file → Execute. Done. Interrupted halfway? Paste it again — it picks up exactly where the run left off.

```bash
npx wrangler d1 execute cmail-db --remote --file=schema.sql
```

⚠️ The files under `migrations/` are terminal-only (their headers say so) — do not paste them into the Console. Their `ALTER` statements error on an already-migrated database and abort the whole batch.

</details>

## Domains: from "Add" to "Verified"

Every domain walks a clear path — guided by a wizard you can leave and resume at will:

1. **Add** — type the domain or subdomain in the Domains panel (or the setup screen), say `mail.yourdomain.com`, press Add.
2. **Connect** — the wizard walks the Cloudflare side step by step: enable Email Routing, the MX records land automatically, Catch-all points at the worker. It ends at **"I've connected the domain"**.
3. **Verify** — you receive a one-of-a-kind code; send any message from a personal mailbox you own to that address (subject and body don't matter). The screen polls every few seconds; when the worker confirms the mail landed, the domain turns green.
4. **Unlocked** — from that moment, creating mailboxes on the domain — permanent or temporary — is open.

All along the way there is an **Exit** button, and pressing it asks: *save as a draft, or leave for good?* Drafts sit in the domains table wearing a "Draft" chip with a Continue button that reopens the wizard at the saved stage. Until registration completes, mailbox creation stays locked — unless you consciously skip verification and accept the responsibility.

Each domain wears a live status chip: healthy, awaiting first mail, awaiting verification, draft, or verification-skipped. Enabling Email Routing makes Cloudflare add these records for you:

| Record | Value | Notes |
|---|---|---|
| MX | `route1.mx.cloudflare.net` (priority 10) | automatic |
| MX | `route2.mx.cloudflare.net` (priority 20) | automatic |
| MX | `route3.mx.cloudflare.net` (priority 30) | automatic |
| TXT (SPF) | `v=spf1 include:_spf.mx.cloudflare.net ~all` | automatic |

The final and most important step: **Email Routing → Routing rules → Catch-all address → Action: Send to Worker → cmail**. From that moment **every** address on your domain lands in Cmail.

## Sending mail — optional, with a real test probe

Sending is a bonus, not a gate: its row on the setup screen is tagged **Optional** and it never stands between you and your inbox. When you want it: connect **Brevo** (300 mails/day free) or **Resend** (100/day free) — create the account, verify your sending domain, then in Cmail pick the provider, paste the key, set the sender address. Then press **Test sending**: a real message goes to any address you type and proves the wiring on the spot. The API key is stored only in your own D1 — it never leaves your Cloudflare.

## Sign-in, access & your credentials

The panel is **single-user**; there is no registration and no second account. On the very first visit you choose a **username and password**, and from then on they are the only key. If you prefer not to type the username every time, switch **Username at sign-in** off in **Settings → Security** — from then on the password alone is enough.

Security is taken seriously: passwords are hashed with PBKDF2-SHA256 (100k iterations), sessions ride on httpOnly cookies, the account itself supports TOTP two-factor, and brute-force attempts are rate-limited per IP and per route.

### 🔑 If you lose your password or username

No hunting for docs — **the recovery guide lives right on the sign-in page**: open "Help & account recovery" under the login form and copy the ready SQL statements:

1. Open [dash.cloudflare.com](https://dash.cloudflare.com) → **Storage & Databases → D1 → cmail-db** → the **Console** tab.
2. Find your **username**:

```sql
SELECT username FROM users;
```

3. **Reset the password** to the temporary value `Recover-Cmail-2026`:

```sql
UPDATE users SET password_hash = 'pbkdf2$100000$Y21haWwtcmVjb3Zlci1zYWx0MQ==$lvVylyVdxsS9Ji19drxw9ko72vDhlyHCDf5dSIC9Z/c=' WHERE role = 'admin';
```

4. Sign in with your username and `Recover-Cmail-2026`, then **immediately** change the password in Settings → Security. No mail is touched — the statement only replaces the password.

> ⚠️ **Never run `DELETE FROM users`** — deleting the user cascades and wipes all of their inboxes and mail. The UPDATE above is all you need, and change the temporary password right away.

## Updating to a newer version

- **Route 2 (graphical):** paste the new `worker.js` into Edit Code and Deploy. If the database shape moved forward, the health panel (Settings → System health) flags it and its **Repair** button adds the missing columns and tables in one press — it never touches your data. The incoming-mail handler also keeps delivering on older databases while you get to the repair, so nothing bounces in between.
- **Routes 1/3 (terminal):** `git pull`, then `npx wrangler d1 migrations apply cmail-db --remote` and `npx wrangler deploy`.

---

<div align="center">

[Usage guide](docs/USAGE.md) · [Back to README](../README.md)

</div>
