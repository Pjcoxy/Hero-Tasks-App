from PIL import Image, ImageDraw
import math

BRAND      = (109, 59, 245)   # #6d3bf5 - manifest theme_color
RIM        = (74, 31, 176)    # shield outer rim, from the artwork
RIM_LIGHT  = (124, 78, 226)   # top highlight on the rim
INNER      = (47, 67, 202)    # #2f43ca shield face
INNER_DEEP = (32, 46, 150)    # lower shading
GOLD       = (255, 184, 21)   # #ffb815 star
GOLD_DEEP  = (214, 138, 6)    # star lower facet

SS = 4  # supersample, downsampled at the end for clean edges

def shield_path(cx, cy, w, h):
    """Crest outline: squared shoulders, straight flanks, curved to a point."""
    l, r = cx - w / 2, cx + w / 2
    top = cy - h / 2
    bot = cy + h / 2
    shoulder = top + h * 0.06
    flank = top + h * 0.46
    pts = [(l + w * 0.06, top), (r - w * 0.06, top),
           (r, shoulder), (r, flank)]
    # Quadratic from the right flank to the bottom point, and mirrored back.
    for side in (1, -1):
        x0, y0 = cx + side * w / 2, flank
        x1, y1 = cx + side * w * 0.44, bot - h * 0.06   # control
        x2, y2 = cx, bot
        rng = [i / 24 for i in range(25)] if side == 1 else [i / 24 for i in range(1, 25)]
        for t in rng:
            u = 1 - t
            pts.append((u * u * x0 + 2 * u * t * x1 + t * t * x2,
                        u * u * y0 + 2 * u * t * y1 + t * t * y2))
        if side == 1:
            pts = pts[:-1] + [(cx, bot)]
            # mirror: walk back up the left side
            x0, y0 = cx, bot
            x1, y1 = cx - w * 0.44, bot - h * 0.06
            x2, y2 = l, flank
            for t in [i / 24 for i in range(1, 25)]:
                u = 1 - t
                pts.append((u * u * x0 + 2 * u * t * x1 + t * t * x2,
                            u * u * y0 + 2 * u * t * y1 + t * t * y2))
            pts += [(l, shoulder)]
            break
    return pts

def star(cx, cy, outer, inner, rot=-90):
    pts = []
    for i in range(10):
        a = math.radians(rot + i * 36)
        rad = outer if i % 2 == 0 else inner
        pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    return pts

def build(size, maskable=False):
    S = size * SS
    if maskable:
        # The OS applies its own mask, so this stays a full-bleed square.
        im = Image.new('RGBA', (S, S), BRAND + (255,))
    else:
        # Rounded square with TRANSPARENT corners. Filling them with black
        # instead leaves black corners on every launcher that does not mask.
        im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(im).rounded_rectangle(
            [0, 0, S - 1, S - 1], radius=int(S * 0.1875), fill=BRAND + (255,))
    d = ImageDraw.Draw(im)

    # Maskable keeps the mark inside the 80% safe zone.
    scale = 0.58 if maskable else 0.74
    w = S * scale
    h = w * 1.08
    cx, cy = S / 2, S / 2 - h * 0.02

    d.polygon(shield_path(cx, cy + S * 0.012, w, h), fill=(20, 8, 60, 90))    # drop shadow
    d.polygon(shield_path(cx, cy, w, h), fill=RIM)                            # rim
    d.polygon(shield_path(cx, cy - h * 0.012, w * 0.99, h * 0.99), fill=RIM_LIGHT)
    d.polygon(shield_path(cx, cy, w * 0.97, h * 0.97), fill=RIM)
    d.polygon(shield_path(cx, cy + h * 0.005, w * 0.80, h * 0.80), fill=INNER_DEEP)
    d.polygon(shield_path(cx, cy - h * 0.005, w * 0.79, h * 0.79), fill=INNER)

    r = w * 0.30
    d.polygon(star(cx, cy + h * 0.015, r, r * 0.44), fill=GOLD_DEEP)
    d.polygon(star(cx, cy, r, r * 0.44), fill=GOLD)

    return im.resize((size, size), Image.LANCZOS)


def check_alpha(path):
    im = Image.open(path)
    return im.mode, im.getpixel((1, 1))

for size in (512, 192):
    build(size).save(f'frontend/icon-{size}.png')
build(512, maskable=True).save('frontend/icon-maskable.png')
# apple-touch-icon: iOS composites it on black and rounds it itself, so a
# transparent-cornered icon comes out with black corners. Full-bleed square.
build(180, maskable=True).convert('RGB').save('frontend/icon-180.png')
for f in ('icon-512.png', 'icon-192.png', 'icon-180.png', 'icon-maskable.png'):
    print(f, check_alpha('frontend/' + f))
print('icons written')
