"""Export a native Godot application and assemble its private Python core.

Run on the target OS; exporting Godot alone does not package the Python worker.
With --bundle-python, PyInstaller produces a core that needs no installed Python.
Build tools/export templates must be installed separately. No downloads here.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from .launch import ROOT, find_godot
except ImportError:
    from launch import ROOT, find_godot


def main() -> int:
    parser = argparse.ArgumentParser(description="Сборка настольной Биосферы")
    parser.add_argument("--godot", default=os.environ.get("GODOT_BIN"))
    parser.add_argument("--bundle-python", action="store_true", help="Включить Python через установленный PyInstaller")
    args = parser.parse_args()
    if sys.platform not in ("win32", "linux"):
        print("Автоматическая сборка пока настроена для Windows и Linux.")
        return 1
    if args.bundle_python and importlib.util.find_spec("PyInstaller") is None:
        print("Установи версию PyInstaller с поддержкой своего Python: python -m pip install --upgrade pyinstaller")
        return 1
    try:
        godot = find_godot(args.godot)
        folder = ROOT / "build" / ("Biosphere-Windows" if sys.platform == "win32" else "Biosphere-Linux")
        folder.mkdir(parents=True, exist_ok=True)
        core = folder / "core"
        core.mkdir(exist_ok=True)
        preset = "Windows Desktop" if sys.platform == "win32" else "Linux Desktop"
        output = folder / ("Biosphere.exe" if sys.platform == "win32" else "Biosphere.x86_64")
        subprocess.run([godot, "--headless", "--path", str(ROOT / "godot"), "--export-release", preset, str(output)], check=True)
        binary = core / ("biosphere-core.exe" if sys.platform == "win32" else "biosphere-core")
        sources = core / "simulator"
        if args.bundle_python:
            subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                            "--name", "biosphere-core", "--paths", str(ROOT),
                            "--distpath", str(core), "--workpath", str(ROOT / "build" / "pyinstaller"),
                            "--specpath", str(ROOT / "build"), str(ROOT / "simulator" / "worker.py")], check=True)
            if sources.exists():
                shutil.rmtree(sources)
        else:
            # Avoid accidentally reusing a stale frozen core in a source-based build.
            binary.unlink(missing_ok=True)
            shutil.copytree(ROOT / "simulator", sources, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (folder / "START.txt").write_text(
            "Биосфера — настольная программа. Запусти Biosphere.\n"
            + ("Python включён в папку core; установка Python не нужна.\n" if args.bundle_python
               else "Нужен установленный Python 3.11+. Ядро запустится автоматически.\n")
            + "Папка core и файл .pck (если он есть) должны оставаться рядом с программой.\n"
              "Для продолжения мира используй кнопки Сохранить / Загрузить.\n", encoding="utf-8")
        print(f"Готово: {output}\nПередавай всю папку {folder.name}, не только исполняемый файл.")
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Сборка не выполнена: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
