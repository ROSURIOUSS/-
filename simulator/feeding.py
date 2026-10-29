"""Two terrestrial plant stocks and seasonal seeds, not individual plant agents.

food remains grass for old worlds/tools. Leaves and seeds are separate consumable
stocks; canopy is habitat cover, never another copy of edible biomass.
"""
from __future__ import annotations

import math

FOODS = ("grass", "leaves", "seeds", "carrion")
LABELS = {"grass": "Ест траву", "leaves": "Ест листву", "seeds": "Ест семена", "carrion": "Ест останки"}


def initial_forage(elevation, sea, canopy, grass):
    leaves, seeds = [], []
    for h, cover, food in zip(elevation, canopy, grass):
        leaves.append(cover * 0.45 if h > sea else 0.0)
        seeds.append(cover * food * 0.06 if h > sea else 0.0)
    return leaves, seeds


def advance_forage(leaves, seeds, cover, moisture, soil, temperature, day, dt):
    water = min(1.0, moisture * 1.8)
    climate = max(0.0, 1 - abs(temperature - 23) / 27)
    growth = dt * 0.028 * (0.12 + cover) * water * climate * (0.3 + soil * 0.7) * (1 - leaves)
    lost = min(leaves, dt * leaves * (0.025 * (1 - water) + 0.012 * (1 - climate)))
    leaves = max(0.0, min(1.0, leaves + growth - lost))
    # A forced seasonal cycle, not flowering/pollination or seed dispersal.
    season = 0.5 + 0.5 * math.sin((day % 120) * math.tau / 120)
    decayed = seeds * (1 - math.exp(-dt * 0.025))
    produced = min(leaves, max(0.0, 1.0 - seeds + decayed), dt * 0.018 * leaves * water * climate * season)
    leaves -= produced
    seeds = max(0.0, min(1.0, seeds + produced - decayed))
    return leaves, seeds, lost + decayed


def efficiencies(foraging):
    return (1 - 0.7 * foraging, 0.3 + 0.7 * foraging,
            0.45 + 0.5 * (1 - abs(2 * foraging - 1)))


def menu(world, creature, tile):
    if creature.diet == "carnivore":
        return (("carrion", world.meat, 105.0),)
    return tuple((name, stock, calories * efficiency) for name, stock, calories, efficiency in zip(
        ("grass", "leaves", "seeds"), (world.food, world.leaves, world.seeds),
        (75.0, 85.0, 110.0), efficiencies(creature.foraging)))


def food_signal(world, creature, tile):
    return min(1.0, sum(stock[tile] * calories / 75 for _, stock, calories in menu(world, creature, tile)))


def take_meal(world, creature, tile, dt):
    capacity = dt * 0.38 * creature.size
    # One bite budget, one resource, deterministic tie order; no free duplicated meal.
    name, stock, calories = max(menu(world, creature, tile),
                                key=lambda entry: min(entry[1][tile], capacity) * entry[2])
    bite = min(stock[tile], capacity)
    if bite <= 0:
        return None
    stock[tile] -= bite
    gained = min(185.0 - creature.energy, bite * calories)
    creature.energy += gained
    return {"food": name, "amount": bite, "energy": gained}
