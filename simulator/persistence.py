"""Versioned, validated JSON saves. Never deserialize executable Python objects."""
from __future__ import annotations

import copy
import json
import math
import os
import random
import tempfile
from dataclasses import asdict, fields
from pathlib import Path

from .world import Config, Creature, DIETS, HEIGHT, HIDDEN, MAX_POPULATION, WEIGHTS, WIDTH, World

MAX_SAVE_BYTES = 16 * 1024 * 1024


def number(value, low, high):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not low <= value <= high or not math.isfinite(value)):
        raise ValueError("Повреждённое сохранение: недопустимое число")
    return value


def integer(value, low, high):
    if type(value) is not int:
        raise ValueError("Повреждённое сохранение: нужно целое число")
    return number(value, low, high)


def array(value, length):
    if not isinstance(value, list) or len(value) != length:
        raise ValueError("Повреждённое сохранение: неверный размер массива")
    return value


def pack(world: World, paused: bool, speed: int) -> dict:
    return {"format": 2, "config": asdict(world.config), "day": world.day,
            "births": world.births, "deaths": world.deaths, "next_id": world.next_id,
            "death_causes": world.death_causes,
            "elevation": world.elevation, "food": world.food, "meat": world.meat,
            "creatures": [asdict(c) for c in world.creatures],
            "rng": world.rng.getstate(), "history": world.history, "events": world.events,
            "paused": paused, "speed": speed}


def migrate_v1(data: dict) -> dict:
    """Expand 12→8→4 genomes without inventing learned recurrent connections."""
    upgraded = copy.deepcopy(data)
    upgraded["format"] = 2
    upgraded["config"]["predator_ratio"] = 0.0
    upgraded["meat"] = [0.0] * (WIDTH * HEIGHT)
    upgraded["death_causes"] = {"starvation": 0, "age": 0, "predation": 0, "legacy": upgraded["deaths"]}
    records = upgraded["creatures"]
    if not isinstance(records, list) or len(records) > MAX_POPULATION:
        raise ValueError("Неверная популяция в старом сохранении")
    for record in records:
        old = array(record["brain"], 140)
        for weight in old:
            number(weight, -100, 100)
        brain = []
        for neuron in range(HIDDEN):
            offset = neuron * 13
            brain.extend(old[offset:offset + 12] + [0.0] * (4 + HIDDEN) + [old[offset + 12]])
        brain.extend(old[104:])
        record.update(brain=brain, memory=[0.0] * HIDDEN, diet="herbivore",
                      speed=1.0, size=1.0, vision=7.0, health=100.0, kills=0)
    for sample in upgraded["history"]:
        sample.update(herbivores=sample["population"], carnivores=0)
    upgraded["events"] = (upgraded["events"] + ["Сохранение v1 обновлено: прежние геномы сохранены, новые связи обнулены."])[-20:]
    return upgraded


