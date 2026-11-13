#!/usr/bin/env python3
"""Cmail — losslessly-ish recompress the brand PNGs before embedding them
into the single-file worker build. Flat glass artwork tolerates an adaptive
palette extremely well; bytes drop 4-6x with no visible change."""
import os, sys
from PIL import Image

IMG = 'public/assets/img'
# per-file palette budget (flat marks get fewer colors, glass logos a bit more)
BUDGET = {
    'logo-dark.png': 256,
    'logo-light.png': 256,
    'mark-dark.png': 256,
    'mark-white.png': 256,
    'icon-black.png': 256,
    'icon-white.png': 192,
    'favicon-512.png': 256,
    'favicon-192.png': 128,
    'apple-touch-icon.png': 128,
    'favicon-64.png': 64,
    'favicon-64-dark.png': 64,
    'favicon-32.png': 32,
}

total_before = total_after = 0
for name, colors in BUDGET.items():
    p = os.path.join(IMG, name)
    before = os.path.getsize(p)
    im = Image.open(p).convert('RGBA')
    # keep full alpha precision: quantize in P mode with alpha, then back
    q = im.quantize(colors=colors, method=Image.FASTOCTREE, dither=Image.NONE)
    out = p + '.tmp.png'
    q.save(out, optimize=True)
    after = os.path.getsize(out)
    if after < before:
        os.replace(out, p)
    else:
        os.remove(out)
        after = before
    total_before += before
    total_after += after
    print(f'{name:24s} {im.size} {before:7d} -> {after:7d}  ({100*after//before}%)')

print(f'{"TOTAL":24s} {"":9s} {total_before:7d} -> {total_after:7d}  ({100*total_after//total_before}%)')
sys.exit(0)
