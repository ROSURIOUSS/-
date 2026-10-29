"""Explicitly prescribed early-Earth scenario, NOT a reconstruction of geology.

0..600 Myr after a nominal 4.54 Ga formation. Cooling is an illustrative forcing;
water coverage follows temperature and a weighted terrain quantile. No tectonics,
chemical abiogenesis, microbes, vegetation or animals are silently invented.
"""
from __future__ import annotations

import math

RADIUS_M = 6_371_000.0
RELIEF_M = 8_000.0
FORMATION_MYR = 4_540.0
END_MYR = 600.0
MYR_PER_MODEL_DAY = 20.0  # A normal 0.25 tick advances 5 Myr, NOT five real days.


def validate(state):
    if state is None:
        return None
    if not isinstance(state, dict) or state.keys() != {"format", "age_myr"}:
        raise ValueError("Неверный сценарий ранней Земли")
    age = state["age_myr"]
    if type(state["format"]) is not int or state["format"] != 1:
        raise ValueError("Неизвестная версия сценария Земли")
    if type(age) not in (int, float) or not math.isfinite(age) or not 0 <= age <= END_MYR:
        raise ValueError("Неверное геологическое время")
    return {"format": 1, "age_myr": float(age)}


def surface(state, elevation, width, height):
    age = state["age_myr"]
    temperature = 15.0 + 1785.0 * math.exp(-age / 85.0)
    solid = max(0.0, min(1.0, (1400.0 - temperature) / 1000.0))
    target_water = 0.71 * max(0.0, min(1.0, (100.0 - temperature) / 60.0)) if solid > 0.95 else 0.0
    weights = [math.cos(((y + 0.5) / height - 0.5) * math.pi) for y in range(height)]
    ranked = sorted((h, weights[i // width]) for i, h in enumerate(elevation))
    total = sum(weights) * width
    sea = ranked[0][0] - 1e-6
    if target_water > 0:
        accumulated = 0.0
        for index, (h, weight) in enumerate(ranked[:-1]):
            accumulated += weight
            if accumulated >= target_water * total:
                sea = (h + ranked[index + 1][0]) * 0.5
                break
    ocean = sum(weights[i // width] for i, h in enumerate(elevation) if h <= sea) / total
    if solid < 0.05:
        phase = "Магматическая поверхность"
    elif solid < 0.95:
        phase = "Остывание и формирование коры"
    elif ocean < 0.01:
        phase = "Горячая кора, вода ещё не конденсируется"
    elif temperature > 60:
        phase = "Конденсация воды и появление океана"
    else:
        phase = "Добиологическая среда — происхождение жизни ещё не моделируется"
    return {"age_myr": age, "years_ago_myr": FORMATION_MYR - age,
            "temperature_c": temperature, "solid_fraction": solid, "sea_level": sea,
            "ocean_percent": ocean * 100, "phase": phase, "complete": age >= END_MYR,
            "radius_m": RADIUS_M, "relief_m": RELIEF_M,
            "atmosphere_height_m": 100_000.0, "cloud_height_m": 12_000.0,
            "myr_per_tick": 5.0, "model": "prescribed_early_earth_v1"}


def refresh(world, *, reset_water=False):
    world._earth_surface = surface(world.earth, world.elevation, len(world.elevation) // 48, 48)
    world.land_tiles = [i for i in range(len(world.elevation)) if world.land(i)]
    rain = world._earth_surface["ocean_percent"] / 100 * 0.5
    world.precipitation = [rain] * len(world.elevation)
    if reset_water:
        world.moisture = [0.0 if world.land(i) else 1.0 for i in range(len(world.elevation))]


def advance(world, dt):
    previous = world._earth_surface["phase"]
    age = min(END_MYR, world.earth["age_myr"] + dt * MYR_PER_MODEL_DAY)
    world.earth["age_myr"] = age
    world.day = age / MYR_PER_MODEL_DAY
    refresh(world, reset_water=True)
    if previous != world._earth_surface["phase"]:
        world.events.append("После формирования: %.0f млн лет — %s." % (age, world._earth_surface["phase"]))
    if int(world.day) > world.history[-1]["day"]:
        world.record()
    world.events = world.events[-20:]
