// Seed demo mail into local D1 for screenshot capture (v2.3 round)
import { execSync } from 'node:child_process';

const cwd = '/home/z/my-project/cmail';
const user = JSON.parse(execSync('npx wrangler d1 execute cmail-db --local --command "SELECT id FROM users LIMIT 1" --json', { encoding: 'utf8', cwd }));
const uid = user[0].results[0].id;
const adr = JSON.parse(execSync('npx wrangler d1 execute cmail-db --local --command "SELECT id, address FROM addresses LIMIT 1" --json', { encoding: 'utf8', cwd }));
const aid = adr[0].results[0].id;
const to = adr[0].results[0].address;

const mails = [
  ['em_g1', 'لینوکس‌مگ', 'mag@example.org', 'خلاصه‌ی هفته: هسته ۶٫۱۲ منتشر شد', 'چهل سال پیش اولین نسخه معرفی شد؛ امروز نسخهٔ تازه با پشتیبانی بهتر از سخت‌افزارهای نو رسیده است.', 1793400000000, 0, 1],
  ['em_g2', 'Cloudflare Notifications', 'no-reply@notify.example.net', 'Your weekly usage report is ready', 'Here is your weekly summary: 132 requests routed, 0 blocked, storage 4.2MB. Everything looks healthy this week.', 1793410000000, 0, 0],
  ['em_g3', 'فروشگاه نمونه', 'orders@shop.example.com', 'سفارش شما ارسال شد', 'بستهٔ شما تحویل پست شد. کد رهگیری: ۱۲۳۴۵۶۷۸. تا دو روز آینده به دستتان می‌رسد.', 1793420000000, 0, 0],
  ['em_g4', 'Payment Gateway', 'billing@pay.example.net', 'Receipt #8842 — paid successfully', 'Thank you for your purchase. Amount: $24.00. This is your electronic receipt, keep it for your records.', 1793424000000, 0, 0],
  ['em_g5', 'تیم خوش‌آمدگویی', 'hello@welcome.example.org', 'به فضای آزمایشی خوش آمدید', 'این یک نامهٔ آزمایشی است تا چیدمان فهرست را روی صفحهٔ کوچک بررسی کنیم.', 1793430000000, 1, 0],
  ['em_g6', 'Security Alerts', 'alerts@example.net', 'New sign-in to your account', 'We noticed a new sign-in from a recognized device. If this was you, no action is needed.', 1793433000000, 0, 0],
];

for (const [id, name, addr, subj, prev, recv, read, star] of mails) {
  const sql = `INSERT OR REPLACE INTO emails (id, user_id, address_id, from_name, from_addr, to_addr, subject, preview, text_body, size, is_read, starred, has_note, received_at) VALUES ('${id}', '${uid}', '${aid}', '${name}', '${addr}', '${to}', '${subj.replace(/'/g, "''")}', '${prev.replace(/'/g, "''")}', '${prev.replace(/'/g, "''")}', 1024, ${read}, ${star}, 0, ${recv});`;
  execSync(`npx wrangler d1 execute cmail-db --local --json --command "${sql.replace(/"/g, '\\"')}"`, { cwd, stdio: 'pipe' });
}
console.log('seeded', mails.length, 'mails →', to, 'user', uid);
