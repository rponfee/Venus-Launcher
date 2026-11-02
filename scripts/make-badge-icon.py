# Genera los iconos de 8x8 de la insignia de Venus (mod/venus-badge: assets/venusbadge/textures/font/badge.png, una
# tira de 32x8 con un icono por estilo: el de siempre, dorado (premium), nebulosa y hielo; los dos ultimos se compran
# con Venus Points). Base: cada pixel es el promedio de los pixeles opacos de su celda de 8x8 en logo-64.png, dentro de
# un circulo pixelado con bordes duros (la fuente de Minecraft se ve mejor sin semitransparencias). Los demas estilos
# recolorean la base por brillo con una rampa de tres colores. El orden tiene que coincidir con STYLES de VenusBadge.java.
# Requiere Pillow:  python -m pip install pillow
# Uso:  python scripts/make-badge-icon.py
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, 'src', 'renderer', 'assets', 'logo-64.png')
OUT = os.path.join(ROOT, 'mod', 'venus-badge', 'src', 'main', 'resources', 'assets', 'venusbadge', 'textures', 'font', 'badge.png')
MASK = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', '.XXXXXX.', '..XXXX..']


# (oscuro, medio, claro) de cada estilo; None = colores originales del logo
STYLES = [
    ('default', None),
    ('gold', ((122, 74, 0), (255, 200, 40), (255, 246, 192))),
    ('nebula', ((58, 10, 92), (176, 74, 224), (255, 179, 240))),
    ('ice', ((10, 58, 92), (74, 200, 240), (232, 251, 255))),
]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def recolor(img, ramp):
    out = img.copy()
    for y in range(8):
        for x in range(8):
            r, g, b, a = img.getpixel((x, y))
            if not a:
                continue
            lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
            c = lerp(ramp[0], ramp[1], lum / 0.6) if lum < 0.6 else lerp(ramp[1], ramp[2], (lum - 0.6) / 0.4)
            out.putpixel((x, y), (*c, 255))
    return out


def base_icon():
    src = Image.open(LOGO).convert('RGBA')
    px = src.load()
    out = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
    for cy in range(8):
        for cx in range(8):
            if MASK[cy][cx] != 'X':
                continue
            acc, n = [0, 0, 0], 0
            for y in range(cy * 8, cy * 8 + 8):
                for x in range(cx * 8, cx * 8 + 8):
                    r, g, b, a = px[x, y]
                    if a > 128:
                        acc[0] += r
                        acc[1] += g
                        acc[2] += b
                        n += 1
            if n == 0:
                acc, n = list(px[32, 32][:3]), 1
            out.putpixel((cx, cy), (acc[0] // n, acc[1] // n, acc[2] // n, 255))
    return out


def main():
    base = base_icon()
    strip = Image.new('RGBA', (8 * len(STYLES), 8), (0, 0, 0, 0))
    for i, (_name, ramp) in enumerate(STYLES):
        strip.paste(base if ramp is None else recolor(base, ramp), (8 * i, 0))
    strip.save(OUT)
    print(OUT)


if __name__ == '__main__':
    main()
