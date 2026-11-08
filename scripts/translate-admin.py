#!/usr/bin/env python3
"""Generate the missing admin locale files with a local MIT-licensed model."""
from __future__ import annotations

import ast
from collections import Counter, defaultdict
import json
from pathlib import Path
import re

import torch
from transformers import M2M100ForConditionalGeneration, M2M100Tokenizer

ROOT = Path(__file__).resolve().parents[1] / "src" / "renderer" / "i18n"
MODEL = "facebook/m2m100_418M"
TARGETS = ("de", "fr", "it", "ja", "ko", "nl", "pl", "pt", "ru", "tr", "uk", "zh")
ENTRY = re.compile(r"""^  ([A-Za-z0-9_]+):\s*(?P<literal>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"),?\s*$""")
MARKER = re.compile(r"\{[A-Za-z][A-Za-z0-9_]*\}")
PROTECTED = re.compile(
    r"(\{[A-Za-z][A-Za-z0-9_]*\}|GPT-6 Luna|Venus Launcher|Venus IA|Venus Pass|"
    r"Venus Points|Mercado Pago|OpenAI|PayPal|Stripe|Supabase|APP_USR-|sk-)"
)


def read_entries(path: Path) -> list[tuple[str, str]]:
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = ENTRY.match(line)
        if match:
            entries.append((match.group(1), ast.literal_eval(match.group("literal"))))
    if len(entries) != len({key for key, _ in entries}):
        raise ValueError(f"Duplicate keys in {path}")
    return entries


def memory_for(lang: str) -> dict[str, str]:
    matches: dict[str, Counter[str]] = defaultdict(Counter)
    for english_path in (ROOT / "en").glob("*.js"):
        if english_path.name == "admin.js":
            continue
        translated_path = ROOT / lang / english_path.name
        if not translated_path.exists():
            continue
        english = dict(read_entries(english_path))
        translated = dict(read_entries(translated_path))
        for key, source in english.items():
            target = translated.get(key)
            if not target or target == source or sorted(MARKER.findall(source)) != sorted(MARKER.findall(target)):
                continue
            matches[source][target] += 1
    return {source: counts.most_common(1)[0][0] for source, counts in matches.items()}


def parts(value: str) -> list[str]:
    return PROTECTED.split(value)


def translatable(segment: str) -> str | None:
    core = segment.strip()
    return core if re.search(r"[A-Za-z]", core) else None


def render(value: str, direct: dict[str, str], translated: dict[str, str]) -> str:
    if value in direct:
        return direct[value]
    result = []
    for segment in parts(value):
        if PROTECTED.fullmatch(segment):
            result.append(segment)
            continue
        core = translatable(segment)
        if core is None:
            result.append(segment)
            continue
        start = len(segment) - len(segment.lstrip())
        end = len(segment) - len(segment.rstrip())
        result.append(segment[:start] + translated[core] + (segment[-end:] if end else ""))
    return "".join(result)


def generate() -> None:
    source = read_entries(ROOT / "en" / "admin.js")
    if len(source) != 721:
        raise ValueError(f"Expected 721 admin keys, found {len(source)}")
    torch.set_num_threads(4)
    tokenizer = M2M100Tokenizer.from_pretrained(MODEL)
    model = M2M100ForConditionalGeneration.from_pretrained(MODEL).eval()
    report = [
        "# Traducciones del panel de administración",
        "",
        "Se generaron desde los 721 textos ingleses con el modelo abierto "
        "[M2M100 418M](https://huggingface.co/facebook/m2m100_418M) (licencia MIT). "
        "Se reutilizaron traducciones existentes del launcher cuando coincidían.",
        "Las claves, variables entre llaves y nombres de producto se conservaron.",
        "Revisión lingüística por hablantes nativos recomendada antes de publicar una versión estable.",
        "",
        "| Idioma | Claves | Reutilizadas | Textos idénticos al inglés |",
        "|---|---:|---:|---:|",
    ]
    for lang in TARGETS:
        direct = memory_for(lang)
        todo = sorted({
            core for _, value in source if value not in direct
            for segment in parts(value) if not PROTECTED.fullmatch(segment)
            if (core := translatable(segment))
        }, key=len)
        tokenizer.src_lang = "en"
        translated: dict[str, str] = {}
        for offset in range(0, len(todo), 16):
            batch = todo[offset:offset + 16]
            encoded = tokenizer(batch, return_tensors="pt", padding=True, truncation=True, max_length=256)
            with torch.inference_mode():
                result = model.generate(
                    **encoded,
                    forced_bos_token_id=tokenizer.get_lang_id(lang),
                    max_new_tokens=160,
                    min_new_tokens=1,
                    num_beams=1,
                )
            values = tokenizer.batch_decode(result, skip_special_tokens=True)
            for english, target in zip(batch, values, strict=True):
                if not target.strip():
                    if lang == "ko" and english == "done":
                        target = "완료"
                    else:
                        raise ValueError(f"Empty translation for {lang}: {english!r}")
                translated[english] = target.strip()
            if offset % 160 == 0:
                print(f"{lang}: {min(offset + 16, len(todo))}/{len(todo)} segments", flush=True)
        output = []
        reused = 0
        identical = 0
        for key, value in source:
            target = render(value, direct, translated)
            if sorted(MARKER.findall(value)) != sorted(MARKER.findall(target)):
                raise ValueError(f"Marker mismatch: {lang}/{key}")
            if value in direct:
                reused += 1
            if target == value:
                identical += 1
            output.append(f"  {key}: {json.dumps(target, ensure_ascii=False)},")
        target_path = ROOT / lang / "admin.js"
        target_path.write_text(
            "// Generated from en/admin.js with M2M100; review before stable release.\n"
            + "export default {\n" + "\n".join(output) + "\n};\n",
            encoding="utf-8",
        )
        report.append(f"| {lang} | {len(output)} | {reused} | {identical} |")
        print(f"{lang}: {len(output)} keys, {reused} reused, {identical} identical", flush=True)
    (ROOT.parents[2] / "docs" / "administracion-traducciones.md").write_text(
        "\n".join(report) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    generate()
