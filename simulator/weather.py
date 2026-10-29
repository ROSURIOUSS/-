"""Small deterministic weather forcing and soil-water balance, not fluid dynamics.

Atmospheric fronts are a function of seed, time and position. They never consume
agent RNG or change when an observer requests another snapshot.
"""
from __future__ import annotations

import math


def initial_moisture(config, elevation: list[float]) -> list[float]:
    return [1.0 if height <= config.sea_level else
            max(0.05, min(0.95, 0.12 + config.rainfall * 0.75 - (height - config.sea_level) * 0.25))
            for height in elevation]


def weather_field(config, day: float, width: int, height: int) -> list[float]:
    """Precipitation intensity 0..1; longitude is periodic, latitude is bounded.

    Separable waves avoid running several trig functions for every grid cell.
    These are moving weather fronts, not individually simulated clouds.
    """
    phase = ((config.seed * 1103515245 + 12345) & 0xFFFFFFFF) / 2**32 * math.tau
    # Reduce periods before trig so late saves remain numerically well behaved.
    drift = (day % (math.tau / 0.12)) * 0.12
    secondary = (day % (math.tau / 0.18)) * 0.18
    season = (day % 120) * math.tau / 120
    primary_x = [math.sin((x + 0.5) / width * math.tau - drift + phase) for x in range(width)]
    secondary_x = [math.cos((x + 0.5) / width * math.tau * 2 + secondary + phase * 1.7) for x in range(width)]
    threshold = 0.78 - 0.58 * config.rainfall
    result = []
    for y in range(height):
        latitude = (y + 0.5) / height * 2 - 1
        pole_fade = math.cos(latitude * math.pi / 2)
        band = math.cos(latitude * math.pi * 1.5) * pole_fade
        seasonal_rain = config.rainfall * (0.8 + 0.2 * math.sin(season + latitude * math.pi))
        for x in range(width):
            front = 0.5 + 0.35 * primary_x[x] * pole_fade + 0.15 * secondary_x[x] * band
            result.append(max(0.0, min(1.0, (front - threshold) * 3)) * seasonal_rain)
    return result


def advance_moisture(moisture: float, rain: float, temperature: float,
                     cover: float, soil: float, elevation: float, sea_level: float, dt: float) -> float:
    """Bounded reservoir with rain infiltration, shade retention and evaporation.

    No lake/snowpack/runoff solver: oceans are represented separately by the caller.
    """
    infiltration = rain * 0.06 * (0.7 + soil * 0.3)
    evaporation = (0.004 + max(0.0, temperature + 5) * 0.00025) * (1 - cover * 0.45)
    drainage = max(0.0, elevation - sea_level - 0.1) * 0.006
    return max(0.0, min(1.0, moisture + dt * (infiltration - evaporation - drainage)))
