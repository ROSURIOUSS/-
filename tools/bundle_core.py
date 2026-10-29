"""Build a tiny reproducible source bundle so importing godot/ alone works."""
from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BUNDLE = ROOT / "godot" / "python_core.zip"


def build_bundle(destination: Path = DEFAULT_BUNDLE) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in sorted((ROOT / "simulator").glob("*.py")):
            entry = zipfile.ZipInfo("simulator/" + source.name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, source.read_bytes())
    return destination


def main():
    parser = argparse.ArgumentParser(description="Обновить встроенное Python-ядро Godot")
    parser.add_argument("--output", type=Path, default=DEFAULT_BUNDLE)
    args = parser.parse_args()
    print(build_bundle(args.output))


if __name__ == "__main__":
    main()
