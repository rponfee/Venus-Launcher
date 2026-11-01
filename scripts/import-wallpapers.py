"""Agrega fondos a la galería sin repetir los que ya están: la del launcher y la de la página web.

Los originales viven en web/fondos/ (con manifest.json): de ahí sale la página web/fondos.html y una copia para la
galería de Apariencia del launcher (src/renderer/assets/wallpapers/ y src/renderer/js/wallpapers.js). Cada vez que
corre, las dos quedan iguales.

Uso (desde cualquier carpeta; necesita Pillow):
    python scripts/import-wallpapers.py <carpeta o .zip> [<carpeta o .zip> ...]
    python scripts/import-wallpapers.py --catalog     (solo rearma las dos listas y copia los fondos al launcher)

- Imágenes (.png .jpg .jpeg .webp): WebP de hasta 2560 x 1440 y una miniatura de 320 x 180.
- Videos (.mp4 .webm .mov .mkv): fondos animados en H.264 de hasta 1920 x 1080 y 30 cuadros por segundo, sin
  audio, con una miniatura sacada del video. Usa ffmpeg: el de la variable FFMPEG, el de imageio-ffmpeg
  (pip install imageio-ffmpeg) o el del PATH.
- Repetidos: cada fondo guarda en manifest.json un hash perceptual (dHash 16 x 16) de la imagen o de cuatro cuadros
  del video. Un archivo nuevo parecido a uno que ya está (o a otro nuevo) se saltea y queda anotado como repetido,
  aunque cambien el tamaño, el formato o el recorte.
- Los fondos que ya están no se tocan: sus ids (wallpaper-NN y live-NN) se mantienen (los links fondos.html#id siguen andando).
- lista.js (lo que lee fondos.html) pone primero los animados y después las imágenes.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "web/fondos"
MANIFEST = ASSETS / "manifest.json"
CATALOG = ASSETS / "lista.js"
APP_ASSETS = ROOT / "src/renderer/assets/wallpapers"
APP_CATALOG = ROOT / "src/renderer/js/wallpapers.js"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv"}
SAME = 10  # bits distintos (de 256) hasta los que dos fondos se consideran el mismo

# Nombres para mostrar, por el nombre del archivo sin tamaño ni sitio (ver slug()).
NAMES = {
    "aston-martin-v8-auto-deportivo-clasico-en-juego-007-first-light": "Aston Martin V8",
    "auto-arte-digital-inspirado-en-ford-mustang-shelby-gt500": "Mustang Shelby GT500",
    "cyberpunk-2077": "Cyberpunk 2077",
    "denji-de-chainsaw-man": "Denji",
    "dodge-challenger-gasolinera-iluminacion-neon": "Dodge Challenger de neón",
    "el-hombre-arana-de-cabeza": "Spider-Man de cabeza",
    "el-hombre-arana-negro": "Spider-Man negro",
    "escudo-capitan-america": "Escudo del Capitán América",
    "goku-de-dragon-ball": "Goku",
    "goku-fondo-rojo": "Goku en rojo",
    "goku-super-saiyan": "Goku Super Saiyan",
    "goku-ultra-instinct-dragon-ball-super": "Goku Ultra Instinto",
    "goku-vs-vegeta-ilustracion": "Goku contra Vegeta",
    "iron-man-render-3d": "Iron Man 3D",
    "iron-man-volando": "Iron Man volando",
    "kirby-fanart": "Kirby",
    "lionel-messi-con-trofeo-copa-mundial-fifa": "Messi campeón del mundo",
    "luffy-gear-5-nika-dios-del-sol": "Luffy Nika",
    "mar-nocturno-con-bioluminiscencia-y-cielo-estrellado": "Mar bioluminiscente",
    "marvels-el-hombre-arana-2-venom-symbiote-logo": "Simbionte de Spider-Man 2",
    "mercedes-vision-eqxx": "Mercedes Vision EQXX",
    "michael-jordan-logo": "Logo de Jordan",
    "miles-morales-spider-man-3d": "Miles Morales 3D",
    "minimalista-miles-morales": "Miles Morales minimalista",
    "moon-knight": "Moon Knight",
    "porsche-911-gt3-rs-rojo": "Porsche 911 GT3 RS rojo",
    "porsche-911-gt3-rs": "Porsche 911 GT3 RS",
    "porsche-911-gt3rs-gran-turismo": "Porsche GT3 RS Gran Turismo",
    "rick-y-morty": "Rick y Morty",
    "rostro-de-venom": "Rostro de Venom",
    "son-goku-nino-de-dragon-ball-z": "Goku niño",
    "spider-man-arte-digital-realista": "Spider-Man realista",
    "vehiculo-deportivo-inspirado-en-toyota-gr-supra-widebody": "Toyota GR Supra",
    "venom-ilustracion-minimalista": "Venom minimalista",
    # Animados
    "aaxcpc6n7y": "Espadachina en blanco y negro",
    "aoi-todo-itadori-yuji-mahito": "Todo, Itadori y Mahito",
    "batman-el-caballero-de-la-noche-espera-animado-el-fondo-de-p": "Batman en la noche",
    "ene-project": "Bufanda roja",
    "hatsune-miku-sky": "Miku en el cielo",
    "lego-skeleton-chrome-figure-live-wallpaper": "Esqueleto LEGO cromado",
    "ling-street-punk": "Pelea en la calle de neón",
    "lofi-cat-sleeping": "Gato lofi durmiendo",
    "luffys-mighty-gear-5": "Gear 5 de Luffy",
    "nissan-gt-r-performance": "Nissan GT-R",
    "samurai-anime-boy-koi-in-sword-enhanced": "Samurái y carpas koi",
    "silver-surfer-space-stars-enhanced": "Silver Surfer",
    "spider-man-symbiote-suit-enhanced": "Spider-Man simbionte",
    "vid-20251014-enhanced": "Rueda deportiva",
    "wallpaper": "Chica lobo con espada",
    "yuta-okkotsu-curse-spirit": "Yuta y Rika",
}


def slug(filename: str) -> str:
    """'goku-fondo-rojo_3840x2160_xtrafondos.com (1).jpg' -> 'goku-fondo-rojo'."""
    stem = Path(filename).stem.lower()
    stem = re.sub(r"\s*\(\d+\)$", "", stem)
    stem = re.sub(r"_\d+x\d+_xtrafondos\.com$", "", stem)
    return re.sub(r"-wallsflow-com$", "", stem)


def natural_key(value: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def dhash(picture: Image.Image, size: int = 16) -> str:
    gray = picture.convert("L").resize((size + 1, size), Image.Resampling.LANCZOS)
    px = gray.tobytes()
    bits = 0
    for y in range(size):
        row = y * (size + 1)
        for x in range(size):
            bits = (bits << 1) | (px[row + x] > px[row + x + 1])
    return f"{bits:064x}"


def distance(a: list[str], b: list[str]) -> int:
    return min(bin(int(x, 16) ^ int(y, 16)).count("1") for x in a for y in b)


def find_ffmpeg() -> str:
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    found = shutil.which("ffmpeg")
    if not found:
        sys.exit("Para importar videos hace falta ffmpeg: pip install imageio-ffmpeg o poné ffmpeg en el PATH.")
    return found


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, check=True)


def video_duration(ffmpeg: str, path: Path) -> float:
    # ffmpeg sin salida termina con error, pero antes imprime la duración.
    info = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True).stderr.decode("utf-8", "replace")
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", info)
    if not m:
        raise ValueError("No se pudo leer la duración del video")
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])


def video_frame(ffmpeg: str, path: Path, at: float) -> Image.Image:
    out = run([ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{at:.2f}", "-i", str(path),
               "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]).stdout
    picture = Image.open(io.BytesIO(out))
    picture.load()
    return picture.convert("RGB")


def load_manifest() -> dict:
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
        data.setdefault("wallpapers", data.pop("images", []))
    else:
        data = {"wallpapers": []}
    data.setdefault("duplicates", [])
    data.setdefault("rejected", [])
    for item in data["wallpapers"]:
        item.setdefault("kind", "image")
        if "dhash" not in item:  # fondos importados antes de comparar por parecido
            with Image.open(ASSETS / f"{item['id']}.webp") as picture:
                item["dhash"] = [dhash(picture)]
    return data


def next_id(data: dict, prefix: str) -> str:
    used = [int(m[1]) for item in data["wallpapers"] if (m := re.fullmatch(rf"{prefix}-(\d+)", item["id"]))]
    return f"{prefix}-{max(used, default=0) + 1:02d}"


def add_image(data: dict, source: str, path: Path) -> dict | None:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path) as original:
            original.load()  # una imagen incompleta se rechaza en vez de verse rota
            picture = ImageOps.exif_transpose(original).convert("RGB")
    hashes = [dhash(picture)]
    if (same := similar(data, hashes)):
        data["duplicates"].append({"source": source, "sameAs": same})
        return None
    wallpaper_id = next_id(data, "wallpaper")
    full_path = ASSETS / f"{wallpaper_id}.webp"
    thumb_path = ASSETS / f"{wallpaper_id}-thumb.webp"
    original_size = list(picture.size)
    picture.thumbnail((2560, 1440), Image.Resampling.LANCZOS)
    picture.save(full_path, "WEBP", quality=88, method=6)
    ImageOps.fit(picture, (320, 180), Image.Resampling.LANCZOS).save(thumb_path, "WEBP", quality=78, method=6)
    return {"id": wallpaper_id, "kind": "image", "name": NAMES.get(slug(source)), "source": source,
            "dhash": hashes, "originalSize": original_size, "size": list(picture.size),
            "imageBytes": full_path.stat().st_size, "thumbnailBytes": thumb_path.stat().st_size}


def add_video(data: dict, source: str, path: Path, ffmpeg: str) -> dict | None:
    duration = video_duration(ffmpeg, path)
    frames = [video_frame(ffmpeg, path, duration * f) for f in (0.0, 0.25, 0.5, 0.75)]
    hashes = [dhash(frame) for frame in frames]
    if (same := similar(data, hashes)):
        data["duplicates"].append({"source": source, "sameAs": same})
        return None
    wallpaper_id = next_id(data, "live")
    video_path = ASSETS / f"{wallpaper_id}.mp4"
    thumb_path = ASSETS / f"{wallpaper_id}-thumb.webp"
    # Un fondo detrás de la interfaz no necesita 4K ni 60 cuadros: 1080p a 30 cuadros pesa 10 veces menos.
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(path), "-an", "-map_metadata", "-1",
         "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:flags=lanczos,"
                "scale=trunc(iw/2)*2:trunc(ih/2)*2",
         "-fpsmax", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p",
         "-profile:v", "high", "-movflags", "+faststart", str(video_path)])
    ImageOps.fit(frames[1], (320, 180), Image.Resampling.LANCZOS).save(thumb_path, "WEBP", quality=78, method=6)
    return {"id": wallpaper_id, "kind": "video", "name": NAMES.get(slug(source)), "source": source,
            "dhash": hashes, "originalSize": list(frames[0].size), "duration": round(duration, 1),
            "videoBytes": video_path.stat().st_size, "thumbnailBytes": thumb_path.stat().st_size}


def similar(data: dict, hashes: list[str]) -> str | None:
    for item in data["wallpapers"]:
        if distance(hashes, item["dhash"]) <= SAME:
            return item["id"]
    return None


def sources(arg: str, tmp: Path):
    """(nombre original, ruta) de cada imagen o video de una carpeta o un .zip."""
    root = Path(arg)
    exts = IMAGE_EXT | VIDEO_EXT
    if root.is_dir():
        for path in sorted(root.rglob("*"), key=lambda p: natural_key(str(p))):
            if path.is_file() and path.suffix.lower() in exts:
                yield path.relative_to(root).as_posix(), path
        return
    with ZipFile(root) as archive:
        entries = sorted((e for e in archive.infolist() if not e.is_dir() and Path(e.filename).suffix.lower() in exts),
                         key=lambda e: natural_key(e.filename))
        for n, entry in enumerate(entries):
            # El nombre del zip nunca se usa como ruta: se extrae a un archivo temporal con nombre propio.
            path = tmp / f"{n}{Path(entry.filename).suffix.lower()}"
            with archive.open(entry) as src, open(path, "wb") as dst:
                shutil.copyfileobj(src, dst)
            yield entry.filename, path
            path.unlink()


def fit(size: list[int], box: tuple[int, int]) -> list[int]:
    k = min(1, box[0] / size[0], box[1] / size[1])
    return [round(size[0] * k / 2) * 2, round(size[1] * k / 2) * 2]


def write_catalog(data: dict) -> None:
    ordered = ([i for i in data["wallpapers"] if i["kind"] == "video"]
               + [i for i in data["wallpapers"] if i["kind"] == "image"])
    catalog = []
    for item in ordered:
        video = item["kind"] == "video"
        name = item.get("name") or f"Fondo {item['id'].split('-')[-1]}"
        file = f"{item['id']}.{'mp4' if video else 'webp'}"
        # Lo que mide el archivo convertido: los videos quedaron en 1080p como máximo.
        width, height = fit(item.get("originalSize") or [1920, 1080], (1920, 1080)) if video else item["size"]
        # "Venus - Miku en el cielo.mp4", sin caracteres que Windows no acepta en un nombre de archivo
        safe = re.sub(r'[<>:"/\\|?*]+', "", name).strip()
        entry = {"id": item["id"], "name": name, "video": video, "file": f"fondos/{file}",
                 "thumb": f"fondos/{item['id']}-thumb.webp", "download": f"Venus - {safe}.{file.rsplit('.', 1)[1]}",
                 "bytes": (ASSETS / file).stat().st_size, "width": width, "height": height}
        if video and item.get("duration"):
            entry["duration"] = item["duration"]
        catalog.append(entry)
    # Un .js (no un .json) para que fondos.html también funcione abriéndola con doble clic (file://).
    CATALOG.write_text(
        "// Generado por scripts/import-wallpapers.py: no editar a mano (los datos están en manifest.json).\n"
        f"window.FONDOS = {json.dumps(catalog, ensure_ascii=False, indent=1)};\n",
        encoding="utf-8", newline="\n")


def write_app(data: dict) -> None:
    """La misma galería adentro del launcher (Apariencia -> Fondo -> Galería): copia los archivos y arma wallpapers.js."""
    APP_ASSETS.mkdir(parents=True, exist_ok=True)
    ordered = ([i for i in data["wallpapers"] if i["kind"] == "video"]
               + [i for i in data["wallpapers"] if i["kind"] == "image"])
    keep = {"manifest.json"}
    catalog = []
    for item in ordered:
        video = item["kind"] == "video"
        files = (f"{item['id']}.{'mp4' if video else 'webp'}", f"{item['id']}-thumb.webp")
        for name in files:
            src, dst = ASSETS / name, APP_ASSETS / name
            if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                shutil.copy2(src, dst)
            keep.add(name)
        entry = {"id": item["id"], "name": item.get("name") or f"Fondo {item['id'].split('-')[-1]}",
                 "src": f"assets/wallpapers/{files[0]}", "thumb": f"assets/wallpapers/{files[1]}"}
        if video:
            entry["video"] = True
        catalog.append(entry)
    for old in APP_ASSETS.iterdir():
        if old.name not in keep:
            old.unlink()
    shutil.copy2(MANIFEST, APP_ASSETS / "manifest.json")
    APP_CATALOG.write_text(
        "// Generado por scripts/import-wallpapers.py (no editar a mano: los datos están en web/fondos/manifest.json).\n"
        "// Las rutas son relativas a renderer/index.html y funcionan dentro del launcher empaquetado.\n"
        "// Los fondos con video: true son animados (MP4); van primero en la galería.\n"
        f"export const WALLPAPERS = {json.dumps(catalog, ensure_ascii=False, indent=2)};\n\n"
        "const WALLPAPERS_BY_ID = new Map(WALLPAPERS.map(wallpaper => [wallpaper.id, wallpaper]));\n\n"
        "export function getWallpaper(id) {\n"
        "  return WALLPAPERS_BY_ID.get(id) || null;\n"
        "}\n",
        encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("inputs", nargs="*", help="carpetas o .zip con imágenes y videos")
    parser.add_argument("--catalog", action="store_true", help="solo rearmar las listas y copiar los fondos al launcher")
    args = parser.parse_args()
    if not args.inputs and not args.catalog:
        parser.error("indicá al menos una carpeta o .zip")

    ASSETS.mkdir(parents=True, exist_ok=True)
    data = load_manifest()
    ffmpeg = None
    with tempfile.TemporaryDirectory() as tmp:
        for arg in args.inputs:
            for source, path in sources(arg, Path(tmp)):
                try:
                    if path.suffix.lower() in VIDEO_EXT:
                        ffmpeg = ffmpeg or find_ffmpeg()
                        item = add_video(data, source, path, ffmpeg)
                    else:
                        item = add_image(data, source, path)
                except (OSError, ValueError, subprocess.CalledProcessError, Image.DecompressionBombWarning,
                        Image.DecompressionBombError) as error:
                    data["rejected"].append({"source": source, "reason": str(error)})
                    print(f"Rechazado {source}: {error}", flush=True)
                    continue
                if item is None:
                    print(f"Repetido  {source} (igual a {data['duplicates'][-1]['sameAs']})", flush=True)
                    continue
                data["wallpapers"].append(item)
                print(f"Agregado  {item['id']}: {item['name'] or source}", flush=True)
                MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    write_catalog(data)
    write_app(data)
    kinds = [i["kind"] for i in data["wallpapers"]]
    print(f"Galería: {kinds.count('video')} animados y {kinds.count('image')} imágenes. "
          f"Repetidos salteados: {len(data['duplicates'])}. Rechazados: {len(data['rejected'])}.")


if __name__ == "__main__":
    main()