def unpack(data: dict) -> tuple[World, bool, int]:
    try:
        if not isinstance(data, dict) or type(data.get("format")) is not int or data["format"] not in (1, 2):
            raise ValueError("Неизвестный формат сохранения")
        if data["format"] == 1:
            data = migrate_v1(data)
        if not isinstance(data["config"], dict) or data["config"].keys() != asdict(Config()).keys():
            raise ValueError("Неполные параметры мира")
        config = Config.parse(data["config"])
        world = World(config)
        world.day = float(number(data["day"], 0, 10**12))
        world.births = integer(data["births"], 0, 10**12)
        world.deaths = integer(data["deaths"], 0, 10**12)
        world.next_id = integer(data["next_id"], 1, 10**12)
        causes = data["death_causes"]
        if not isinstance(causes, dict) or causes.keys() != world.death_causes.keys():
            raise ValueError("Неверные причины смертности")
        world.death_causes = {key: integer(value, 0, world.deaths) for key, value in causes.items()}
        if sum(world.death_causes.values()) != world.deaths:
            raise ValueError("Нарушен баланс смертности")
        world.elevation = [float(number(v, 0, 1)) for v in array(data["elevation"], WIDTH * HEIGHT)]
        world.food = [float(number(v, 0, 1)) for v in array(data["food"], WIDTH * HEIGHT)]
        world.meat = [float(number(v, 0, 3)) for v in array(data["meat"], WIDTH * HEIGHT)]
        world.land_tiles = [i for i in range(WIDTH * HEIGHT) if world.land(i)]
        if not world.land_tiles:
            raise ValueError("В сохранении нет суши")
        if any(world.food[i] != 0 or world.meat[i] != 0 for i in range(WIDTH * HEIGHT) if not world.land(i)):
            raise ValueError("Ресурсы не могут находиться в океане")
        creatures = data["creatures"]
        if not isinstance(creatures, list) or len(creatures) > MAX_POPULATION:
            raise ValueError("Превышен предел популяции")
        world.creatures = []
        ids = set()
        actions = {"Исследует", "Ищет пищу", "Ест растения", "Оставляет потомство",
                   "Спасается", "Охотится", "Ест останки", "Атакует"}
        creature_fields = {item.name for item in fields(Creature)}
        for record in creatures:
            if not isinstance(record, dict) or record.keys() != creature_fields:
                raise ValueError("Неверная запись существа")
            c = Creature(**record)
            integer(c.id, 1, world.next_id - 1)
            if c.id in ids:
                raise ValueError("Повторяющийся ID существа")
            ids.add(c.id)
            number(c.x, 0, WIDTH - 0.000001)
            number(c.y, 0, HEIGHT - 0.000001)
            if not world.land(world.tile(c.x, c.y)):
                raise ValueError("Существо оказалось в океане")
            for weight in array(c.brain, WEIGHTS):
                number(weight, -100, 100)
            if c.diet not in DIETS:
                raise ValueError("Неизвестный тип питания")
            number(c.speed, 0.6, 1.8)
            number(c.size, 0.6, 1.5)
            number(c.vision, 3, 12)
            number(c.health, 0, 100)
            if c.health <= 0:
                raise ValueError("Здоровье живого существа должно быть положительным")
            integer(c.kills, 0, world.death_causes["predation"])
            if c.diet == "herbivore" and c.kills:
                raise ValueError("Травоядные не охотятся")
            for activation in array(c.memory, HIDDEN):
                number(activation, -1, 1)
            number(c.hue, 0, 0.9999999999999999)
            number(c.ideal_temp, -30, 50)
            number(c.energy, 0, 185)
            if c.energy <= 0:
                raise ValueError("Живое существо должно иметь энергию")
            number(c.age, 0, 220)
            integer(c.generation, 1, world.next_id)
            integer(c.children, 0, world.births)
            if c.parent is not None:
                integer(c.parent, 1, c.id - 1)
            if c.action not in actions:
                raise ValueError("Неизвестное действие существа")
            world.creatures.append(c)
        if sum(c.kills for c in world.creatures) > world.death_causes["predation"]:
            raise ValueError("Неверное число успешных охот")
        if len(creatures) != config.population + world.births - world.deaths:
            raise ValueError("Нарушен баланс популяции")
        history = data["history"]
        if not isinstance(history, list) or not 1 <= len(history) <= 240:
            raise ValueError("Неверная история популяции")
        last_day = -1
        for sample in history:
            day = integer(sample["day"], 0, int(world.day))
            integer(sample["population"], 0, MAX_POPULATION)
            herbivores = integer(sample["herbivores"], 0, MAX_POPULATION)
            carnivores = integer(sample["carnivores"], 0, MAX_POPULATION)
            if herbivores + carnivores != sample["population"]:
                raise ValueError("Неверные количества на графике")
            if day <= last_day:
                raise ValueError("Нарушен порядок истории")
            last_day = day
        world.history = history
        events = data["events"]
        if not isinstance(events, list) or len(events) > 20 or any(not isinstance(e, str) or len(e) > 512 for e in events):
            raise ValueError("Неверный журнал событий")
        world.events = events
        rng = array(data["rng"], 3)
        state = (rng[0], tuple(array(rng[1], 625)), rng[2])
        integer(state[0], 3, 3)
        for value in state[1][:-1]:
            integer(value, 0, 2**32 - 1)
        integer(state[1][-1], 0, 624)
        if state[2] is not None:
            number(state[2], -10**6, 10**6)
        world.rng = random.Random()
        world.rng.setstate(state)
        if type(data["paused"]) is not bool or type(data["speed"]) is not int or data["speed"] not in (1, 2, 5, 10):
            raise ValueError("Неверное состояние времени")
        return world, data["paused"], data["speed"]
    except (KeyError, TypeError, OverflowError, AttributeError) as exc:
        raise ValueError("Повреждённое или неполное сохранение") from exc


def save(world: World, paused: bool, speed: int, path: str) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(pack(world, paused, speed), ensure_ascii=True, allow_nan=False)
    if len(text.encode("utf-8")) > MAX_SAVE_BYTES:
        raise ValueError("Сохранение превышает 16 МБ")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load(path: str) -> tuple[World, bool, int]:
    with Path(path).expanduser().open("rb") as stream:
        raw = stream.read(MAX_SAVE_BYTES + 1)
    if len(raw) > MAX_SAVE_BYTES:
        raise ValueError("Сохранение превышает 16 МБ")
    try:
        return unpack(json.loads(raw))
    except (UnicodeError, RecursionError) as exc:
        raise ValueError("Нечитаемый файл сохранения") from exc
