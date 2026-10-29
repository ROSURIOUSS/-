"""Private stdin/stdout JSON-lines worker owned by the Godot process.

Can be launched by absolute script path or packaged with PyInstaller.
stdout is exclusively protocol traffic. Closing stdin terminates the worker.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simulator.runtime import Simulation

PROTOCOL_VERSION = 11
MAX_REQUEST_BYTES = 16384


def emit(packet: dict) -> None:
    text = json.dumps(packet, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    sys.stdout.buffer.write(text.encode("ascii") + b"\n")
    sys.stdout.buffer.flush()


def serve() -> None:
    simulation = Simulation()
    emit({"type": "ready", "protocol": PROTOCOL_VERSION})
    while True:
        line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
            emit({"id": None, "ok": False, "error": "Повреждённый или слишком длинный запрос"})
            return
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Запрос должен быть объектом")
            request_id = request.get("id")
            if type(request_id) is not int or not 0 <= request_id <= 2**53:
                request_id = None
                raise ValueError("Неверный ID запроса")
            name = request.get("command")
            if not isinstance(name, str):
                raise ValueError("Не указана команда")
            if name == "quit":
                emit({"id": request_id, "ok": True})
                return
            message = simulation.command(name, request.get("data", {}))
            emit({"id": request_id, "ok": True, "state": simulation.state(), "message": message})
        except (ValueError, TypeError, UnicodeError, OSError, RecursionError) as exc:
            emit({"id": request_id, "ok": False, "error": str(exc)})


def main() -> None:
    if sys.version_info < (3, 11):
        raise SystemExit("Для Биосферы требуется Python 3.11 или новее")
    try:
        serve()
    except (BrokenPipeError, ConnectionResetError):
        # Avoid a second BrokenPipeError during Python's final stdout flush.
        descriptor = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(descriptor, sys.stdout.fileno())
        finally:
            os.close(descriptor)


if __name__ == "__main__":
    main()
