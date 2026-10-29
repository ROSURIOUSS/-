"""Last-step observations, not an explanation of intent or a new controller.

Kept separately from inherited Creature fields. Optional world-save save metadata preserves
observations on undo/recovery; old saves simply have none until the next step.
"""
from __future__ import annotations

import math
import copy
from .feeding import FOODS


def validate_observations(records, creatures, day):
    if not isinstance(records, list) or len(records) > len(creatures):
        raise ValueError("Неверные наблюдения поведения")
    alive = {c.id for c in creatures}
    result = {}
    keys = {"id", "day", "dt", "inputs", "outputs", "velocity", "prey", "threat", "blocked"}
    def number(value, low, high):
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError("Неверное число в наблюдении поведения")
        return value
    for record in records:
        if not isinstance(record, dict) or record.keys() not in (keys, keys | {"meal"}):
            raise ValueError("Неверная запись поведения")
        identity = record["id"]
        if type(identity) is not int or identity not in alive or identity in result:
            raise ValueError("Неверный организм в наблюдении")
        number(record["day"], 0, day)
        number(record["dt"], 0.000001, 100)
        for key, length, bound in (("inputs", 16, 100), ("outputs", 4, 1), ("velocity", 2, 100)):
            values = record[key]
            if not isinstance(values, list) or len(values) != length:
                raise ValueError("Неверный вектор наблюдения")
            for value in values:
                number(value, -bound, bound)
        for key in ("prey", "threat"):
            # The observed target may have died later in the same sequential step.
            target = record[key]
            if target is not None and (type(target) is not int or not 1 <= target <= 10**12):
                raise ValueError("Неверная цель наблюдения")
        if type(record["blocked"]) is not bool:
            raise ValueError("Неверный признак препятствия")
        meal = record.get("meal")
        if meal is not None:
            if not isinstance(meal, dict) or meal.keys() != {"food", "amount", "energy"} or meal["food"] not in FOODS:
                raise ValueError("Неверная запись приёма пищи")
            number(meal["amount"], 0, 3)
            number(meal["energy"], 0, 185)
        result[identity] = copy.deepcopy(record)
        result[identity]["meal"] = copy.deepcopy(meal)
    return result


def public_observation(record):
    if record is None:
        return None
    return {key: [round(v, 4) for v in value] if isinstance(value, list) else value
            for key, value in copy.deepcopy(record).items()}
