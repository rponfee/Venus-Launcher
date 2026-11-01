# Genera el icono de 8x8 de la insignia de Venus (mod/venus-badge: assets/venusbadge/textures/font/badge.png) a partir
# del logo del launcher: cada pixel es el promedio de los pixeles opacos de su celda de 8x8 en logo-64.png, dentro de
# un circulo pixelado con bordes duros (la fuente de Minecraft se ve mejor sin semitransparencias).
# Requiere Pillow:  python -m pip install pillow
# Uso:  python scripts/make-badge-icon.py
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, 'src', 'renderer', 'assets', 'logo-64.png')
OUT = os.path.join(ROOT, 'mod', 'venus-badge', 'src', 'main', 'resources', 'assets', 'venusbadge', 'textures', 'font', 'badge.png')
MASK = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', '.XXXXXX.', '..XXXX..']


def main():
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
    out.save(OUT)
    print(OUT)


if __name__ == '__main__':
    main()
