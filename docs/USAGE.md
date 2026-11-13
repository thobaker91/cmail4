<div align="center">

# Using Cmail

**Everyday use, shortcuts, troubleshooting — the owner's manual.**

[راهنمای استفاده به فارسی](docs/USAGE.fa.md) · [Deploy guide](docs/DEPLOY.md) · [Back to README](../README.md)

</div>

---

## The inbox

The mail screen has three panes: **inboxes** on the side, the **list** in the middle, the **reader** on the other side. On phones the panes fold into drawers — nothing is lost, it just tucks away.

### All inboxes, one stream

The first entry in the sidebar is **All inboxes**: every mailbox streamed into one live list, newest first. Each row carries a small chip naming the mailbox it landed in (with a colored dot for temporary ones). Tap any mailbox in the sidebar to make that space your whole world again — the list header follows you.

### It breathes on its own

Every 15 seconds the inbox quietly checks for new mail. Something landed? It slides in at the top with a soft highlight, the unread badges update everywhere, and a small toast lets you know. No refresh rituals — though the refresh button is still there for the impatient.

### Reading

Open any mail and it renders inside a sandboxed frame: full HTML with styles intact, RTL detected on its own, attachments above the body, plain-text view one toggle away. A width toggle narrows wide newsletters into something readable.

### Taking notes

Under every message lives a personal note — five colors, auto-saved, searchable. Order numbers, tracking links, "reply on Monday" — it stays with the mail.

### Star, mark, delete

Star from the row, from the row's ⋮ menu, or with the keyboard. Multi-select works with checkboxes, long-press on touch, or `x` on the keyboard; the bulk bar does read/delete/clear.

## Inboxes and addresses

- **Create:** pick a domain, type any local part (or hit the dice), choose its kind — temporary with a countdown (1 hour to 30 days, extendable) or permanent, yours forever.
- **Every inbox is an account:** tap ⋮ next to any inbox for its profile — label it, keep private notes, bind its own 2FA codes, copy its address, empty it, or delete it with all its mail.
- **Forwarding:** each inbox can mirror every incoming mail to an address you already check (the destination must be verified once in your Cloudflare dashboard).

## The 2FA vault

A real authenticator inside the panel: add a key by name (paste an `otpauth://` secret or import a QR), pick one of the 77 built-in marks, organize into folders. Codes refresh every 30 seconds with a visible countdown and copy with one tap. Sealed at rest with AES-256-GCM. Bind a key to a specific inbox and it lives inside that account only.

## Sharing a mailbox — guests

Hand someone limited access to one or several of your inboxes — their own username and password, your rules. Everything lives in **Settings → Sharing**.

- **Create a credential:** pick the mailbox(es) one chip at a time, choose the permission list (read · star · archive · delete · send · notes), set an expiry (presets or an exact date), a simultaneous device cap, and an optional welcome note the guest reads on arrival. The dice rolls a username or password whenever you would rather not invent one.
- **The guest's door:** guests sign in through **Shared access** on the sign-in card and land in a compact panel crowned by a floating **Dynamic Island** — the mailbox name (or a count) with a live countdown, and nothing else. Tapping **?** morphs it open with the essentials only: labeled time left, the mailbox list (tap a row to copy its address), the admin's note if there is one, and sign-out.
- **Only what you authorized:** controls the guest has no permission for never render — not even greyed out. Compose, star, delete, bulk selection, the settings pages and the command palette all trim themselves to the granted list, and a typed-in URL like `#/settings` folds straight back to the mail view.
- **Run the room:** the audit strip shows the online dot, the browsers inside and last seen; one press kicks the guest, revokes or hard-deletes the credential. Every credential also carries a **device list** and a **session list** — see each one and disable it on the spot.
- **Credentials you can always look up:** open a credential to read its username and password again (sealed with the same AES-256-GCM as the vault), or press **Regenerate** — a fresh username and password in one tap, optionally signing out every live guest browser.
- **Suspension, on your terms:** suspend any credential manually and choose what its clock does — **Freeze time** (nothing burns while suspended) or **Keep counting down** (suspension eats the remaining time). A suspended guest can still sign in but the frozen page answers, showing the remaining time. A credential left with **no mailbox assigned** suspends itself instead of vanishing — assign a mailbox again and it wakes up on its own. Deleting an inbox that is still shared warns you first, because it also leaves every guest who holds it.
- **One truth for 2FA codes:** a key the guest adds to a shared mailbox is the same row you see — the live code on your side and on theirs is always identical.

## ⌘K — the command palette

Press <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> anywhere: jump to any page, switch inboxes (All inboxes included), run actions like cleanup or logout, and search your mail live while you type.

## Keyboard map

| Key | Action |
|---|---|
| `/` | focus search |
| `j` / `k` | move down / up |
| `Enter` or `o` | open the pointed mail |
| `x` | select / deselect |
| `s` | star / unstar |
| `Esc` | clear selection, close the reader |
| <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> | command palette |

