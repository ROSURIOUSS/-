"""Validated god-game brushes. One undo checkpoint per mouse stroke, not per dab."""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass

from . import persistence
from .weather import initial_moisture
from .world import HEIGHT, MAX_POPULATION, WIDTH, World, wrapped_dx

TOOLS = {
    "plant": "Озеленение", "fertilize": "Плодородие", "dry": "Иссушение",
    "warm": "Нагрев", "cool": "Охлаждение", "uplift": "Поднять сушу",
    "lower": "Опустить сушу", "spawn_herbivore": "Заселить травоядных",
    "spawn_carnivore": "Заселить хищников", "heal": "Восстановление", "erase_life": "Убрать организмы", "rain": "Вызвать дождь",
}


def real(value, low, high, name):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not low <= value <= high or not math.isfinite(value)):
        raise ValueError(f"{name}: допустимо число от {low} до {high}")
    return float(value)


@dataclass(frozen=True, slots=True)
class Brush:
    kind: str
    x: float
    y: float
    radius: float
    strength: float
    count: int
    stroke: int

    @classmethod
    def parse(cls, data: dict):
        if not isinstance(data, dict) or data.keys() - {"kind", "x", "y", "radius", "strength", "count", "stroke"}:
            raise ValueError("Неизвестные параметры кисти")
        kind = data.get("kind")
        if not isinstance(kind, str) or kind not in TOOLS:
            raise ValueError("Неизвестная кисть")
        x = real(data.get("x"), 0, WIDTH, "Долгота") % WIDTH
        y = real(data.get("y"), 0, HEIGHT, "Широта")
        y = min(y, HEIGHT - 0.00001)
        radius = real(data.get("radius", 2.5), 0.75, 8, "Радиус")
        strength = real(data.get("strength", 0.6), 0.1, 1, "Сила")
        count, stroke = data.get("count", 5), data.get("stroke", 0)
        if type(count) is not int or not 1 <= count <= 30:
            raise ValueError("Количество: целое число от 1 до 30")
        if type(stroke) is not int or not 0 <= stroke <= 2**53:
            raise ValueError("Неверный номер мазка")
        return cls(kind, x, y, radius, strength, count, stroke)

    def distance(self, x: float, y: float) -> float:
        return math.hypot(wrapped_dx(x, self.x), y - self.y)

    def footprint(self) -> list[tuple[int, float]]:
        cells = []
        for y in range(max(0, math.floor(self.y - self.radius)), min(HEIGHT, math.ceil(self.y + self.radius))):
            for x in range(math.floor(self.x - self.radius), math.ceil(self.x + self.radius)):
                distance = self.distance(x + 0.5, y + 0.5)
                if distance <= self.radius:
                    weight = max(0.08, 1 - distance / self.radius)
                    cells.append((y * WIDTH + x % WIDTH, weight))
        return cells


