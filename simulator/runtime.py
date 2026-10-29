"""Application core, driven by the native window. No network or web server."""
from __future__ import annotations

from . import autosave, persistence
from .sandbox import Sandbox
from .world import Config, World


class Simulation:
    def __init__(self):
        self.world = World(Config())
        self.paused = False
        self.speed = 1
        self.error: str | None = None
        self.sandbox = Sandbox()
        self.autosaves = {"directory": "", "records": [], "warnings": []}

    def state(self) -> dict:
        return {**self.world.snapshot(), "paused": self.paused,
                "speed": self.speed, "error": self.error, "sandbox": self.sandbox.state(), "autosaves": self.autosaves}

    def command(self, name: str, data: dict) -> str:
        if not isinstance(data, dict):
            raise ValueError("Ожидается объект параметров")
        if name == "world":
            world = World(Config.parse(data))
            self.world, self.paused, self.error = world, False, None
            self.sandbox.clear()
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
            self.sandbox.clear()
            return "Мир загружен: " + path
        elif name in ("autosave", "autosave_info", "recover"):
            allowed = {"directory", "slot", "generation"} if name == "recover" else {"directory"}
            if data.keys() - allowed:
                raise ValueError("Неизвестные параметры автосохранения")
            root = str(autosave.directory(data.get("directory")))
            if name == "autosave_info":
                self.autosaves = autosave.scan(root)
            elif name == "autosave":
                if self.error is not None:
                    raise ValueError("Автосохранение остановлено из-за ошибки расчёта; прежние копии сохранены")
                self.autosaves = autosave.save(self.world, self.paused, self.speed, root)
                return "Автокопия сохранена: день %.2f" % self.world.day
            else:
                if "slot" in data:
                    autosave.slot_path(autosave.directory(root), data["slot"])
                if "generation" in data:
                    persistence.integer(data["generation"], 1, autosave.MAX_GENERATION)
                world, speed, info = autosave.recover(root, data.get("slot"), data.get("generation"))
                self.world, self.paused, self.speed, self.error = world, True, speed, None
                self.autosaves = info
                self.sandbox.clear()
                return f"Автокопия восстановлена: день {world.day:.2f}. Мир на паузе"
        elif name == "brush":
            return self.sandbox.apply(self.world, data, self.paused, self.speed)
        elif name == "undo":
            if data:
                raise ValueError("У отмены нет параметров")
            world, speed = self.sandbox.undo()
            self.world, self.speed, self.paused, self.error = world, speed, True, None
            return f"Вмешательство отменено. Мир возвращён к дню {world.day:.2f} и поставлен на паузу"
        elif name in ("step", "single_step"):
            single = name == "single_step"
            if single and data:
                raise ValueError("У одиночного шага нет параметров")
            if single or not self.paused:
                try:
                    for _ in range(1 if single else self.speed):
                        self.world.step()
                except Exception as exc:
                    self.paused = True
                    self.error = f"Ошибка расчёта: {type(exc).__name__}: {exc}"
            if single:
                self.paused = True
        elif name != "state":
            raise ValueError("Неизвестная команда ядра")
        return ""
