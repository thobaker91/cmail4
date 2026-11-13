// Cmail — i18n parity check (node scripts/check-i18n.mjs)
import { readFileSync } from 'node:fs';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'fa' }, configurable: true });
globalThis.document = { documentElement: { dataset: {} }, addEventListener: () => {} };
globalThis.window = { addEventListener: () => {} };

let src = readFileSync(new URL('../public/assets/js/i18n.js', import.meta.url), 'utf8');
// strip ESM keywords, keep assignments
src = src.replace(/export const dict/, 'const dict').replace(/export (let|function|const)/g, '$1');
// remove the trailing applyLang side-effects if any DOM access sneaks in
const fn = new Function(src + '; return dict;');
const dict = fn();
const fa = Object.keys(dict.fa);
const en = Object.keys(dict.en);
console.log('fa:', fa.length, '· en:', en.length);
const missEn = fa.filter((k) => !en.includes(k));
const missFa = en.filter((k) => !fa.includes(k));
console.log('missing in en:', JSON.stringify(missEn));
console.log('missing in fa:', JSON.stringify(missFa));
process.exit(missEn.length || missFa.length ? 1 : 0);