class Sandbox:
    def __init__(self):
        self.clear()

    def clear(self):
        self.checkpoint: dict | None = None
        self.stroke_key: tuple | None = None
        self.dabs = 0

    def state(self) -> dict:
        return {"can_undo": self.checkpoint is not None,
                "undo_day": self.checkpoint["day"] if self.checkpoint else None,
                "dabs": self.dabs}

    def apply(self, world: World, data: dict, paused: bool, speed: int) -> str:
        brush = Brush.parse(data)
        cells = brush.footprint()
        land = [(tile, weight) for tile, weight in cells if world.land(tile)]
        changes: dict[str, dict[int, float]] = {}
        victims = []
        healing = []
        new_count = 0

        def adjust(field, tile, value, low=0.0, high=1.0):
            values = getattr(world, field)
            target = max(low, min(high, value))
            if target != values[tile]:
                changes.setdefault(field, {})[tile] = target

        if brush.kind in ("warm", "cool"):
            sign = 1 if brush.kind == "warm" else -1
            for tile, weight in cells:
                adjust("temperature_bias", tile, world.temperature_bias[tile] + sign * 12 * brush.strength * weight, -40, 40)
        elif brush.kind == "rain":
            for tile, weight in cells:
                adjust("rain_bias", tile, world.rain_bias[tile] + 0.7 * brush.strength * weight)
                if world.land(tile):
                    adjust("moisture", tile, world.moisture[tile] + 0.4 * brush.strength * weight)
        elif brush.kind in ("uplift", "lower"):
            sign = 1 if brush.kind == "uplift" else -1
            for tile, weight in cells:
                adjust("elevation", tile, world.elevation[tile] + sign * 0.08 * brush.strength * weight)
            future = changes.get("elevation", {})
            if not any(future.get(i, h) > world.config.sea_level for i, h in enumerate(world.elevation)):
                raise ValueError("Нельзя затопить последнюю сушу: оставь хотя бы один участок")
        elif brush.kind.startswith("spawn_"):
            if not land:
                raise ValueError("Заселять можно только сушу. Подними землю или выбери другой участок")
            new_count = min(brush.count, MAX_POPULATION - len(world.creatures))
            if new_count <= 0:
                raise ValueError(f"Достигнут предел: {MAX_POPULATION} организмов")
        elif brush.kind in ("heal", "erase_life"):
            victims = [c for c in world.creatures if brush.distance(c.x, c.y) <= brush.radius]
            if not victims:
                raise ValueError("В радиусе кисти нет организмов")
            if brush.kind == "heal":
                for c in victims:
                    weight = max(0.08, 1 - brush.distance(c.x, c.y) / brush.radius) * brush.strength
                    health = min(100.0, c.health + 35 * weight)
                    energy = min(185.0, c.energy + 55 * weight)
                    if health != c.health or energy != c.energy:
                        healing.append((c, health, energy))
                victims = []
        else:
            if not land:
                raise ValueError("Эта кисть действует на суше, не в океане")
            for tile, weight in land:
                amount = brush.strength * weight
                if brush.kind == "plant":
                    adjust("food", tile, world.food[tile] + 0.5 * amount)
                    adjust("leaves", tile, world.leaves[tile] + 0.35 * amount)
                    adjust("canopy", tile, world.canopy[tile] + 0.4 * amount)
                    adjust("soil", tile, world.soil[tile] + 0.08 * amount)
                elif brush.kind == "fertilize":
                    adjust("soil", tile, world.soil[tile] + 0.3 * amount)
                    adjust("food", tile, world.food[tile] + 0.15 * amount)
                elif brush.kind == "dry":
                    adjust("moisture", tile, world.moisture[tile] - 0.5 * amount)
                    adjust("food", tile, world.food[tile] - 0.65 * amount)
                    adjust("leaves", tile, world.leaves[tile] - 0.45 * amount)
                    adjust("seeds", tile, world.seeds[tile] - 0.2 * amount)
                    adjust("canopy", tile, world.canopy[tile] - 0.4 * amount)
                    adjust("soil", tile, world.soil[tile] - 0.12 * amount)
        if not (changes or victims or healing or new_count):
            raise ValueError("Нет изменений: значения в области уже достигли предела")

        key = (brush.stroke, brush.kind, brush.radius, brush.strength, brush.count)
        # An omitted stroke ID means a distinct, atomic API action each time.
        fresh_stroke = self.checkpoint is None or brush.stroke == 0 or key != self.stroke_key
        checkpoint = copy.deepcopy(persistence.pack(world, paused, speed)) if fresh_stroke else None
        if checkpoint is not None:
            version, internal, gaussian = checkpoint["rng"]
            checkpoint["rng"] = [version, list(internal), gaussian]
        old_rng, old_next_id = world.rng.getstate(), world.next_id
        newcomers = []
        try:
            for _ in range(new_count):
                tile, _weight = world.rng.choice(land)
                x, y = tile % WIDTH + world.rng.uniform(0.1, 0.9), tile // WIDTH + world.rng.uniform(0.1, 0.9)
                if brush.distance(x, y) > brush.radius:
                    x, y = tile % WIDTH + 0.5, tile // WIDTH + 0.5
                newcomers.append(world.new_creature(x, y, diet=brush.kind.removeprefix("spawn_")))
        except Exception:
            world.rng.setstate(old_rng)
            world.next_id = old_next_id
            raise
        for field, values in changes.items():
            target = getattr(world, field)
            for tile, value in values.items():
                target[tile] = value
        if "elevation" in changes:
            previous_land = set(world.land_tiles)
            for tile in changes["elevation"]:
                if not world.land(tile):
                    world.moisture[tile] = 1.0
                    for field in ("food", "meat", "soil", "canopy", "leaves", "seeds"):
                        getattr(world, field)[tile] = 0.0
                elif tile not in previous_land:
                    world.moisture[tile] = initial_moisture(world.config, [world.elevation[tile]])[0]
                    world.soil[tile], world.food[tile], world.canopy[tile] = 0.1 + world.config.rainfall * 0.2, 0.1, 0.0
            world.land_tiles = [i for i in range(WIDTH * HEIGHT) if world.land(i)]
            victims = [c for c in world.creatures if not world.land(world.tile(c.x, c.y))]
        if victims:
            removed = {c.id for c in victims}
            for c in victims:
                c.health = 0.0
            world.creatures = [c for c in world.creatures if c.id not in removed]
            world.deaths += len(removed)
            world.death_causes["intervention"] += len(removed)
        for c, health, energy in healing:
            c.health, c.energy = health, energy
        if "rain_bias" in changes:
            world.refresh_weather()
        world.creatures.extend(newcomers)
        world.introduced += len(newcomers)
        if fresh_stroke:
            self.checkpoint, self.stroke_key = checkpoint, key
            world.events.append(f"День {int(world.day)}: песочница — {TOOLS[brush.kind].lower()}.")
            world.events = world.events[-20:]
        world.refresh_history()
        self.dabs += 1
        affected = len(set().union(*(values.keys() for values in changes.values()))) if changes else 0
        return f"{TOOLS[brush.kind]}: участков {affected}, добавлено {len(newcomers)}, убрано {len(victims)}, восстановлено {len(healing)}"

    def undo(self) -> tuple[World, int]:
        if self.checkpoint is None:
            raise ValueError("Нет вмешательства для отмены")
        world, _paused, speed = persistence.unpack(copy.deepcopy(self.checkpoint))
        self.clear()
        return world, speed
