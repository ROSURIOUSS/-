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

from . import earth as earth_model
from .intelligence import new_experience, validate_experience
from .behavior import validate_observations
from .weather import initial_moisture
from .world import Config, Creature, DIETS, HEIGHT, HIDDEN, MAX_POPULATION, WEIGHTS, WIDTH, World, environment_fields

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
    return {"format": 9, "config": asdict(world.config), "day": world.day,
            "earth": world.earth,
            "births": world.births, "deaths": world.deaths, "next_id": world.next_id,
            "introduced": world.introduced, "temperature_bias": world.temperature_bias,
            "moisture": world.moisture, "rain_bias": world.rain_bias,
            "death_causes": world.death_causes,
            "elevation": world.elevation, "food": world.food, "meat": world.meat,
            "soil": world.soil, "canopy": world.canopy,
            "leaves": world.leaves, "seeds": world.seeds,
            "creatures": [asdict(c) for c in world.creatures],
            "observations": [world.observations[c.id] for c in world.creatures if c.id in world.observations],
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


MORPHOLOGY_FIELDS = {"elongation", "armor", "lineage", "lineage_complete"}


def migrate_v4(data: dict) -> dict:
    """Neutral bodies; recover only ancestry actually present in the legacy save.

    A missing parent's ID is a shared anchor for its surviving children, NOT a
    claim that it was the founder. Monotone parent IDs make this iterative/DAG-safe.
    """
    upgraded = copy.deepcopy(data)
    records = upgraded["creatures"]
    if not isinstance(records, list) or len(records) > MAX_POPULATION:
        raise ValueError("Неверная популяция старого мира")
    legacy_fields = {item.name for item in fields(Creature)} - MORPHOLOGY_FIELDS - {"foraging", "experience"}
    by_id = {}
    for record in records:
        if not isinstance(record, dict) or record.keys() != legacy_fields:
            raise ValueError("Неверная старая запись существа")
        identity = integer(record["id"], 1, 10**12)
        if identity in by_id:
            raise ValueError("Повторяющийся ID существа")
        if record["parent"] is not None:
            integer(record["parent"], 1, identity - 1)
        by_id[identity] = record
    for identity in sorted(by_id):
        record = by_id[identity]
        parent = by_id.get(record["parent"])
        record.update(elongation=1.0, armor=0.0,
                      lineage=parent["lineage"] if parent else (record["parent"] or identity),
                      lineage_complete=parent["lineage_complete"] if parent else record["parent"] is None)
    upgraded["format"] = 5
    return upgraded


def unpack(data: dict) -> tuple[World, bool, int]:
    try:
        if not isinstance(data, dict) or type(data.get("format")) is not int or data["format"] not in (1, 2, 3, 4, 5, 6, 7, 8, 9):
            raise ValueError("Неизвестный формат сохранения")
        if data["format"] == 1:
            data = migrate_v1(data)
        if data["format"] == 2:
            data = copy.deepcopy(data)
            config = Config.parse(data["config"])
            elevations = array(data["elevation"], WIDTH * HEIGHT)
            foods = array(data["food"], WIDTH * HEIGHT)
            for value in elevations + foods:
                number(value, 0, 1)
            data["soil"], data["canopy"] = environment_fields(config, elevations, foods)
            data["format"] = 3
            data["events"] = (data["events"] + ["Мир обновлён до v3: добавлены почвы, сукцессия и круговая долгота."])[-20:]
        if data["format"] == 3:
            data = copy.deepcopy(data)
            data["introduced"] = 0
            data["temperature_bias"] = [0.0] * (WIDTH * HEIGHT)
            data["death_causes"]["intervention"] = 0
            data["format"] = 4
        if data["format"] == 4:
            data = migrate_v4(data)
        if not isinstance(data["config"], dict) or data["config"].keys() != asdict(Config()).keys():
            raise ValueError("Неполные параметры мира")
        earth = earth_model.validate(data["earth"]) if data["format"] >= 9 else None
        config = Config.parse(data["config"], allow_empty=earth is not None)
        world = World(config)
        world.earth = earth
        world.day = float(number(data["day"], 0, 10**12))
        world.births = integer(data["births"], 0, 10**12)
        world.deaths = integer(data["deaths"], 0, 10**12)
        world.introduced = integer(data["introduced"], 0, 10**12)
        world.temperature_bias = [float(number(v, -40, 40)) for v in array(data["temperature_bias"], WIDTH * HEIGHT)]
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
        world.soil = [float(number(v, 0, 1)) for v in array(data["soil"], WIDTH * HEIGHT)]
        world.canopy = [float(number(v, 0, 1)) for v in array(data["canopy"], WIDTH * HEIGHT)]
        if data["format"] == 5:
            world.moisture = initial_moisture(config, world.elevation)
            world.rain_bias = [0.0] * (WIDTH * HEIGHT)
        else:
            world.moisture = [float(number(v, 0, 1)) for v in array(data["moisture"], WIDTH * HEIGHT)]
            world.rain_bias = [float(number(v, 0, 1)) for v in array(data["rain_bias"], WIDTH * HEIGHT)]
        if data["format"] <= 6:
            # Preserve old grass and RNG; do not invent a second edible biomass stock.
            world.leaves, world.seeds = [0.0] * (WIDTH * HEIGHT), [0.0] * (WIDTH * HEIGHT)
            data = copy.deepcopy(data)
            for record in data["creatures"]:
                record["foraging"] = 0.0
        else:
            world.leaves = [float(number(v, 0, 1)) for v in array(data["leaves"], WIDTH * HEIGHT)]
            world.seeds = [float(number(v, 0, 1)) for v in array(data["seeds"], WIDTH * HEIGHT)]
        if data["format"] <= 7:
            data = copy.deepcopy(data)
            for record in data["creatures"]:
                record["experience"] = new_experience()
        world.refresh_weather()
        world.land_tiles = [i for i in range(WIDTH * HEIGHT) if world.land(i)]
        if not world.land_tiles:
            raise ValueError("В сохранении нет суши")
        if any(world.food[i] != 0 or world.meat[i] != 0 or world.soil[i] != 0 or world.canopy[i] != 0 or world.leaves[i] != 0 or world.seeds[i] != 0 for i in range(WIDTH * HEIGHT) if not world.land(i)):
            raise ValueError("Ресурсы не могут находиться в океане")
        if any(world.moisture[i] != 1.0 for i in range(WIDTH * HEIGHT) if not world.land(i)):
            raise ValueError("В океане запас влаги должен быть полным")
        creatures = data["creatures"]
        if not isinstance(creatures, list) or len(creatures) > MAX_POPULATION:
            raise ValueError("Превышен предел популяции")
        world.creatures = []
        ids = set()
        actions = {"Исследует", "Ищет пищу", "Ест растения", "Оставляет потомство",
                   "Спасается", "Охотится", "Ест останки", "Атакует", "Ест траву", "Ест листву", "Ест семена"}
        creature_fields = {item.name for item in fields(Creature)}
        for record in creatures:
            if not isinstance(record, dict) or record.keys() != creature_fields:
                raise ValueError("Неверная запись существа")
            c = Creature(**record)
            c.experience = validate_experience(c.experience)
            integer(c.id, 1, world.next_id - 1)
            if c.id in ids:
                raise ValueError("Повторяющийся ID существа")
            ids.add(c.id)
            number(c.x, 0, WIDTH)
            number(c.y, 0, HEIGHT)
            if c.x >= WIDTH or c.y >= HEIGHT:
                raise ValueError("Координаты организма за границей сетки")
            if not world.land(world.tile(c.x, c.y)):
                raise ValueError("Существо оказалось в океане")
            for weight in array(c.brain, WEIGHTS):
                number(weight, -100, 100)
            if c.diet not in DIETS:
                raise ValueError("Неизвестный тип питания")
            number(c.elongation, 0.65, 1.8)
            number(c.armor, 0, 1)
            number(c.foraging, 0, 1)
            integer(c.lineage, 1, c.id)
            if type(c.lineage_complete) is not bool:
                raise ValueError("Неверная полнота родословной")
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
            if c.parent is None:
                if c.lineage != c.id or not c.lineage_complete or c.generation != 1:
                    raise ValueError("Неверная линия основателя")
            elif c.lineage > c.parent:
                raise ValueError("Линия не может начинаться после родителя")
            if c.action not in actions:
                raise ValueError("Неизвестное действие существа")
            world.creatures.append(c)
        by_id = {c.id: c for c in world.creatures}
        families = {}
        for c in world.creatures:
            parent = by_id.get(c.parent)
            if parent and (c.lineage != parent.lineage or c.lineage_complete != parent.lineage_complete
                           or c.diet != parent.diet or c.generation != parent.generation + 1):
                raise ValueError("Нарушено наследование родственной линии")
            identity = (c.diet, c.lineage_complete)
            if c.lineage in families and families[c.lineage] != identity:
                raise ValueError("Противоречивые данные родственной линии")
            families[c.lineage] = identity
        if sum(c.kills for c in world.creatures) > world.death_causes["predation"]:
            raise ValueError("Неверное число успешных охот")
        if len(creatures) != config.population + world.births + world.introduced - world.deaths:
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
        world.observations = validate_observations(data.get("observations", []), world.creatures, world.day)
        if world.earth is not None:
            if config.population != 0 or world.creatures or world.births or world.deaths or world.introduced or world.next_id != 1 or world.observations:
                raise ValueError("В добиологическом сценарии не должно быть организмов или событий их жизни")
            if abs(world.day * earth_model.MYR_PER_MODEL_DAY - world.earth["age_myr"]) > 1e-8:
                raise ValueError("Несогласованные геологические часы")
            if any(any(getattr(world, key)) for key in ("food", "leaves", "seeds", "meat", "soil", "canopy", "temperature_bias", "rain_bias")):
                raise ValueError("В ранней Земле не должно быть готовой экосистемы или ручных поправок")
        return world, data["paused"], data["speed"]
    except (KeyError, TypeError, OverflowError, AttributeError) as exc:
        raise ValueError("Повреждённое или неполное сохранение") from exc


def save(world: World, paused: bool, speed: int, path: str) -> None:
    write_payload(pack(world, paused, speed), path)


def write_payload(data: dict, path: str) -> None:
    """Shared atomic writer for manual saves and independently replaceable backups."""
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=True, allow_nan=False)
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


def read_payload(path: str) -> dict:
    with Path(path).expanduser().open("rb") as stream:
        raw = stream.read(MAX_SAVE_BYTES + 1)
    if len(raw) > MAX_SAVE_BYTES:
        raise ValueError("Сохранение превышает 16 МБ")
    try:
        return json.loads(raw)
    except (UnicodeError, RecursionError) as exc:
        raise ValueError("Нечитаемый файл сохранения") from exc


def load(path: str) -> tuple[World, bool, int]:
    return unpack(read_payload(path))
