"""Application core, driven by the native window. No network or web server."""
from __future__ import annotations

from . import persistence
from .world import Config, World


class Simulation:
    def __init__(self):
        self.world = World(Config())
        self.paused = False
        self.speed = 1
        self.error: str | None = None

    def state(self) -> dict:
        return {**self.world.snapshot(), "paused": self.paused,
                "speed": self.speed, "error": self.error}

    def command(self, name: str, data: dict) -> str:
        if not isinstance(data, dict):
            raise ValueError("Ожидается объект параметров")
        if name == "world":
            world = World(Config.parse(data))
            self.world, self.paused, self.error = world, False, None
        elif name == "control":
            if data.keys() - {"paused", "speed"}:
                raise ValueError("Неизвестная команда времени")
            if "paused" in data and type(data["paused"]) is not bool:
                raise ValueError("paused должен быть boolean")
            if "speed" in data and (type(data["speed"]) is not int or data["speed"] not in (1, 2, 5, 10)):
                raise ValueError("Скорость: 1, 2, 5 или 10")
            self.paused = data.get("paused", self.paused)
            self.speed = data.get("speed", self.speed)
        elif name in ("save", "load"):
            path = data.get("path")
            if not isinstance(path, str) or not path.strip() or len(path) > 4096:
                raise ValueError("Нужен путь к файлу сохранения")
            if name == "save":
                persistence.save(self.world, self.paused, self.speed, path)
                return "Мир сохранён: " + path
            world, paused, speed = persistence.load(path)
            self.world, self.paused, self.speed, self.error = world, paused, speed, None
            return "Мир загружен: " + path
        elif name == "step":
            if not self.paused:
                try:
                    for _ in range(self.speed):
                        self.world.step()
                except Exception as exc:
                    self.paused = True
                    self.error = f"Ошибка расчёта: {type(exc).__name__}: {exc}"
        elif name != "state":
            raise ValueError("Неизвестная команда ядра")
        return ""
