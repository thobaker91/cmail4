#!/usr/bin/env python3
# Cmail — generate animated hero banners + badges for the READMEs
# Output: docs/img/hero-en.svg, docs/img/hero-fa.svg, docs/img/badge-*.svg
# Persian text elements carry direction="rtl" so the bidi algorithm keeps
# the word order honest (a plain LTR base scrambles lines starting with
# digits like "2FA").
import os

OUT = '/home/z/my-project/cmail/docs/img'

HERO_EN = {
    'file': 'hero-en.svg', 'fa': False,
    'tag': 'YOUR MAIL, YOUR RULES',
    'sub1': 'A complete email universe on your own Cloudflare',
    'sub2': 'temp inboxes, addresses, notes, a 2FA vault.',
    'rows': [
        ('S', '#c9a26a', 'Security Alerts', 'New sign-in to your account'),
        ('L', '#7fa5d9', 'Linux Mag', 'Weekly digest: kernel 6.12 is out'),
        ('P', '#b98fd4', 'Payment Gateway', 'Receipt #8842 — paid successfully'),
    ],
    'chip': 'v2.9.5 — Folders on every account · scenes behind the glass',
    'font': 'Segoe UI, system-ui, sans-serif',
}
HERO_FA = {
    'file': 'hero-fa.svg', 'fa': True,
    'tag': 'ایمیلت، قانونش را خودت می‌گذاری',
    'sub1': 'یک دنیای کامل ایمیل روی Cloudflare خودت —',
    'sub2': 'صندوق موقت، آدرس دائمی، یادداشت‌ها و گاوصندوق 2FA.',
    'rows': [
        ('س', '#c9a26a', 'هشدار امنیتی', 'ورود جدید به حسابت'),
        ('ل', '#7fa5d9', 'لینوکس‌مگ', 'خلاصهٔ هفته: هستهٔ ۶٫۱۲ منتشر شد'),
        ('پ', '#b98fd4', 'درگاه پرداخت', 'رسید #۸۸۴۲ — پرداخت موفق'),
    ],
    'chip': 'نسخهٔ ۲.۹ — صندوق نو با ساختار بزرگ‌سال‌ها · بیضی هویت با کپی آدرس · همهٔ نامه‌ها در یک کارت',
    'font': 'Vazirmatn, Tahoma, sans-serif',
}

