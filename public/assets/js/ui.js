// Cmail — UI helpers: dom builder, icons, toasts, modals, menus, copy
import { t } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'circle', 'rect', 'path', 'line', 'text', 'g', 'defs', 'ellipse', 'polygon', 'polyline']);

export function h(tag, attrs = {}, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') { if (SVG_TAGS.has(tag)) el.setAttribute('class', String(v)); else el.className = v; }
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(9)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// ---------- icons (inline svg, stroke style) ----------
const I = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const icons = {
  mail: I('<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="m3.5 7 8.5 6.5L20.5 7"/>'),
  inbox: I('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>'),
  send: I('<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'),
  star: I('<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/>'),
  trash: I('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  plus: I('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  shield: I('<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="m9 11.5 2 2 4-4.5"/>'),
  key: I('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9"/><path d="m17 4 3 3"/><path d="m14 7 3 3"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>'),
  note: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  copy: I('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  refresh: I('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>'),
  check: I('<path d="m4 12.5 5 5L20 6.5"/>'),
  x: I('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevron: I('<path d="m6 9 6 6 6-6"/>'),
  menu: I('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'),
  more: I('<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>'),
  logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
  sun: I('<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'),
  moon: I('<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'),
  external: I('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  download: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  paperclip: I('<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  eye: I('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  help: I('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  edit: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  zap: I('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
  qr: I('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21v.01M18 18h3v3"/>'),
  globeAm: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  heart: I('<path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.3a5 5 0 1 1 7.5 6.3z"/>'),
  code: I('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  arrow: I('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  archive: I('<rect x="2" y="4" width="20" height="5" rx="1.5"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>'),
  info: I('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M12 12v5"/>'),
  alarm: I('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M5 3 2 6"/><path d="m19 3 3 3"/>'),
  leaf: I('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>'),
  columns: I('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M12 3v18"/>'),
  database: I('<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5V12c0 1.66 3.58 3 8 3s8-1.34 8-3V5.5"/><path d="M4 12v6.5c0 1.66 3.58 3 8 3s8-1.34 8-3V12"/>'),
  spark: I('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/>'),
  lock: I('<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>'),
  lockOpen: I('<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>'),
  phone: I('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  monitor: I('<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M9 21h6"/><path d="M12 17v4"/>'),
  snow: I('<path d="M12 2.5v19"/><path d="m4.9 6.2 14.2 11.6"/><path d="M19.1 6.2 4.9 17.8"/><path d="m12 2.5-2.2 2.2M12 2.5l2.2 2.2"/><path d="m12 21.5-2.2-2.2M12 21.5l2.2-2.2"/><path d="M6.7 8.7 4 9.4M17.3 15.3 20 14.6M17.3 8.7 20 9.4M6.7 15.3 4 14.6"/>'),
  flame: I('<path d="M12 21.5c-4.1 0-6.5-2.6-6.5-6 0-2.7 1.7-4.6 3.1-6.4C9.9 7.4 11 5.5 11 3c3 1.5 4.6 3.7 4.2 6.5 1-.4 1.7-1.2 2-2.3 1.5 1.7 2.3 3.9 2.3 6.3 0 4.4-3.4 8-7.5 8z"/>'),
  palette2: I('<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="14.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/>'),
  users: I('<circle cx="9" cy="8.5" r="3.4"/><path d="M2.8 20c.7-3.4 3.2-5.2 6.2-5.2s5.5 1.8 6.2 5.2"/><path d="M16 5.4a3.5 3.5 0 0 1 0 6.2"/><path d="M18.2 15.3c1.7.8 2.7 2.3 3 4.7"/>'),
  folder: I('<path d="M3 7.5V17a2.5 2.5 0 0 0 2.5 2.5h13A2.5 2.5 0 0 0 21 17V9.5A2.5 2.5 0 0 0 18.5 7h-6L10.6 4.9a1.6 1.6 0 0 0-1.2-.6H5.5A2.5 2.5 0 0 0 3 6.8z"/>'),
  // the dedicated Lock-mode mark: a padlock whose keyhole carries its own
  // spark — one glance says “the panel is sealed on purpose”. Theme-aware
  // like every icon: it inherits whatever color the current mood hands it.
  lockMode: I('<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8.2 10.5V7a3.8 3.8 0 0 1 7.3-1.4"/><circle cx="12" cy="14.7" r="1.5"/><path d="M12 16.2v1.6"/><path d="M18.6 4.2v2.4"/><path d="M17.4 5.4h2.4"/>'),
  // the Climind-W sibling mark: an open C holding a small world — drawn on
  // currentColor so the little ribbon logo re-tints itself with every mood
  climind: I('<path d="M19.2 6.2A8.6 8.6 0 1 0 19.2 17.8"/><circle cx="12" cy="12" r="3.6"/><path d="M9.5 12h5"/>'),
};

// ---------- responsibility badge ----------
// the little sign that rides beside a feature's own logo:
//  · frozen  — snowflake + padlock, icy glass: this is locked on purpose
//              until its authorization or configuration is granted
//  · open    — an opened shackle: the responsibility was accepted
//  · flame   — the same acceptance, with a bit of fire: this entry lives
//              fast and will burn out together with its temporary address
export function lockBadge(kind = 'frozen', title = '') {
  if (kind === 'frozen') {
    return h('span', { class: 'lockbadge lockbadge--frozen', title }, icon('snow'), icon('lock'));
  }
  if (kind === 'flame') {
    return h('span', { class: 'lockbadge lockbadge--open lockbadge--flame', title }, icon('flame'));
  }
  return h('span', { class: 'lockbadge lockbadge--open', title }, icon('lockOpen'));
}

export function icon(name, cls = '') {
  const span = h('span', { class: `icn ${cls}`, 'aria-hidden': 'true' });
  span.innerHTML = icons[name] ?? icons.info;
  span.style.display = 'inline-flex';
  return span;
}

// ---------- glyph marks (built-in logo library for 2FA entries) ----------
// bold stroke marks on a colored tile — no network, no external names
const G = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const glyphCats = {
  dev: ['code', 'terminal', 'branch', 'bug', 'database', 'cpu', 'api', 'robot'],
  social: ['chat', 'heart', 'users', 'camera', 'hash', 'at', 'send', 'rss', 'thumb'],
  infra: ['cloud', 'server', 'upload', 'shield', 'key', 'lock', 'plug', 'antenna', 'gauge'],
  money: ['coin', 'chart', 'wallet', 'card', 'gem', 'bank', 'cash', 'safe', 'percent'],
  shop: ['bag', 'cart', 'tag', 'gift', 'basket', 'store'],
  media: ['play', 'music', 'image', 'mic', 'game', 'tv', 'film', 'headphones', 'clapper'],
  crypto: ['hex', 'chain', 'pick', 'seed', 'swap'],
  work: ['doc', 'folder', 'calendar', 'clock', 'pin', 'star', 'bolt', 'flame', 'rocket', 'crown', 'layers', 'cube', 'briefcase', 'target', 'award', 'pen'],
  life: ['moon', 'sun', 'coffee', 'leaf', 'globe', 'anchor', 'feather', 'compass', 'bell', 'wifi', 'eye', 'car', 'plane', 'flower', 'paw'],
};

export const glyphs = {
  code: G('<path d="m14.5 5 7 7-7 7"/><path d="m9.5 5-7 7 7 7"/>'),
  terminal: G('<rect x="2.5" y="3.5" width="19" height="17" rx="3"/><path d="m7 9 3.5 3L7 15"/><path d="M13 15h4"/>'),
  branch: G('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6"/><path d="M18 11.2c0 3-2 4.7-5 5.3"/>'),
  bug: G('<path d="M8.5 7a3.5 3.5 0 0 1 7 0"/><rect x="7" y="8.5" width="10" height="10.5" rx="5"/><path d="M7 12H3.8M20.2 12H17M7.5 16 4 18M20 18l-3.5-2M8.5 8.5 6 6M18 6l-2.5 2.5"/>'),
  database: G('<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5V12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V5.5"/><path d="M4.5 12v6.5c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V12"/>'),
  cpu: G('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>'),
  chat: G('<path d="M21 11.6a8.3 8.3 0 0 1-8.4 8.2c-1.5 0-2.9-.4-4.1-1L3 20l1.3-4.8a8.1 8.1 0 0 1-1.3-4.6A8.3 8.3 0 0 1 12.6 3 8.3 8.3 0 0 1 21 11.6z"/>'),
  heart: G('<path d="M12 20.5 4.7 13a4.9 4.9 0 0 1 7-7l.3.4.3-.4a4.9 4.9 0 0 1 7 7z"/>'),
  users: G('<circle cx="9" cy="8.5" r="3.3"/><path d="M2.8 20c.7-3.3 3.2-5 6.2-5s5.5 1.7 6.2 5"/><path d="M16 5.6a3.4 3.4 0 0 1 0 5.8M18.5 15.4c1.6.8 2.5 2.3 2.8 4.6"/>'),
  camera: G('<path d="M4 8h2.5l1.8-2.6a1.4 1.4 0 0 1 1.1-.6h5.2a1.4 1.4 0 0 1 1.1.6L17.5 8H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/><circle cx="12" cy="13.5" r="3.3"/>'),
  hash: G('<path d="M9.5 3.5 7.5 20.5M16.5 3.5l-2 17M4 8.5h17M3 15.5h17"/>'),
  at: G('<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.3a2.3 2.3 0 0 0 4.6 0V12a8.2 8.2 0 1 0-3.2 6.5"/>'),
  cloud: G('<path d="M7 18.5a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 8.6a4.5 4.5 0 0 1-1 9.9z"/>'),
  server: G('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  upload: G('<path d="M21 15v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3"/><path d="m7 8 5-5 5 5"/><path d="M12 3v12"/>'),
  shield: G('<path d="M12 21.5s7.5-3.4 7.5-9.5V5.2L12 2.5 4.5 5.2V12c0 6.1 7.5 9.5 7.5 9.5z"/><path d="m9 11.8 2.2 2.2 4-4.4"/>'),
  key: G('<circle cx="7.5" cy="15.5" r="4.2"/><path d="m10.5 12.5 9.5-9.5M16.5 6.5l3 3M13.5 9.5l2.5 2.5"/>'),
  lock: G('<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3"/><path d="M12 14.5v2.5"/>'),
  coin: G('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M15 9.2c-.6-1-1.7-1.5-3-1.5-1.6 0-2.9.8-2.9 2.1 0 2.9 5.8 1.5 5.8 4.3 0 1.4-1.3 2.2-2.9 2.2-1.4 0-2.6-.6-3.2-1.6"/>'),
  chart: G('<path d="M3.5 3.5v17h17"/><path d="m7 14.5 3.5-4 3 2.5 4.5-5.5"/>'),
  wallet: G('<path d="M3 7a2 2 0 0 1 2-2h12.5A1.5 1.5 0 0 1 19 6.5V9"/><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14" r="1.2"/>'),
  card: G('<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 14.5h4"/>'),
  gem: G('<path d="M7 3.5h10L21 9l-9 11.5L3 9z"/><path d="M3 9h18M9.5 3.5 7.5 9l4.5 11.5L16.5 9l-2-5.5"/>'),
  bag: G('<path d="M5.5 8h13l-1 12a1.8 1.8 0 0 1-1.8 1.6H8.3A1.8 1.8 0 0 1 6.5 20z"/><path d="M8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3"/>'),
  cart: G('<circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17.5" cy="19.5" r="1.4"/><path d="M2.5 3.5h2.6l2.5 12h10.9l2-8.5H6"/>'),
  tag: G('<path d="M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.4"/>'),
  gift: G('<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5"/><path d="M12 8v13"/><path d="M12 8s-4.5.2-4.5-2.5C7.5 3.6 10.8 3.7 12 8z"/><path d="M12 8s4.5.2 4.5-2.5C16.5 3.6 13.2 3.7 12 8z"/>'),
  play: G('<circle cx="12" cy="12" r="9"/><path d="M10 8.8v6.4l5.4-3.2z"/>'),
  music: G('<path d="M9 18.5V5.8L20 4v12.7"/><circle cx="6.5" cy="18.5" r="2.4"/><circle cx="17.5" cy="16.5" r="2.4"/>'),
  image: G('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m3 17 5-4.5 4 3.5 3.5-3L21 17"/>'),
  mic: G('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/>'),
  game: G('<path d="M6.5 7h11a5.5 5.5 0 0 1 0 11c-2 0-2.8-1-5.5-1s-3.5 1-5.5 1a5.5 5.5 0 0 1 0-11z"/><path d="M8 10.5v3M6.5 12h3M15.5 11h.01M17.5 13h.01"/>'),
  doc: G('<path d="M6 2.5h8L20 8.5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z"/><path d="M14 2.5v6h6"/><path d="M8.5 13h7M8.5 16.5h5"/>'),
  folder: G('<path d="M3 7a2 2 0 0 1 2-2h4.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  calendar: G('<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M8 2.5V6M16 2.5V6"/>'),
  clock: G('<circle cx="12" cy="12" r="8.8"/><path d="M12 7v5.2l3.4 2"/>'),
  pin: G('<path d="M12 21.5s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10.3" r="2.6"/>'),
  star: G('<path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1.1 6.2L12 17.2l-5.6 2.9 1.1-6.2L3 9.5l6.2-.9z"/>'),
  bolt: G('<path d="M13 2.5 4 13.8h6.4L9.8 21.5 19 10.2h-6.4z"/>'),
  flame: G('<path d="M12 21.5c-4.1 0-6.5-2.6-6.5-6 0-2.7 1.7-4.6 3.1-6.4C9.9 7.4 11 5.5 11 3c3 1.5 4.6 3.7 4.2 6.5 1-.4 1.7-1.2 2-2.3 1.5 1.7 2.3 3.9 2.3 6.3 0 4.4-3.4 8-7.5 8z"/>'),
  rocket: G('<path d="M12 15.5c5.5-3.5 7.5-8 7.5-12-4 0-8.5 2-12 7.5z"/><path d="M7.5 11 4 12.5 6.5 15M13 16.5l-1.5 3.5L8.5 17.5"/><circle cx="14.5" cy="9.5" r="1.7"/>'),
  crown: G('<path d="m3 8 4.5 3L12 4.5 16.5 11 21 8l-1.5 10.5h-15z"/>'),
  layers: G('<path d="m12 3 9 5-9 5-9-5z"/><path d="m4.2 12.6 7.8 4.3 7.8-4.3M4.2 16.6l7.8 4.3 7.8-4.3"/>'),
  cube: G('<path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7z"/><path d="M3.7 7.2 12 11.5l8.3-4.3M12 11.5V21"/>'),
  moon: G('<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10z"/>'),
  sun: G('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.7 1.7M17.3 17.3 19 19M5 19l1.7-1.7M17.3 6.7 19 5"/>'),
  coffee: G('<path d="M4 8.5h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 9.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M7.5 2.5c-1 1.2-1 2.3 0 3.5M11.5 2.5c-1 1.2-1 2.3 0 3.5"/>'),
  leaf: G('<path d="M11 20A7.5 7.5 0 0 1 9.7 5.9C15.7 4.7 17.2 4.2 19.3 1.6c1 2.1 2.1 4.4 2.1 8.4 0 5.8-5 10-10.4 10z"/><path d="M3 21c0-3.2 2-5.7 5.4-6.4C11.7 14 14 12.4 15 11.3"/>'),
  globe: G('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18 14.5 14.5 0 0 1 0-18z"/>'),
  anchor: G('<circle cx="12" cy="5.5" r="2.5"/><path d="M12 8v13"/><path d="M4.5 13c.5 4.5 3.6 8 7.5 8s7-3.5 7.5-8M4.5 13H7M19.5 13H17"/>'),
  feather: G('<path d="M20 4c-6 0-12 3-13.5 9.5L5 20l6.5-1.5C18 17 20 10 20 4z"/><path d="M5 20 16 9"/>'),
  compass: G('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  bell: G('<path d="M6 9.5a6 6 0 0 1 12 0c0 5 1.5 6 1.5 6h-15s1.5-1 1.5-6"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>'),
  wifi: G('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19" r="1.4"/>'),
  eye: G('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3.2"/>'),
  api: G('<path d="M8 4c-2 0-2.5 1.5-2.5 3S5 10.5 3 12c2 1.5 2.5 3 2.5 4.5S6 20 8 20"/><path d="M16 4c2 0 2.5 1.5 2.5 3s.5 3.5 2.5 5c-2 1.5-2.5 3-2.5 4.5S18 20 16 20"/><path d="M13.5 5 10.5 19"/>'),
  robot: G('<rect x="5" y="8" width="14" height="11" rx="3.5"/><path d="M12 8V4.5"/><circle cx="12" cy="3.4" r="1.1"/><circle cx="9.2" cy="13" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.8" cy="13" r="1.15" fill="currentColor" stroke="none"/><path d="M9.5 16.4h5"/><path d="M2.8 12.5v3M21.2 12.5v3"/>'),
  send: G('<path d="M21.5 3.5 10.2 13.2M21.5 3.5l-6.8 17.2-4.5-7.5L2.5 9z"/>'),
  rss: G('<path d="M4.5 11.5a8.5 8.5 0 0 1 8.5 8.5M4.5 5.5A14.5 14.5 0 0 1 19 20"/><circle cx="5.6" cy="18.6" r="1.6" fill="currentColor" stroke="none"/>'),
  thumb: G('<path d="M7 10.5v9.5H4.5A1.5 1.5 0 0 1 3 18.5v-6A1.5 1.5 0 0 1 4.5 11H7zm0 0 4-7.5a2 2 0 0 1 2 2V9h5.2a2 2 0 0 1 2 2.4l-1.2 6.2a2.5 2.5 0 0 1-2.5 2H7"/>'),
  plug: G('<path d="M9 3.5V8M15 3.5V8"/><path d="M6.5 8h11v3.2a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.7V21"/>'),
  antenna: G('<path d="M12 21v-7.5"/><circle cx="12" cy="9.5" r="2"/><path d="M8.2 5.8a5.4 5.4 0 0 0 0 7.4M15.8 5.8a5.4 5.4 0 0 1 0 7.4M5.5 3a9.2 9.2 0 0 0 0 13M18.5 3a9.2 9.2 0 0 1 0 13"/>'),
  gauge: G('<path d="M4.5 17.5a8.5 8.5 0 1 1 15 0"/><path d="M12 14.5 16 9"/><circle cx="12" cy="15.5" r="1.4"/>'),
  bank: G('<path d="M3.5 9.5 12 4l8.5 5.5h-17z"/><path d="M5.5 9.5V18M10 9.5V18M14 9.5V18M18.5 9.5V18"/><path d="M3.5 18h17M2.5 21h19"/>'),
  cash: G('<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v.01M18 14v.01"/>'),
  safe: G('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="3.4"/><path d="M12 10.4v1.6l1.2 1.2"/><path d="M7 4V2.8M17 4V2.8"/>'),
  percent: G('<path d="M19 5 5 19"/><circle cx="7.2" cy="7.2" r="2.4"/><circle cx="16.8" cy="16.8" r="2.4"/>'),
  basket: G('<path d="M4 10h16l-1.6 8.4a2.4 2.4 0 0 1-2.4 2H8a2.4 2.4 0 0 1-2.4-2z"/><path d="M8.5 10 12 3.5 15.5 10"/><path d="M9.5 14v3M14.5 14v3"/>'),
  store: G('<path d="M4 9.5 5.4 4h13.2L20 9.5"/><path d="M4.5 9.5a2.3 2.3 0 0 0 4.6 0 2.35 2.35 0 0 0 4.7 0 2.35 2.35 0 0 0 4.7 0 2.3 2.3 0 0 0 1.5 0"/><path d="M5.5 12.5V20h13v-7.5"/><path d="M9.5 20v-5h5v5"/>'),
  tv: G('<rect x="3" y="7" width="18" height="12.5" rx="2.5"/><path d="m8 2.8 4 4 4-4"/><path d="M10.5 11.5 15 13.25l-4.5 1.75z"/>'),
  film: G('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>'),
  headphones: G('<path d="M4 14.5v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4.5" height="6.5" rx="2"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="2"/>'),
  clapper: G('<rect x="3" y="10" width="18" height="10" rx="2"/><path d="M3.5 10 5.2 4.4a2 2 0 0 1 2.5-1.3l12.5 3.4-1 4"/><path d="m8.8 5.4 2.9 4M13.3 6.7l2.9 4"/>'),
  briefcase: G('<rect x="3" y="7.5" width="18" height="12.5" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/><path d="M3 13h18"/><path d="M12 12v2.5"/>'),
  target: G('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  award: G('<circle cx="12" cy="9" r="5.5"/><path d="m9 13.5-2 7.5 5-2.6 5 2.6-2-7.5"/><path d="M12 6.8l.9 1.7 1.9.3-1.4 1.3.3 1.9-1.7-.9-1.7.9.3-1.9-1.4-1.3 1.9-.3z"/>'),
  pen: G('<path d="M13.5 6.5 17.5 10.5"/><path d="M4 20l1.2-4.5L16.4 4.3a2.1 2.1 0 0 1 3 3L8.5 18.8z"/>'),
  car: G('<path d="M5 16.5 6.2 11a2.5 2.5 0 0 1 2.4-1.8h6.8A2.5 2.5 0 0 1 17.8 11l1.2 5.5"/><path d="M4 16.5h16a1.5 1.5 0 0 1 1.5 1.5v2h-3v-1.5h-13V20h-3v-2a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M7 13.5h.01M17 13.5h.01"/>'),
  plane: G('<path d="M10.5 13.5 3 11l1.5-1.5 6 .5 5-5.5a1.6 1.6 0 0 1 2.3 2.3l-5.5 5 .5 6L11 19.5l-2.5-7.5z"/>'),
  flower: G('<circle cx="12" cy="11" r="2.2"/><path d="M12 8.8c-3.5-4.5 3.5-4.5 0 0zM14.2 11c5.5-1.5 1.5 4.5 0 0zM12 13.2c3.5 4.5-3.5 4.5 0 0zM9.8 11c-5.5 1.5-1.5-4.5 0 0z"/><path d="M12 15.5V21"/>'),
  paw: G('<circle cx="7" cy="9" r="1.8"/><circle cx="12" cy="7.5" r="1.8"/><circle cx="17" cy="9" r="1.8"/><path d="M12 11.5c2.8 0 5 2 5 4.4 0 2-1.6 3.1-3.2 2.6a6 6 0 0 0-3.6 0c-1.6.5-3.2-.6-3.2-2.6 0-2.4 2.2-4.4 5-4.4z"/>'),
  hex: G('<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="M12 7.2 16.2 9.6v4.8L12 16.8l-4.2-2.4V9.6z"/>'),
  chain: G('<path d="M9.5 14.5a4 4 0 0 1 0-5.6l3-3a4 4 0 0 1 5.6 5.6l-1.6 1.6"/><path d="M14.5 9.5a4 4 0 0 1 0 5.6l-3 3a4 4 0 0 1-5.6-5.6l1.6-1.6"/>'),
  pick: G('<path d="M3.5 8.5C6 5 10 3 14.5 3c2.4 0 4.6.5 6.5 1.5-4.5 0-8 1.5-10.5 4"/><path d="m10 9 10 10"/><path d="m7.5 11.5 5 5L11 18a2.1 2.1 0 0 1-3-3z"/>'),
  seed: G('<circle cx="12" cy="12" r="9"/><path d="M12 17v-5.5"/><path d="M12 11.5c0-2.5-1.8-4-4.3-4 0 2.6 1.8 4 4.3 4z"/><path d="M12 11.5c0-2.5 1.8-4 4.3-4 0 2.6-1.8 4-4.3 4z"/>'),
  swap: G('<path d="M7 4.5 3.5 8 7 11.5"/><path d="M3.5 8H17a3.5 3.5 0 0 1 3.5 3.5"/><path d="m17 19.5 3.5-3.5L17 12.5"/><path d="M20.5 16H7a3.5 3.5 0 0 1-3.5-3.5"/>'),
  flat: I('<path d="M4 12h16"/><path d="M4 16.5h10" opacity=".45"/>'),
};

// glyph tile: colored rounded square with the mark, or a letter fallback
export function glyphTile(id, color, letter) {
  const mark = glyphs[id];
  return h('span', { class: 'glyph-tile', style: { '--gc': color } },
    mark ? h('span', { class: 'glyph-tile__mark', html: mark }) : h('span', { class: 'glyph-tile__letter' }, (letter ?? '?').toUpperCase()));
}

// ---------- haptic feedback (mobile, silent no-op elsewhere) ----------
export function vibrate(ms = 8) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

// ---------- toasts: dynamic island notes ----------
// spring in, drain a quiet progress bar, hold while the pointer rests on
// them, leave with the same spring — stacked, capped, RTL-aware.
export function toast(msg, kind = 'info', ms = 2600) {
  const box = document.getElementById('toasts');
  let gone = false, start = Date.now(), left = ms, timer = null;
  const close = () => {
    if (gone || !el.isConnected) return;
    gone = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  };
  const arm = (m) => { clearTimeout(timer); start = Date.now(); left = m; timer = setTimeout(close, m); };
  const el = h('div', { class: `toast toast--${kind}`, role: 'status' },
    h('span', { class: 'toast__icn', 'aria-hidden': 'true' }, icon(kind === 'ok' ? 'check' : kind === 'err' ? 'x' : 'info')),
    h('span', { class: 'toast__msg' }, msg),
    h('span', { class: 'toast__bar', style: { animationDuration: `${Math.max(1200, ms)}ms` }, 'aria-hidden': 'true' }),
    h('button', { class: 'toast__x', 'aria-label': t('close'), onclick: (e) => { e.stopPropagation(); close(); } }, icon('x')));
  arm(ms);
  el.addEventListener('mouseenter', () => {
    if (gone) return;
    clearTimeout(timer);
    left = Math.max(600, left - (Date.now() - start));
    el.classList.add('hold');
  });
  el.addEventListener('mouseleave', () => {
    if (gone) return;
    el.classList.remove('hold');
    arm(left);
  });
  box.append(el);
  // the stack stays readable — the oldest note gives its seat away
  while (box.children.length > 4) box.firstElementChild?.remove();
  vibrate(kind === 'err' ? [14, 60, 14] : 8);
}

// ---------- the frozen share page (suspended share) ----------
// a suspended share keeps the credential working and the guest signed in,
// but an icy glass room answers instead of the inbox — and it rechecks on
// its own, so the moment the admin unsuspends (or re-assigns mailboxes),
// the guest walks back in untouched, with a hello toast. The card shows the
// REASON (suspended by the admin / no mailbox assigned) and — when the
// subscription has an end — the remaining time, ticking live or standing
// perfectly still when the admin froze the countdown.
let frozenTimer = null;
let frozenClock = null;
async function recheckFrozen() {
  try {
    const r = await fetch('/api/emails?limit=1', { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.ok && d.suspended === false) shareUnfrozen(true);
  } catch { /* offline — stay frozen, the timer tries again */ }
}
async function frozenLogout() {
  clearInterval(frozenTimer);
  clearInterval(frozenClock);
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* session already gone */ }
  location.assign('/');
}
export function shareFrozen(share = null) {
  if (document.getElementById('share-frozen')) return;
  // the reason line: why is this share frozen? (no payload → the neutral text)
  const reasonKey = !share ? 'shareFrozenDesc'
    : (share.time_frozen || share.address_ids?.length || share.address) ? 'shareFrozenManual'
    : 'shareFrozenNoMailbox';
  // remaining subscription time — frozen shows a constant, otherwise it ticks
  let leftMs = null;
  if (share?.expires_at) {
    leftMs = share.time_frozen && share.frozen_at
      ? Math.max(0, Number(share.expires_at) - Number(share.frozen_at))
      : Math.max(0, Number(share.expires_at) - Date.now());
  }
  const leftEl = leftMs !== null ? h('span', { class: 'share-frozen__left mono' }, fmtCountdown(leftMs, t)) : null;
  const leftRow = leftEl ? h('div', { class: 'share-frozen__clock' }, icon('clock'), h('span', {}, `${t('shareFrozenLeft')}: `), leftEl) : null;
  const el = h('div', { class: 'share-frozen', id: 'share-frozen', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('shareFrozenTitle') },
    h('div', { class: 'share-frozen__card glass' },
      h('span', { class: 'share-frozen__sigil', 'aria-hidden': 'true' }, icon('snow')),
      h('h2', { class: 'share-frozen__title' }, t('shareFrozenTitle')),
      h('p', { class: 'share-frozen__desc' }, t(reasonKey)),
      leftRow,
      h('div', { class: 'share-frozen__acts' },
        h('button', { class: 'btn', onclick: recheckFrozen }, icon('refresh'), t('shareFrozenRetry')),
        h('button', { class: 'btn btn--ghost', onclick: frozenLogout }, icon('logout'), t('lockLogout')))));
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('is-on'));
  clearInterval(frozenTimer);
  frozenTimer = setInterval(recheckFrozen, 45_000);
  // a live countdown while the time is allowed to burn; a frozen countdown
  // is a constant — drawing it once is enough
  clearInterval(frozenClock);
  if (leftEl && leftMs > 0 && !(share?.time_frozen && share?.frozen_at)) {
    const end = Date.now() + leftMs;
    frozenClock = setInterval(() => {
      const v = end - Date.now();
      if (v <= 0) { leftEl.textContent = t('soon'); clearInterval(frozenClock); return; }
      leftEl.textContent = fmtCountdown(v, t);
    }, 1000);
  }
}
export function shareUnfrozen(resumed = false) {
  clearInterval(frozenTimer);
  clearInterval(frozenClock);
  const el = document.getElementById('share-frozen');
  if (!el) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 380);
  if (resumed) toast(t('shareResumed'), 'ok', 3800);
}

// ---------- modal (bottom-sheet on touch devices) ----------
// every open modal registers its closer here — one sweep on navigation
// retires the dialog AND its Escape listener together
const liveClosers = new Set();

export function closeAllOverlays() {
  for (const fn of [...liveClosers]) { try { fn(); } catch { /* already gone */ } }
  // floating menus + account popovers die with the page too
  document.querySelectorAll('.menu--float, .acct-menu, .glyph-picker-wrap.is-open')
    .forEach((m) => m.remove());
}

export function modal({ title, iconName, body, footer, wide, onClose, cls = '' }) {
  const root = document.getElementById('modals');
  const back = h('div', { class: 'modal-back' });
  const sheet = window.matchMedia?.('(max-width: 860px)').matches;
  const m = h('div', { class: `modal ${wide ? 'modal--wide' : ''} ${sheet ? 'modal--sheet' : ''} ${cls}`.trim(), role: 'dialog', 'aria-modal': 'true' });
  if (sheet) m.append(h('span', { class: 'modal__grab', 'aria-hidden': 'true' }));
  // closing is idempotent and retires its own Escape listener — closing from
  // the × (or a footer button) used to leave the key handler behind, so a later
  // Escape re-ran the dead modal's onClose and scrambled the page
  let open = true;
  const esc2 = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    if (!open) return;
    open = false;
    liveClosers.delete(close);
    document.removeEventListener('keydown', esc2);
    back.remove();
    onClose?.();
  };
  liveClosers.add(close);
  vibrate(5);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', esc2);

  if (title) m.append(h('div', { class: 'modal__head' }, h('h3', { class: 'modal__title' }, iconName ? icon(iconName) : '', title),
    h('button', { class: 'icon-btn', onclick: close }, icon('x'))));
  const bd = h('div', { class: 'modal__body' });
  // null/false entries are skipped, never stringified — Element.append(null)
  // paints the literal word "null" (the guest's account modal taught us that)
  if (body) bd.append(...(Array.isArray(body) ? body.filter((x) => x != null && x !== false) : [body]));
  m.append(bd);
  if (footer) m.append(h('div', { class: 'modal__foot' }, ...(Array.isArray(footer) ? footer.filter((x) => x != null && x !== false) : [footer])));
  back.append(m);
  root.append(back);
  return { close, el: m, body: bd };
}

export function confirmBox(text, onYes, danger = true) {
  const m = modal({
    title: text, iconName: 'info',
    footer: [
      h('button', { class: 'btn', onclick: () => m.close() }, t('cancel')),
      h('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, onclick: () => { m.close(); onYes(); } }, t('yes')),
    ],
  });
}

// ---------- dropdown menu ----------
// the menu lives on <body> with fixed viewport coordinates, hugging its
// anchor — a background list redraw can never yank it away mid-tap, and its
// clicks never bubble back into the button that spawned it
export function dropdown(anchor, items) {
  vibrate(5);
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu menu--float', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div', { class: 'menu__sep' })); continue; }
    menu.append(h('a', { class: 'menu__item', href: it.href ?? '#', onclick: (e) => { if (it.fn) { e.preventDefault(); it.fn(); } menu.remove(); e.stopPropagation(); } },
      it.icon ? icon(it.icon) : '', it.label, it.badge ? h('span', { class: 'addr-item__badge', style: { marginLeft: 'auto' } }, it.badge) : ''));
  }
  document.body.append(menu);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight, mw = menu.offsetWidth;
    menu.style.position = 'fixed';
    menu.style.top = `${Math.max(10, Math.min(r.bottom + 8, window.innerHeight - mh - 10))}px`;
    menu.style.insetInlineEnd = 'auto';
    menu.style.insetInlineStart = 'auto';
    if (document.documentElement.dir === 'rtl') {
      menu.style.right = `${Math.max(9, window.innerWidth - r.right)}px`;
      menu.style.left = 'auto';
    } else {
      menu.style.left = `${Math.max(9, Math.min(r.left, window.innerWidth - mw - 9))}px`;
      menu.style.right = 'auto';
    }
  };
  place();
  const close = () => { menu.remove(); document.removeEventListener('click', off); window.removeEventListener('resize', close); };
  const off = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', off), 0);
  window.addEventListener('resize', close);
  return menu;
}

// ---------- clipboard ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
}

// ---------- time formatting ----------
export function timeAgo(ts, t) {
  const d = Date.now() - ts;
  if (d < 60_000) return t('justNow');
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} ${t('minutesAgo')}`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} ${t('hoursAgo')}`;
  return `${Math.floor(d / 86_400_000)} ${t('daysAgo')}`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString(document.documentElement.lang === 'fa' ? 'fa-IR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtCountdown(ms, t) {
  if (ms <= 0) return t('expired');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function avatarColor(str) {
  const palette = ['#8fae7e', '#7ea3b1', '#a08cb5', '#c9a86a', '#c2848a', '#7fae9a', '#a38f6f', '#8b9e78'];
  let x = 0;
  for (const ch of String(str ?? '?')) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[x % palette.length];
}
