// Cmail — About view: the story, the features, the numbers, the maker.
// Liquid-glass polish: count-up numbers, pointer tilt, mood-tinted glow.
import { state } from '../api.js';
import { t, lang } from '../i18n.js';
import { h, icon } from '../ui.js';

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function renderAbout(root) {
  const app = root;
  const FA = (n) => lang === 'fa' ? String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]) : String(n);
  const VERSION = state.setup?.version || '3.0.0';

  // ---------- hero ----------
  const hero = h('section', { class: 'ab-hero glass' },
    h('div', { class: 'ab-hero__glow', 'aria-hidden': 'true' }),
    h('img', { class: 'ab-logo', src: 'assets/img/logo-dark.png', alt: 'Cmail' }),
    h('p', { class: 'ab-lead' }, t('aboutLead')),
    h('div', { class: 'ab-hero__meta' },
      h('span', { class: 'chip' }, icon('spark'), `${t('aboutVersion')} ${VERSION}`),
      h('span', { class: 'chip' }, icon('lock'), t('aboutOpen')),
    ),
    h('div', { class: 'ab-hero__links' },
      h('a', { class: 'btn btn--primary', href: 'https://github.com/Erfan-8910/CMail', target: '_blank', rel: 'noopener' }, icon('external'), t('aboutGithub')),
      h('a', { class: 'btn', href: '#/help' }, icon('help'), t('aboutGuide')),
    ),
  );

  // ---------- the sibling-project ribbon: Climind-W ----------
  // a slow aurora band advertising the maker's other project — living,
  // glassy, one press away from the repository. The sky mark reads the sky.
  const ribbon = h('a', {
    class: 'ab-ribbon', href: 'https://github.com/Erfan-8910/Climind-W', target: '_blank', rel: 'noopener',
    'aria-label': t('ribbonClimindCta'),
  },
    h('span', { class: 'ab-ribbon__aurora', 'aria-hidden': 'true' }),
    h('span', { class: 'ab-ribbon__mark', 'aria-hidden': 'true' }, icon('cloud')),
    h('span', { class: 'ab-ribbon__txt' },
      h('b', {}, h('span', { class: 'ab-ribbon__sigil', 'aria-hidden': 'true' }, icon('climind')), 'Climind-W'),
      h('span', { class: 'ab-ribbon__d' }, t('ribbonClimindDesc'))),
    h('span', { class: 'ab-ribbon__chip' }, t('ribbonClimindTag')),
    h('span', { class: 'ab-ribbon__cta' }, t('ribbonClimindCta'), icon('external')),
  );

  // ---------- feature grid (icon beside the title — always aligned) ----------
  const feats = [
    { icn: 'user', tt: 'f8T', dd: 'f8D' },
    { icn: 'clock', tt: 'f1T', dd: 'f1D' },
    { icn: 'note', tt: 'f2T', dd: 'f2D' },
    { icn: 'shield', tt: 'f3T', dd: 'f3D' },
    { icn: 'globe', tt: 'f4T', dd: 'f4D' },
    { icn: 'zap', tt: 'f7T', dd: 'f7D' },
    { icn: 'code', tt: 'f5T', dd: 'f5D' },
    { icn: 'database', tt: 'f6T', dd: 'f6D' },
  ];
  const grid = h('section', { class: 'ab-grid' },
    h('h2', { class: 'ab-h2' }, icon('spark'), t('aboutFeatures')),
    h('div', { class: 'ab-grid__in' }, feats.map((f, i) =>
      h('article', { class: 'ab-card glass tilt', style: { animationDelay: `${i * 60}ms` } },
        h('div', { class: 'ab-card__row' },
          h('span', { class: 'ab-card__icn' }, icon(f.icn)),
          h('h3', {}, t(f.tt))),
        h('p', {}, t(f.dd))))));

  // ---------- stats strip (count-up, RTL-safe) ----------
  const stats = h('section', { class: 'ab-stats' },
    stat(icon('user'), 2, lang === 'fa' ? 'حالت حساب' : 'account modes'),
    stat(icon('globe'), '∞', lang === 'fa' ? 'دامنه' : 'domains'),
    stat(icon('shield'), 6, lang === 'fa' ? 'رقم برای هر کد' : 'digit codes'),
    stat(icon('lock'), 'AES-GCM', lang === 'fa' ? 'رمزنگاری در حال استراحت' : 'encryption at rest'),
  );
  function stat(icn, v, l) {
    const num = typeof v === 'number';
    const b = num
      ? h('b', { class: 'ab-stat__v', dataset: { count: String(v) } }, FA(Math.round(v * 0.6)))
      : h('b', { class: 'ab-stat__v ab-stat__v--txt' }, v);
    return h('div', { class: 'ab-stat glass' },
      h('span', { class: 'ab-stat__icn' }, icn),
      h('div', { class: 'ab-stat__txt' }, b, h('span', { class: 'ab-stat__l' }, l)));
  }

  // ---------- stack ----------
  const stack = ['Cloudflare Workers', 'Cloudflare D1', 'Hono', 'WebCrypto', 'postal-mime', 'Vanilla JS', 'Zero CDN'];
  const stackRow = h('section', { class: 'ab-stack glass' },
    h('b', { class: 'ab-stack__t' }, t('aboutStack')),
    h('div', { class: 'ab-stack__chips' }, stack.map((s) => h('span', { class: 'chip' }, h('span', { class: 'chip-dot' }, ''), s))));

  // ---------- creator — the maker card, front and center ----------
  const creator = h('section', { class: 'ab-creator glass' },
    h('div', { class: 'ab-creator__glow', 'aria-hidden': 'true' }),
    h('span', { class: 'ab-creator__ava' }, 'E'),
    h('div', { class: 'ab-creator__txt' },
      h('div', { class: 'ab-creator__id' },
        h('h3', {}, 'Erfan'),
        h('span', { class: 'chip' }, icon('spark'), t('aboutMakerRole'))),
      h('p', {}, t('aboutCreatorD')),
      h('div', { class: 'ab-creator__links' },
        h('a', { class: 'btn btn--sm', href: 'https://github.com/Erfan-8910', target: '_blank', rel: 'noopener' }, icon('code'), t('viewGithub')),
        h('a', { class: 'btn btn--sm btn--primary', href: 'https://github.com/Erfan-8910/CMail', target: '_blank', rel: 'noopener' }, icon('heart'), t('viewProject')),
      )),
  );

  const made = h('p', { class: 'ab-made' }, t('madeBy'), h('span', { class: 'ab-made__heart', 'aria-label': 'heart' }, icon('heart')), t('madeByTail'), h('span', { class: 'version-pill' }, `Cmail v${VERSION} · ${FA(2025)}`));

  app.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'eyebrow' }, icon('heart'), t('eyebrowAbout')),
        h('h1', { class: 'page-title' }, t('navAbout')))),
    hero, ribbon, grid, stats, stackRow, creator, made,
  );

  // ---------- effects ----------
  animateCounters(stats);
  if (!reducedMotion) enableTilt(hero.querySelector('.ab-logo'), 10);
  if (!reducedMotion && window.matchMedia?.('(hover: hover)').matches) {
    app.querySelectorAll('.ab-card.tilt').forEach((c) => enableTilt(c, 4));
  }
}

