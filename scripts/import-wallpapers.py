"""Import user-supplied wallpapers without extracting or modifying the ZIP.

Requires Pillow. Run from any directory:
    python scripts/import-wallpapers.py path/to/67-png.zip

Full-size WebP images preserve their aspect ratio and fit within 2560 x 1440.
Small, cropped previews keep the appearance picker inexpensive to load.
Invalid files and duplicates are recorded in the generated manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import warnings
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src/renderer/assets/wallpapers"
CATALOG = ROOT / "src/renderer/js/wallpapers.js"
EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# Labels refer to the original archive's numbered filenames, not output IDs.
NAMES = {
    1: "Luna turquesa y dragón",
    2: "Miku",
    4: "Atardecer sobre la ciudad",
    5: "Ciudad de neón",
    6: "Monte Fuji",
    7: "Valle de cerezos",
    8: "Bosque de niebla",
    9: "Paisaje lunar",
    10: "Campo bajo las nubes",
    11: "Lago y cerezos",
    12: "Miles Morales",
    13: "Horizonte rojo",
    14: "Venom",
    15: "Spider-Man en la ciudad",
    16: "Wolverine",
    17: "Spider-Man nocturno",
    18: "Deportivo junto al mar",
    19: "Spider-Man bajo la lluvia",
    20: "ROG carmesí",
    21: "Spider-Man y luces",
    22: "Spider-Man rojo",
    23: "Spider-Man en acción",
    24: "Spider-Man en las sombras",
    25: "Mármol azul",
    26: "Ondas de seda",
    27: "Ola estrellada",
    28: "Pradera en flor",
    29: "Camino de otoño",
    30: "Sukuna carmesí",
    31: "Pikachu en el bosque",
    32: "Luffy Gear 5",
    33: "Gojo ilustrado",
    34: "Luna de sombras",
    35: "Mirada carmesí",
    37: "Ruta al atardecer",
    38: "Mirada azul",
    39: "Noche de neón",
    40: "Horizonte costero",
    41: "Sukuna",
    42: "Kakashi",
    43: "Goku azul",
    44: "Mirada violeta",
    45: "Kaneki",
    46: "Goku y Shenron",
    47: "Kame House",
    49: "Pikachu en las termas",
    50: "Mar de nubes",
    52: "Goku al atardecer",
    53: "Sombra rosa",
}


def natural_key(value: str) -> list:
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", value)]


def import_wallpapers(archive_path: Path) -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    entries = []
    sources = []
    rejected = []
    duplicates = []
    seen = {}

    with ZipFile(archive_path) as archive:
        images = sorted(
            (entry for entry in archive.infolist()
             if not entry.is_dir() and Path(entry.filename).suffix.lower() in EXTENSIONS),
            key=lambda entry: natural_key(entry.filename),
        )
        for entry in images:
            try:
                # Read in memory; archive filenames never become filesystem paths.
                if entry.file_size > 100 * 1024 * 1024:
                    raise ValueError("Image exceeds the 100 MiB import limit")
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(archive.read(entry))) as original:
                        original.load()  # Reject incomplete images instead of showing broken previews.
                        picture = ImageOps.exif_transpose(original).convert("RGB")
                digest = hashlib.sha256(
                    f"{picture.width}x{picture.height}:".encode() + picture.tobytes()
                ).hexdigest()
                if digest in seen:
                    duplicates.append({"source": entry.filename, "sameAs": seen[digest]})
                    continue

                number = len(entries) + 1
                wallpaper_id = f"wallpaper-{number:02d}"
                match = re.search(r"\((\d+)\)\.[^.]+$", entry.filename)
                label = NAMES.get(int(match[1])) if match else None
                full_path = ASSETS / f"{wallpaper_id}.webp"
                thumb_path = ASSETS / f"{wallpaper_id}-thumb.webp"
                original_size = list(picture.size)
                picture.thumbnail((2560, 1440), Image.Resampling.LANCZOS)
                picture.save(full_path, "WEBP", quality=88, method=6)
                thumbnail = ImageOps.fit(picture, (320, 180), Image.Resampling.LANCZOS)
                thumbnail.save(thumb_path, "WEBP", quality=78, method=6)
                seen[digest] = wallpaper_id
                entries.append({
                    "id": wallpaper_id,
                    "name": label or f"Fondo {number:02d}",
                    "src": f"assets/wallpapers/{full_path.name}",
                    "thumb": f"assets/wallpapers/{thumb_path.name}",
                })
                sources.append({
                    "id": wallpaper_id,
                    "source": entry.filename,
                    "pixelSha256": digest,
                    "originalSize": original_size,
                    "size": list(picture.size),
                    "imageBytes": full_path.stat().st_size,
                    "thumbnailBytes": thumb_path.stat().st_size,
                })
                print(f"Imported {wallpaper_id}: {entries[-1]['name']}", flush=True)
            except (OSError, ValueError, Image.DecompressionBombWarning,
                    Image.DecompressionBombError) as error:
                rejected.append({"source": entry.filename, "reason": str(error)})
                print(f"Skipped {entry.filename}: {error}", flush=True)

    if not entries:
        raise SystemExit("No valid images found; the catalog was not replaced.")

    CATALOG.write_text(
        "// Generated by scripts/import-wallpapers.py from the user's wallpaper archive.\n"
        "// Paths are relative to renderer/index.html and work inside packaged apps.\n"
        "export const WALLPAPERS = " + json.dumps(entries, ensure_ascii=False, indent=2)
        + ";\n\n"
        "const WALLPAPERS_BY_ID = new Map(WALLPAPERS.map(wallpaper => [wallpaper.id, wallpaper]));\n\n"
        "export function getWallpaper(id) {\n"
        "  return WALLPAPERS_BY_ID.get(id) || null;\n"
        "}\n",
        encoding="utf-8",
    )
    manifest = {
        "archive": archive_path.name,
        "imageCount": len(images),
        "importedCount": len(entries),
        "images": sources,
        "duplicates": duplicates,
        "rejected": rejected,
    }
    (ASSETS / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    total = sum(source["imageBytes"] + source["thumbnailBytes"] for source in sources)
    print(f"Done: {len(entries)} wallpapers, {len(duplicates)} duplicates, "
          f"{len(rejected)} invalid; {total / (1024 * 1024):.2f} MiB total.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    import_wallpapers(args.archive.resolve(strict=True))
