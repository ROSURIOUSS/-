"""Start the native Godot window, never a browser or web server."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def find_godot(explicit: str | None = None) -> str:
    if explicit:
        result = shutil.which(explicit)
        if result:
            return result
        raise ValueError(f"Не найден Godot: {explicit}")
    for name in ("godot", "godot4"):
        result = shutil.which(name)
        if result:
            return result
    # The Windows portable editor can simply be placed alongside this project.
    for path in sorted(ROOT.glob("Godot*.exe")):
        if not path.stem.endswith("_console"):
            return str(path)
    raise ValueError("Godot не найден. Открой godot/project.godot в редакторе и нажми F5, "
                     "либо укажи --godot полный_путь_к_Godot.exe.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Запуск настольной Биосферы")
    parser.add_argument("--godot", default=os.environ.get("GODOT_BIN"))
    args = parser.parse_args()
    try:
        executable = find_godot(args.godot)
        try:
            from .bundle_core import build_bundle
        except ImportError:
            from bundle_core import build_bundle
        build_bundle()
        env = os.environ.copy()
        # The launcher and worker use the same interpreter, including a venv.
        import sys
        env["BIOSPHERE_PYTHON"] = sys.executable
        subprocess.Popen([executable, "--path", str(ROOT / "godot")], env=env, cwd=ROOT)
        return 0
    except (ValueError, OSError) as exc:
        print(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