// count-up when scrolled into view (starts close to the target — no zero flash)
function animateCounters(scope) {
  const els = scope.querySelectorAll?.('.ab-stat__v[data-count]');
  if (!els?.length) return;
  const fa = lang === 'fa';
  const fmt = (v) => fa ? String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]) : String(v);
  if (reducedMotion) {
    els.forEach((el) => { el.textContent = fmt(el.dataset.count); });
    return;
  }
  const run = (el) => {
    const target = parseInt(el.dataset.count, 10);
    const from = Math.round(target * 0.6);
    const t0 = performance.now(), dur = 620;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(from + (target - from) * eased));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      run(en.target);
      io.unobserve(en.target);
    }
  }, { threshold: .2 });
  els.forEach((el) => io.observe(el));
}

// subtle 3D parallax tilt (pointer-follow, springs back)
function enableTilt(el, max = 6) {
  if (!el) return;
  let raf = null;
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - .5;
    const py = (e.clientY - r.top) / r.height - .5;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      el.style.transform = `perspective(700px) rotateY(${(px * max).toFixed(2)}deg) rotateX(${(-py * max).toFixed(2)}deg)`;
    });
  });
  el.addEventListener('pointerleave', () => {
    cancelAnimationFrame(raf);
    el.style.transition = 'transform .6s cubic-bezier(.34,1.42,.4,1)';
    el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 620);
  });
}