## Make it yours

**Settings → Appearance:** Dark or Daylight, thirteen named color moods, Persian (RTL) or English — all applied instantly and remembered.

**Settings → Security:** change password, enable TOTP two-factor, switch username-at-sign-in.

**Settings → General** *(admin)*: app name, default TTL for temp inboxes, address cap, session length, retention — plus a stats strip and a manual cleanup button.

**Settings → Outgoing mail** *(admin, optional)*: provider, API key, sender, and the test probe.

## System health — the control room

**Settings → System health** (admin) is the honest dashboard of your install:

- **D1 connection** — binding, connectivity, live latency.
- **Tables & schema** — every expected table with its row count and its column state. Missing table? **Build** right there. Old columns? **Repair** right there. Unknown strays? **Drop**, with confirmation. One **Repair everything** button covers the whole schema.
- **Automatic cleanup (cron)** — the last run time. If the cron has gone quiet for over a day, the panel says so and tells you exactly which trigger to add.
- **Mail flow** — last mail received, totals, ready domains, unfinished domains, and the *not receiving mail?* checklist.

### Banners above the app

When something serious breaks, a banner appears **above the content** — plain language, cause and fix together:

| Banner | What it means | The fix |
|---|---|---|
| D1 connection is down | no binding or the database is unreachable | check the binding, then Setup |
| `{n}` tables are missing | schema incomplete — sign-in and delivery stay broken | **Build tables** button on the banner |
| Database schema is outdated | old columns missing — **incoming mail bounces** | **Repair** button on the banner |
| Cleanup has gone quiet | cron hasn't run in ages | add the Cron Trigger in the dashboard |
| No mail has arrived yet | domain + inbox ready, zero mail ever | walk the Email Routing checklist |
| `{n}` domains left half-registered | drafts still locked | continue from Domains |

Banners dismiss with the ✕ and come back only if the problem does.

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| A health banner above the app | see the table above | the banner carries its own fix |
| Bilingual guide page titled "Database binding is missing" | the D1 binding named `DB` is not set | Deploy guide, step 3: Settings → Bindings → D1 → variable `DB` |
| Mail never arrives | usually the catch-all | Dashboard → domain → Email Routing → Catch-all → Send to Worker → `cmail`; then send a test mail and watch the health tab |
| Mail stopped arriving after an update | database behind the worker (old columns) | Settings → System health → **Repair everything** — delivery never stopped in the meantime |
| "This domain has not finished registration" | the domain's wizard is unfinished | Domains panel → **Continue** — the wizard reopens at the saved stage |
| The verification code never arrives | the mail route is still closed | wizard step 2: check Email Routing and Catch-all, grab a fresh code |
| Outgoing mail fails | key/sender | Settings → Outgoing mail → Test; the sender domain must be verified on the provider |
| A raw Worker error (`1101`) | should not happen | every error converts into the guide page; if you ever see a raw one, the text inside is enough to report — `npx wrangler tail` gives live logs |
| The page does not load at all | dashboard/service issue | check [cloudflarestatus.com](https://www.cloudflarestatus.com) |

## FAQ

<details>
<summary><b>How do I update Cmail?</b></summary>

Graphical install: paste the new `worker.js` into Edit Code and Deploy — if the schema moved, the health panel flags it and Repair fixes it in one press. Terminal install: `git pull`, `npx wrangler d1 migrations apply cmail-db --remote`, `npx wrangler deploy`.
</details>

<details>
<summary><b>I left a domain half-registered — what happens to it?</b></summary>

Nothing is lost. It stays in the domains table wearing its Draft chip; **Continue** reopens the wizard at the exact stage. If you did not want the draft either, "Exit without saving" in the wizard removes it. Until it verifies, mailboxes stay locked on it.
</details>

<details>
<summary><b>Can I use several domains?</b></summary>

Yes — enable each domain on Cloudflare, add it under Domains, walk its wizard. Inboxes across all verified domains work instantly.
</details>

<details>
<summary><b>Where does my data live? Can I back it up?</b></summary>

Everything is in your single D1 database. Export a full SQL snapshot from the dashboard at any time — that is your backup.
</details>

<details>
<summary><b>worker.js is large — is that a problem?</b></summary>

No. It is ~1.2 MB because the entire interface (logos, fonts, icons) is embedded; after the gzip Cloudflare applies automatically it shrinks to ~470 KB and sits comfortably inside free-plan limits. In exchange: no separate files, no extra bindings.
</details>

<details>
<summary><b>Does the auto-refresh drain my battery / API limits?</b></summary>

No. It is one small JSON request every 15 seconds while the tab is visible, paused when the tab is hidden or an overlay is open. Workers free tier is 100,000 requests/day — months of idling would not dent it.
</details>

---

<div align="center">

[Deploy guide](docs/DEPLOY.md) · [Back to README](../README.md)

</div>
