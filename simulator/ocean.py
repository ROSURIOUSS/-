"""Local aquatic microcosm: explicit founder, not chemical abiogenesis.

Micrometre coordinates never become giant objects in the planetary scene.
Energy/nutrient conversion and hours are illustrative, not species calibration.
"""
from __future__ import annotations

import copy
import math
from dataclasses import asdict, dataclass, field

from .intelligence import new_experience, recurrent_decision, learn, summary, validate_experience

WIDTH_UM, HEIGHT_UM = 400.0, 240.0
COLS, ROWS, MAX_CELLS = 24, 16, 128
WEIGHTS = 236


@dataclass
class Cell:
    id: int
    x: float
    y: float
    brain: list
    energy: float = 40.0
    age: float = 0.0
    generation: int = 1
    parent: int | None = None
    threshold: float = 90.0
    metabolism: float = 1.0
    memory: list = field(default_factory=lambda: [0.0] * 8)
    experience: dict = field(default_factory=new_experience)
    inputs: list = field(default_factory=list)
    outputs: list = field(default_factory=list)
    absorbed: float = 0.0
    action: str = "Начальная клетка"

    @property
    def diameter_um(self):
        # Reserve-equivalent biomass controls volume; equal division conserves it.
        return 4.0 * (self.energy / 40.0) ** (1 / 3)


def tile(x, y):
    return min(ROWS - 1, max(0, int(y / HEIGHT_UM * ROWS))) * COLS + min(COLS - 1, max(0, int(x / WIDTH_UM * COLS)))


