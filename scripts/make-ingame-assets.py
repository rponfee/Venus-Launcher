# Genera las imagenes del paquete de recursos "Venus Launcher" que el launcher activa dentro del juego
# (src/main/modules/ingame/assets): la pantalla de carga, el texto debajo del logo de Minecraft y el icono del
# paquete. Usa el logo del launcher y la fuente Pixelify Sans de node_modules/@fontsource.
# Requiere Pillow y fontTools:  python -m pip install pillow fonttools brotli
# Uso:  python scripts/make-ingame-assets.py
import io
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(ROOT, 'src', 'renderer', 'assets', 'logo-256.png')
FONT = os.path.join(ROOT, 'node_modules', '@fontsource', 'pixelify-sans', 'files', 'pixelify-sans-latin-700-normal.woff')
OUT = os.path.join(ROOT, 'src', 'main', 'modules', 'ingame', 'assets')

WHITE = (255, 255, 255, 255)
CREAM = (255, 226, 168, 255)
SHADOW = (92, 44, 8, 255)


def font(size):
    tt = TTFont(FONT)
    tt.flavor = None
    buf = io.BytesIO()
    tt.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def text_size(draw, text, f, spacing=0):
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0] + spacing * (len(text) - 1), box[3] - box[1], box


def draw_spaced(draw, xy, text, f, fill, spacing=0):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textbbox((0, 0), ch, font=f)[2] + spacing


def wordmark():
    # Logo completo en proporcion 4:1 (asi lo dibuja el juego: dos mitades de 2:1 una al lado de la otra).
    w, hgt = 1024, 256
    img = Image.new('RGBA', (w, hgt), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    big, small = font(156), font(64)
    bw, _, bb = text_size(d, 'VENUS', big, 10)
    sw, _, sb = text_size(d, 'LAUNCHER', small, 0)
    gap = max(0, (bw - sw) // 7)
    # Planeta y texto centrados juntos; LAUNCHER ocupa el mismo ancho que VENUS
    off = (w - (252 + bw)) // 2
    planet = Image.open(LOGO).convert('RGBA').resize((224, 224), Image.NEAREST)
    img.alpha_composite(planet, (off, 16))
    x_big = x_small = off + 252
    y_big = 18 - bb[1]
    y_small = 178 - sb[1]
    for dx, dy, fill in ((6, 6, SHADOW), (0, 0, WHITE)):
        draw_spaced(d, (x_big + dx, y_big + dy), 'VENUS', big, fill, 10)
    for dx, dy, fill in ((4, 4, SHADOW), (0, 0, CREAM)):
        draw_spaced(d, (x_small + dx, y_small + dy), 'LAUNCHER', small, fill, gap)
    return img


def loading_texture(mark):
    # textures/gui/title/mojangstudios.png: 120x120 de referencia; arriba va la mitad izquierda del logo y
    # abajo la derecha (LoadingOverlay dibuja cada mitad en 2:1).
    half = mark.width // 2
    tex = Image.new('RGBA', (half, half), (0, 0, 0, 0))
    tex.alpha_composite(mark.crop((0, 0, half, mark.height)), (0, 0))
    tex.alpha_composite(mark.crop((half, 0, mark.width, mark.height)), (0, half // 2))
    return tex


def edition():
    # textures/gui/title/edition.png: 128x16 de referencia; el juego dibuja la zona de 98x14 de arriba a la
    # izquierda centrada debajo del logo de Minecraft (donde dice "Java Edition").
    scale = 4
    tex = Image.new('RGBA', (128 * scale, 16 * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(tex)
    text = 'VENUS LAUNCHER'
    size = 46
    while True:  # la letra mas grande que entra en el ancho de la zona
        f = font(size)
        tw, _, box = text_size(d, text, f, 4)
        if tw <= 98 * scale - 8 or size <= 20:
            break
        size -= 2
    x = (98 * scale - tw) // 2
    y = (14 * scale - (box[3] - box[1])) // 2 - box[1]
    draw_spaced(d, (x + 3, y + 3), text, f, SHADOW, 4)
    draw_spaced(d, (x, y), text, f, WHITE, 4)
    return tex


def main():
    os.makedirs(OUT, exist_ok=True)
    mark = wordmark()
    loading_texture(mark).save(os.path.join(OUT, 'mojangstudios.png'), optimize=True)
    edition().save(os.path.join(OUT, 'edition.png'), optimize=True)
    Image.open(LOGO).convert('RGBA').resize((128, 128), Image.NEAREST).save(os.path.join(OUT, 'pack.png'), optimize=True)
    for name in ('mojangstudios.png', 'edition.png', 'pack.png'):
        print(name, os.path.getsize(os.path.join(OUT, name)), 'bytes')


if __name__ == '__main__':
    main()