def hero(d):
    fa = d['fa']
    # geometry: brand + headline live on the right side for Persian
    edge = 1136 if fa else 64            # headline anchor (start-of-text edge)
    anchor = 'start' if fa else 'start'  # direction decides which way it flows
    brand_cx = 1136 if fa else 64
    brand_tx = brand_cx - (36 if fa else 0) - 0
    brand_anchor = 'end' if fa else 'start'
    brand_tx = brand_cx - 36 if fa else brand_cx + 34
    # inbox card occupies the opposite side
    card_x = 96 if fa else 774
    av_x = card_x + 282          # avatar center
    
    txt_x = card_x + 244 if fa else card_x + 46
    dot_x = card_x + 26 if fa else card_x + 306
    T = f' direction="rtl"' if fa else ''
    rows = ''
    for i, (g, color, name, subj) in enumerate(d['rows']):
        y = 156 + i * 70
        begin = 0.9 + i * 0.55
        rows += f'''
    <g opacity="0">
      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.86;1" dur="7.2s" begin="{begin}s" repeatCount="indefinite"/>
      <animateTransform attributeName="transform" type="translate" values="0 14;0 0;0 0;0 -6" keyTimes="0;0.12;0.86;1" dur="7.2s" begin="{begin}s" repeatCount="indefinite"/>
      <circle cx="{av_x}" cy="{y}" r="17" fill="{color}" opacity="0.92"/>
      <text x="{av_x}" y="{y+5}" font-family="{d['font']}" font-size="15" font-weight="700" fill="#0c1116" text-anchor="middle">{g}</text>
      <text x="{txt_x}" y="{y-2}" font-family="{d['font']}" font-size="15.5" font-weight="700" fill="#eef4f0" text-anchor="{"start" if fa else "start"}"{T}>{name}</text>
      <text x="{txt_x}" y="{y+17}" font-family="{d['font']}" font-size="12.5" fill="#93a39b" text-anchor="{"start" if fa else "start"}"{T}>{subj}</text>
      <circle cx="{dot_x}" cy="{y}" r="4" fill="#8fd0a5"/>
    </g>'''
    dot_chip_x = edge - 24 if fa else edge + 24
    chip_x = edge - 470 if fa else edge
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420" role="img" aria-label="Cmail">
  <defs>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#9be3b4"><animate attributeName="stop-color" values="#9be3b4;#8ec9e8;#c2a7e2;#9be3b4" dur="9s" repeatCount="indefinite"/></stop>
      <stop offset="0.55" stop-color="#8ec9e8"><animate attributeName="stop-color" values="#8ec9e8;#c2a7e2;#9be3b4;#8ec9e8" dur="9s" repeatCount="indefinite"/></stop>
      <stop offset="1" stop-color="#8fd0a5"/>
    </linearGradient>
    <radialGradient id="glowA" cx="0.16" cy="0.2" r="0.55">
      <stop offset="0" stop-color="#4f8f60" stop-opacity="0.34"><animate attributeName="stop-opacity" values="0.34;0.5;0.34" dur="8s" repeatCount="indefinite"/></stop>
      <stop offset="1" stop-color="#4f8f60" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.88" cy="0.85" r="0.6">
      <stop offset="0" stop-color="#2f7fb0" stop-opacity="0.3"><animate attributeName="stop-opacity" values="0.3;0.46;0.3" dur="10s" repeatCount="indefinite"/></stop>
      <stop offset="1" stop-color="#2f7fb0" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cardbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="420" rx="26" fill="#0b0f14"/>
  <rect width="1200" height="420" rx="26" fill="url(#glowA)"/>
  <rect width="1200" height="420" rx="26" fill="url(#glowB)"/>
  <rect x="1" y="1" width="1198" height="418" rx="25" fill="none" stroke="#ffffff" stroke-opacity="0.1"/>

  <!-- brand -->
  <g>
    <circle cx="{brand_cx}" cy="76" r="21" fill="none" stroke="url(#shine)" stroke-width="2.5">
      <animate attributeName="r" values="21;22.5;21" dur="3.2s" repeatCount="indefinite"/>
    </circle>
    <circle cx="{brand_cx}" cy="76" r="9" fill="url(#shine)">
      <animate attributeName="opacity" values="0.75;1;0.75" dur="3.2s" repeatCount="indefinite"/>
    </circle>
    <text x="{brand_tx}" y="84" font-family="Segoe UI, system-ui, sans-serif" font-size="30" font-weight="800" fill="url(#shine)" text-anchor="{brand_anchor}">Cmail</text>
  </g>

  <!-- headline -->
  <text x="{edge}" y="158" font-family="{d['font']}" font-size="13.5" font-weight="700" letter-spacing="3" fill="#7fae8f" text-anchor="{"start" if fa else "start"}"{T}>{d['tag']}</text>
  <text x="{edge}" y="210" font-family="{d['font']}" font-size="25" font-weight="800" fill="#f2f7f3" text-anchor="{"start" if fa else "start"}"{T}>{d['sub1']}</text>
  <text x="{edge}" y="250" font-family="{d['font']}" font-size="25" font-weight="800" fill="#f2f7f3" text-anchor="{"start" if fa else "start"}"{T}>{d['sub2']}</text>

  <!-- inbox card -->
  <g>
    <rect x="{card_x}" y="96" width="330" height="272" rx="20" fill="url(#cardbg)" stroke="#ffffff" stroke-opacity="0.12"/>
    <text x="{card_x + 296 if fa else card_x + 24}" y="131" font-family="{d['font']}" font-size="13" font-weight="700" fill="#ffffff" fill-opacity="0.55" text-anchor="{"start" if fa else "start"}"{T}>{"صندوق" if fa else "Inbox"}</text>
    <circle cx="{card_x + 30 if fa else card_x + 300}" cy="126" r="5" fill="#8fd0a5">
      <animate attributeName="opacity" values="1;0.3;1" dur="2.2s" repeatCount="indefinite"/>
    </circle>
    <line x1="{card_x + 24}" y1="146" x2="{card_x + 306}" y2="146" stroke="#ffffff" stroke-opacity="0.08"/>
    {rows}
  </g>

  <!-- feature chip -->
  <g>
    <rect x="{chip_x}" y="304" width="470" height="40" rx="20" fill="#ffffff" fill-opacity="0.05" stroke="#ffffff" stroke-opacity="0.12"/>
    <circle cx="{dot_chip_x}" cy="324" r="4.5" fill="#9be3b4">
      <animate attributeName="opacity" values="1;0.35;1" dur="2.6s" repeatCount="indefinite"/>
    </circle>
    <text x="{edge - 40 if fa else edge + 42}" y="329" font-family="{d['font']}" font-size="14.5" font-weight="600" fill="#cfe0d4" text-anchor="{"start" if fa else "start"}"{T}>{d['chip']}</text>
  </g>
</svg>'''

BADGES = [
    ('badge-version.svg',  'version',            'v2.9.5',             '#2f9e63', '#0b0f14', '#e8f5ec'),
    ('badge-platform.svg', 'runs on',            'Cloudflare Workers', '#c05f2a', '#0b0f14', '#fdeee4'),
    ('badge-storage.svg',  'storage',            'one D1 database',    '#2f7fb0', '#0b0f14', '#e6f2fa'),
    ('badge-license.svg',  'license',            'MIT',                '#7e5fa6', '#0b0f14', '#f1ecf9'),
]

def badge(name, label, value, color, bg, fg):
    w = 24 + len(label) * 7.2 + 18 + len(value) * 7.6 + 24
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="28" role="img" aria-label="{label}: {value}">
  <clipPath id="r"><rect width="{w:.0f}" height="28" rx="8"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="{w:.0f}" height="28" fill="{bg}"/>
    <rect width="{24 + len(label) * 7.2 + 18:.0f}" height="28" fill="{color}"/>
  </g>
  <text x="16" y="18.5" font-family="Segoe UI, system-ui, sans-serif" font-size="12" font-weight="700" fill="{fg}">{label}</text>
  <text x="{24 + len(label) * 7.2 + 18 + 12:.0f}" y="18.5" font-family="Segoe UI, system-ui, sans-serif" font-size="12" font-weight="600" fill="#e9efeb">{value}</text>
</svg>'''

os.makedirs(OUT, exist_ok=True)
for d in (HERO_EN, HERO_FA):
    with open(os.path.join(OUT, d['file']), 'w') as f:
        f.write(hero(d))
    print('wrote', d['file'])
for name, label, value, color, bg, fg in BADGES:
    with open(os.path.join(OUT, name), 'w') as f:
        f.write(badge(name, label, value, color, bg, fg))
    print('wrote', name)