def new_ocean(world):
    from .world import WIDTH, HEIGHT
    if world.earth is None or not world._earth_surface['complete']:
        raise ValueError("Сначала завершите остывание ранней Земли")
    if world.ocean is not None:
        raise ValueError("Водная микросреда уже запущена; повторное заселение запрещено")
    water = [i for i in range(WIDTH * HEIGHT) if not world.land(i)]
    if not water or not 0 < world.temperature < 60:
        raise ValueError("Нет подходящей жидкой водной среды")
    anchor = min(water, key=lambda i: (abs(i // WIDTH - HEIGHT // 2), i))
    # Inherited foraging prior, explicitly designed rather than learned from zero.
    brain = [world.rng.gauss(0, 0.1) for _ in range(WEIGHTS)]
    for neuron, negative, positive in ((0, 2, 3), (1, 4, 5)):
        brain[neuron * 25 + negative] -= 1.6
        brain[neuron * 25 + positive] += 1.6
    brain[200] += 1.5
    brain[210] += 1.5
    brain[226] += 0.8
    brain[235] += 0.4
    return {"format": 1, "anchor": anchor, "hours": 0.0, "feed_rate": 0.03,
            "births": 0, "deaths": 0, "next_id": 2,
            "nutrients": [world.rng.uniform(0.5, 0.9) for _ in range(COLS * ROWS)],
            "cells": [Cell(1, WIDTH_UM / 2, HEIGHT_UM / 2, brain)],
            "history": [{"hour": 0, "population": 1}]}


def advance(world, dt):
    state = world.ocean
    state['hours'] += dt
    stock = state['nutrients']
    for i, value in enumerate(stock):
        stock[i] = min(1.0, value + dt * state['feed_rate'] * (1 - value))
    cells = state['cells']
    world.rng.shuffle(cells)
    survivors, babies = [], []
    temperature_factor = max(0.05, 1 - abs(world.temperature - 23) / 35)
    for cell in cells:
        before = cell.energy
        cell.age += dt
        i = tile(cell.x, cell.y)
        neighbours = [tile(cell.x + dx, cell.y + dy) for dx, dy in ((-15, 0), (15, 0), (0, -15), (0, 15))]
        nearest = min((c for c in cells if c is not cell and c.energy > 1),
                      key=lambda c: ((c.x - cell.x)**2 + (c.y - cell.y)**2, c.id), default=None)
        vx, vy = (nearest.x - cell.x, nearest.y - cell.y) if nearest else (0, 0)
        distance = math.hypot(vx, vy)
        signal = max(0, 1 - distance / 60) / distance if distance > 1e-9 else 0
        crowd = sum(math.hypot(c.x - cell.x, c.y - cell.y) < 20 for c in cells if c is not cell)
        cell.inputs = [cell.energy / 100 - 1, stock[i], *[stock[j] for j in neighbours],
                       min(1, cell.x / 15), min(1, (WIDTH_UM - cell.x) / 15),
                       min(1, cell.y / 15), min(1, (HEIGHT_UM - cell.y) / 15),
                       (world.temperature - 23) / 30, world.rng.uniform(-1, 1),
                       vx * signal, vy * signal, min(1, crowd / 8), min(1, cell.age / 96)]
        cell.memory, cell.outputs = recurrent_decision(cell.brain, cell.memory, cell.experience, cell.inputs)
        dx, dy, absorb, divide = cell.outputs
        radius = cell.diameter_um / 2
        nx, ny = cell.x + dx * dt * 35, cell.y + dy * dt * 35
        cell.x = max(radius, min(WIDTH_UM - radius, nx))
        cell.y = max(radius, min(HEIGHT_UM - radius, ny))
        blocked = abs(nx - cell.x) + abs(ny - cell.y) > 1e-8
        i = tile(cell.x, cell.y)
        cell.absorbed = min(stock[i], dt * 0.075 * cell.metabolism * temperature_factor) if absorb > -0.4 else 0.0
        stock[i] -= cell.absorbed
        cell.energy = min(180.0, cell.energy + cell.absorbed * 100)
        cell.energy -= dt * (0.8 * cell.metabolism + (abs(dx) + abs(dy)) * 0.25 + 0.15)
        cell.action = "Поглощает растворённое питание" if cell.absorbed > 0 else "Движется без поглощения"
        if cell.energy <= 1 or cell.age >= 96:
            state['deaths'] += 1
            stock[i] = min(1, stock[i] + max(0, cell.energy) / 100 * 0.25)
            continue
        divided = False
        if cell.energy >= cell.threshold and cell.age >= 2 and divide > -0.5 and len(cells) + len(babies) < MAX_CELLS:
            # Equal reserve split, no energy granted to a child out of nowhere.
            cell.energy *= 0.5
            brain = [max(-4, min(4, w + world.rng.gauss(0, 0.12))) if world.rng.random() < 0.08 else w
                     for w in cell.brain]
            angle = world.rng.uniform(0, math.tau)
            x = max(5, min(WIDTH_UM - 5, cell.x + math.cos(angle) * cell.diameter_um * 1.2))
            y = max(5, min(HEIGHT_UM - 5, cell.y + math.sin(angle) * cell.diameter_um * 1.2))
            babies.append(Cell(state['next_id'], x, y, brain, energy=cell.energy,
                               generation=cell.generation + 1, parent=cell.id,
                               threshold=max(70, min(130, cell.threshold + world.rng.gauss(0, 2))),
                               metabolism=max(0.6, min(1.8, cell.metabolism + world.rng.gauss(0, 0.03)))))
            state['next_id'] += 1
            state['births'] += 1
            cell.action = "Разделилась на две клетки"
            divided = True
        # Compensate the split only in the teaching signal, never in real reserves.
        after_for_reward = cell.energy * 2 if divided else cell.energy
        learn(cell.experience, (after_for_reward - before) / 6 - (0.2 if blocked else 0) + (0.2 if divided else 0))
        radius = cell.diameter_um / 2
        cell.x, cell.y = max(radius, min(WIDTH_UM - radius, cell.x)), max(radius, min(HEIGHT_UM - radius, cell.y))
        survivors.append(cell)
    state['cells'] = survivors + babies
    sample = {'hour': int(state['hours']), 'population': len(state['cells'])}
    if sample['hour'] > state['history'][-1]['hour']:
        state['history'].append(sample)
        state['history'] = state['history'][-240:]
    else:
        state['history'][-1] = sample


def pack(state):
    if state is None:
        return None
    return {**{k: copy.deepcopy(v) for k, v in state.items() if k != 'cells'},
            'cells': [asdict(cell) for cell in state['cells']]}


def snapshot(state):
    if state is None:
        return None
    return {**{k: copy.deepcopy(v) for k, v in state.items() if k not in ('cells', 'next_id', 'format')},
            'width_um': WIDTH_UM, 'height_um': HEIGHT_UM, 'cols': COLS, 'rows': ROWS, 'limit': MAX_CELLS,
            'cells': [{'id': c.id, 'x': c.x, 'y': c.y, 'diameter_um': c.diameter_um,
                       'energy': c.energy, 'age': c.age, 'generation': c.generation, 'parent': c.parent,
                       'metabolism': c.metabolism, 'threshold': c.threshold, 'action': c.action,
                       'inputs': c.inputs.copy(), 'outputs': c.outputs.copy(), 'absorbed': c.absorbed,
                       'memory': c.memory.copy(), 'intelligence': summary(c.experience)} for c in state['cells']]}


def unpack(raw, world):
    if raw is None:
        return None
    from .world import WIDTH, HEIGHT
    from .persistence import number, integer, array
    keys = {'format', 'anchor', 'hours', 'feed_rate', 'births', 'deaths', 'next_id', 'nutrients', 'cells', 'history'}
    if not isinstance(raw, dict) or raw.keys() != keys or type(raw['format']) is not int or raw['format'] != 1:
        raise ValueError('Неверная водная микросреда')
    if world.earth is None or not world._earth_surface['complete'] or not 0 < world.temperature < 60:
        raise ValueError('Клетки требуют остывшую раннюю Землю')
    state = copy.deepcopy(raw)
    anchor = integer(state['anchor'], 0, WIDTH * HEIGHT - 1)
    if world.land(anchor):
        raise ValueError('Микросреда должна находиться в океане')
    number(state['hours'], 0, 1e9)
    number(state['feed_rate'], 0, 1)
    for key in ('births', 'deaths'):
        integer(state[key], 0, 10**12)
    integer(state['next_id'], 2, 10**12)
    if state['next_id'] != state['births'] + 2:
        raise ValueError('Неверная последовательность делений')
    for value in array(state['nutrients'], COLS * ROWS):
        number(value, 0, 1)
    if not isinstance(state['cells'], list) or len(state['cells']) > MAX_CELLS:
        raise ValueError('Слишком много водных клеток')
    if 1 + state['births'] - state['deaths'] != len(state['cells']):
        raise ValueError('Нарушен баланс водной популяции')
    ids, cells = set(), []
    for record in state['cells']:
        if not isinstance(record, dict) or record.keys() != Cell.__dataclass_fields__.keys():
            raise ValueError('Неверная водная клетка')
        c = Cell(**record)
        integer(c.id, 1, state['next_id'] - 1)
        if c.id in ids:
            raise ValueError('Повторяющаяся водная клетка')
        ids.add(c.id)
        number(c.x, 0, WIDTH_UM)
        number(c.y, 0, HEIGHT_UM)
        number(c.energy, 1.000000000001, 180)
        number(c.age, 0, min(96, state['hours']))
        if c.age >= 96:
            raise ValueError('Клетка превысила предельный возраст')
        integer(c.generation, 1, c.id)
        if c.parent is None:
            if c.id != 1 or c.generation != 1:
                raise ValueError('Неверная начальная клетка')
        else:
            integer(c.parent, 1, c.id - 1)
            if c.generation < 2:
                raise ValueError('Неверное поколение дочерней клетки')
        number(c.threshold, 70, 130)
        number(c.metabolism, 0.6, 1.8)
        for w in array(c.brain, WEIGHTS):
            number(w, -100, 100)
        for v in array(c.memory, 8):
            number(v, -1, 1)
        c.experience = validate_experience(c.experience)
        if not isinstance(c.inputs, list) or not isinstance(c.outputs, list):
            raise ValueError('Неверные массивы водного наблюдения')
        if len(c.inputs) not in (0, 16) or len(c.outputs) not in (0, 4) or bool(c.inputs) != bool(c.outputs):
            raise ValueError('Неверное наблюдение водной сети')
        for v in array(c.inputs, len(c.inputs)):
            number(v, -100, 100)
        for v in array(c.outputs, len(c.outputs)):
            number(v, -1, 1)
        number(c.absorbed, 0, 1)
        if c.action not in ('Начальная клетка', 'Поглощает растворённое питание', 'Движется без поглощения', 'Разделилась на две клетки'):
            raise ValueError('Неверное действие водной клетки')
        cells.append(c)
    by_id = {c.id: c for c in cells}
    for c in cells:
        if c.parent in by_id and c.generation != by_id[c.parent].generation + 1:
            raise ValueError('Нарушена водная родословная')
    history = state['history']
    if not isinstance(history, list) or not 1 <= len(history) <= 240:
        raise ValueError('Неверная водная история')
    previous = -1
    for sample in history:
        if not isinstance(sample, dict) or sample.keys() != {'hour', 'population'}:
            raise ValueError('Неверная точка водной истории')
        integer(sample['hour'], 0, int(state['hours']))
        integer(sample['population'], 0, MAX_CELLS)
        if sample['hour'] <= previous:
            raise ValueError('Неверный порядок водной истории')
        previous = sample['hour']
    if history[-1]['population'] != len(cells) or history[-1]['hour'] != int(state['hours']):
        raise ValueError('История водной популяции устарела')
    state['cells'] = cells
    return state
