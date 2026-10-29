"""Seeded artificial life: recurrent agents, trophic ecology, no dependencies."""
from __future__ import annotations

import math
import random
from .behavior import public_observation
from .weather import advance_moisture, initial_moisture, weather_field
try:
    from math import sumprod as _dot  # Python 3.12+: fast standard-library dot product.
except ImportError:
    from operator import mul

    def _dot(left, right):
        return sum(map(mul, left, right))
from dataclasses import asdict, dataclass, field

WIDTH, HEIGHT = 80, 48
INPUTS, HIDDEN, OUTPUTS = 16, 8, 4
WEIGHTS = (INPUTS + HIDDEN + 1) * HIDDEN + (HIDDEN + 1) * OUTPUTS
MAX_POPULATION = 500
DIETS = ("herbivore", "carnivore")


@dataclass(frozen=True, slots=True)
class Config:
    seed: int = 42
    population: int = 90
    temperature: float = 18.0
    rainfall: float = 0.65
    sea_level: float = 0.42
    mutation: float = 0.12
    predator_ratio: float = 0.16

    @classmethod
    def parse(cls, values: dict) -> Config:
        if not isinstance(values, dict):
            raise ValueError("Параметры должны быть объектом JSON")
        bounds = {
            "seed": (-2147483648, 2147483647), "population": (2, 300),
            "temperature": (-15, 45), "rainfall": (0.05, 1.0),
            "sea_level": (0.15, 0.75), "mutation": (0.0, 0.5),
            "predator_ratio": (0.0, 0.5),
        }
        if values.keys() - bounds.keys():
            raise ValueError("Неизвестный параметр планеты")
        result = {}
        for key, value in values.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key}: нужно число")
            low, high = bounds[key]
            if not low <= value <= high or not math.isfinite(value):
                raise ValueError(f"{key}: допустимо от {low} до {high}")
            if key in ("seed", "population") and int(value) != value:
                raise ValueError(f"{key}: нужно целое число")
            result[key] = int(value) if key in ("seed", "population") else float(value)
        return cls(**result)


def environment_fields(config: Config, elevation: list, food: list) -> tuple[list, list]:
    """Initial aggregate soil/plant succession, no extra RNG consumption."""
    soil, canopy = [], []
    for i, height in enumerate(elevation):
        if height <= config.sea_level:
            soil.append(0.0)
            canopy.append(0.0)
            continue
        latitude = abs((i // WIDTH + 0.5) / HEIGHT * 2 - 1)
        temperature = config.temperature - latitude * 12
        fertility = max(0, min(1, 0.18 + config.rainfall * 0.6 - max(0, height - config.sea_level - 0.15)))
        cover = max(0, min(1, (config.rainfall - 0.25) * 2.0 - abs(temperature - 20) * 0.018))
        soil.append(fertility)
        canopy.append(cover * (0.5 + food[i] * 0.5))
    return soil, canopy


def wrapped_dx(x: float, reference: float) -> float:
    return (x - reference + WIDTH / 2) % WIDTH - WIDTH / 2


@dataclass(slots=True)
class Creature:
    id: int
    x: float
    y: float
    brain: list[float]
    hue: float
    ideal_temp: float
    generation: int = 1
    parent: int | None = None
    energy: float = 92.0
    age: float = 0.0
    children: int = 0
    action: str = "Исследует"
    diet: str = "herbivore"
    speed: float = 1.0
    size: float = 1.0
    vision: float = 7.0
    health: float = 100.0
    kills: int = 0
    elongation: float = 1.0
    armor: float = 0.0
    lineage: int = 0
    lineage_complete: bool = True
    memory: list[float] = field(default_factory=lambda: [0.0] * HIDDEN)

    @property
    def mobility(self) -> float:
        """Body streamlining versus shell mass; actuator speed remains a separate gene."""
        return self.speed * math.sqrt(self.elongation) / (1 + 0.45 * self.armor)

    def think(self, inputs: list[float]) -> list[float]:
        # All recurrent neurons read the SAME previous state (no in-place updates).
        previous = self.memory
        brain = self.brain
        hidden = []
        stride = INPUTS + HIDDEN + 1
        for offset in range(0, HIDDEN * stride, stride):
            total = _dot(inputs, brain[offset:offset + INPUTS])
            total += _dot(previous, brain[offset + INPUTS:offset + INPUTS + HIDDEN])
            hidden.append(math.tanh(total + brain[offset + INPUTS + HIDDEN]))
        self.memory = hidden
        output = []
        for offset in range(HIDDEN * stride, WEIGHTS, HIDDEN + 1):
            output.append(math.tanh(_dot(hidden, brain[offset:offset + HIDDEN]) + brain[offset + HIDDEN]))
        return output


class SpatialIndex:
    """Mutable, bounded-radius lookup. Ties use ID, not hash iteration order."""
    CELL = 4

    def __init__(self, creatures: list[Creature]):
        self.buckets: dict[tuple[int, int], list[Creature]] = {}
        for creature in creatures:
            self.buckets.setdefault(self.key(creature.x, creature.y), []).append(creature)

    @classmethod
    def key(cls, x: float, y: float) -> tuple[int, int]:
        return int((x % WIDTH) // cls.CELL), int(y // cls.CELL)

    def move(self, creature: Creature, old: tuple[int, int]):
        new = self.key(creature.x, creature.y)
        if new != old:
            self.buckets[old].remove(creature)
            self.buckets.setdefault(new, []).append(creature)

    def nearest(self, source: Creature, diet: str, radius: float) -> Creature | None:
        left, top = math.floor((source.x - radius) / self.CELL), math.floor((source.y - radius) / self.CELL)
        right, bottom = math.floor((source.x + radius) / self.CELL), math.floor((source.y + radius) / self.CELL)
        best = None
        best_distance = radius * radius
        for cy in range(top, bottom + 1):
            for cx in range(left, right + 1):
                for candidate in self.buckets.get((cx % (WIDTH // self.CELL), cy), ()):
                    if candidate is source or candidate.diet != diet or candidate.health <= 0 or candidate.energy <= 0:
                        continue
                    distance = wrapped_dx(candidate.x, source.x) ** 2 + (candidate.y - source.y) ** 2
                    if distance < best_distance or (distance == best_distance and (best is None or candidate.id < best.id)):
                        best, best_distance = candidate, distance
        return best


def sense(source: Creature, target: Creature | None) -> list[float]:
    if target is None:
        return [0.0, 0.0]
    dx, dy = wrapped_dx(target.x, source.x), target.y - source.y
    distance = math.hypot(dx, dy)
    if distance < 1e-9:
        return [0.0, 0.0]
    strength = max(0.0, 1 - distance / source.vision)
    return [dx / distance * strength, dy / distance * strength]


def initial_brain(rng: random.Random, diet: str) -> list[float]:
    """Randomized networks with explicit, evolvable foraging/escape priors."""
    brain = [rng.gauss(0, 0.13) for _ in range(WEIGHTS)]
    stride = INPUTS + HIDDEN + 1
    # Food gradient and shoreline avoidance live IN the genome, not a bypass.
    for neuron, negative, positive in ((0, 2, 3), (1, 4, 5)):
        base = neuron * stride
        brain[base + negative] -= 1.7
        brain[base + positive] += 1.7
        brain[base + negative + 4] -= 0.8
        brain[base + positive + 4] += 0.8
    if diet == "carnivore":
        brain[12] += 3.0
        brain[stride + 13] += 3.0
    else:
        brain[14] -= 3.5
        brain[stride + 15] -= 3.5
    # A little stochastic wandering, filtered through recurrent memory.
    brain[2 * stride + 11] += 0.9
    brain[3 * stride + 11] -= 0.9
    output = HIDDEN * stride
    brain[output] += 1.5
    brain[output + 2] += 0.35
    brain[output + HIDDEN + 1 + 1] += 1.5
    brain[output + HIDDEN + 1 + 3] += 0.35
    brain[output + 2 * (HIDDEN + 1) + HIDDEN] += 0.7
    brain[output + 3 * (HIDDEN + 1) + HIDDEN] += 0.4
    return brain


class World:
    def __init__(self, config: Config):
        self.config = config
        self.rng = random.Random(config.seed)
        self.day = 0.0
        self.observations: dict[int, dict] = {}
        self.births = 0
        self.deaths = 0
        self.introduced = 0
        self.death_causes = {"starvation": 0, "age": 0, "predation": 0, "legacy": 0, "intervention": 0}
        self.next_id = 1
        self.history: list[dict] = []
        self.events: list[str] = ["Сформирована планета. Началось заселение."]
        phases = [self.rng.random() * math.tau for _ in range(8)]
        self.elevation = []
        for y in range(HEIGHT):
            for x in range(WIDTH):
                h = 0.5
                for i, amplitude in enumerate((0.22, 0.12, 0.06, 0.03)):
                    scale = 2 ** i
                    h += amplitude * math.sin(x / WIDTH * math.tau * scale + phases[2*i]) * math.cos(y / HEIGHT * math.tau * scale + phases[2*i+1])
                self.elevation.append(max(0.0, min(1.0, h)))
        if not any(self.land(i) for i in range(WIDTH * HEIGHT)):
            for y in range(HEIGHT // 2 - 3, HEIGHT // 2 + 4):
                for x in range(WIDTH // 2 - 3, WIDTH // 2 + 4):
                    self.elevation[y * WIDTH + x] = min(1.0, config.sea_level + 0.08)
        self.food = [self.rng.uniform(0.35, 1) if self.land(i) else 0.0 for i in range(WIDTH * HEIGHT)]
        self.meat = [0.0] * (WIDTH * HEIGHT)
        self.soil, self.canopy = environment_fields(config, self.elevation, self.food)
        self.temperature_bias = [0.0] * (WIDTH * HEIGHT)
        self.moisture = initial_moisture(config, self.elevation)
        self.rain_bias = [0.0] * (WIDTH * HEIGHT)
        self.refresh_weather()
        self.land_tiles = [i for i in range(WIDTH * HEIGHT) if self.land(i)]
        self.creatures: list[Creature] = []
        predators = round(config.population * config.predator_ratio)
        for i in range(config.population):
            tile = self.rng.choice(self.land_tiles)
            self.creatures.append(self.new_creature(tile % WIDTH + 0.5, tile // WIDTH + 0.5,
                                                   diet="carnivore" if i < predators else "herbivore"))
        self.record()

    def land(self, tile: int) -> bool:
        return self.elevation[tile] > self.config.sea_level

    def tile(self, x: float, y: float) -> int:
        return max(0, min(HEIGHT - 1, int(y))) * WIDTH + math.floor(x) % WIDTH

    @property
    def temperature(self) -> float:
        return self.config.temperature + 8 * math.sin(self.day * math.tau / 120)

    def local_temperature(self, y: float, x: float | None = None) -> float:
        bias = self.temperature_bias[self.tile(x, y)] if x is not None else 0.0
        return self.temperature - 12 * abs(y / HEIGHT * 2 - 1) + bias

    def refresh_weather(self):
        natural = weather_field(self.config, self.day, WIDTH, HEIGHT)
        self.precipitation = [min(1.0, rain + bias) for rain, bias in zip(natural, self.rain_bias)]

    def new_creature(self, x: float, y: float, parent: Creature | None = None,
                     *, diet: str = "herbivore") -> Creature:
        rng = self.rng
        if parent:
            brain = [max(-4.0, min(4.0, w + rng.gauss(0, 0.35)))
                     if rng.random() < self.config.mutation else w for w in parent.brain]
            hue = (parent.hue + rng.gauss(0, self.config.mutation * 0.15)) % 1
            temp = max(-30, min(50, parent.ideal_temp + rng.gauss(0, self.config.mutation * 10)))
            diet = parent.diet
            def gene(value, deviation, low, high):
                if rng.random() < self.config.mutation:
                    value += rng.gauss(0, deviation)
                return max(low, min(high, value))
            speed = gene(parent.speed, 0.12, 0.6, 1.8)
            size = gene(parent.size, 0.1, 0.6, 1.5)
            vision = gene(parent.vision, 1.0, 3.0, 12.0)
            elongation = gene(parent.elongation, 0.12, 0.65, 1.8)
            armor = gene(parent.armor, 0.10, 0.0, 1.0)
        else:
            brain = initial_brain(rng, diet)
            hue = rng.random()
            temp = rng.uniform(-5, 35)
            speed = rng.uniform(1.1, 1.4) if diet == "carnivore" else rng.uniform(1.0, 1.5)
            size = rng.uniform(0.8, 1.2)
            vision = rng.uniform(6, 10)
            elongation = rng.uniform(0.85, 1.2)
            armor = rng.uniform(0.0, 0.3)
        creature = Creature(self.next_id, x, y, brain, hue, temp,
                            generation=parent.generation + 1 if parent else 1,
                            parent=parent.id if parent else None, diet=diet,
                            speed=speed, size=size, vision=vision,
                            elongation=elongation, armor=armor,
                            lineage=parent.lineage if parent else self.next_id,
                            lineage_complete=parent.lineage_complete if parent else True)
        self.next_id += 1
        return creature

    def step(self, dt: float = 0.25):
        self.day += dt
        self.observations = {}
        thermal_decay = math.exp(-dt / 120)
        self.temperature_bias = [bias * thermal_decay for bias in self.temperature_bias]
        rain_decay = math.exp(-dt / 3.0)
        self.rain_bias = [bias * rain_decay for bias in self.rain_bias]
        self.refresh_weather()
        growth = max(0.03, 1 - abs(self.temperature - 22) / 40) * 0.075 * dt
        decay = math.exp(-0.025 * dt)
        for i in self.land_tiles:
            decomposed = self.meat[i] * (1 - decay)
            self.meat[i] *= decay
            food = self.food[i]
            cover = self.canopy[i]
            local_temperature = self.local_temperature((i // WIDTH) + 0.5, i % WIDTH + 0.5)
            self.moisture[i] = advance_moisture(self.moisture[i], self.precipitation[i], local_temperature,
                                               cover, self.soil[i], self.elevation[i], self.config.sea_level, dt)
            water = min(1.0, self.moisture[i] * 1.6)
            climate = max(0.0, 1 - abs(local_temperature - 21) / 32)
            self.soil[i] = max(0.0, min(1.0, self.soil[i] + decomposed * 0.25 + dt * (
                cover * 0.0008 - max(0, 0.25 - food) * 0.002 - (1 - water) * 0.0005)))
            self.canopy[i] = max(0.0, min(1.0, cover + dt * (
                0.013 * climate * water * max(0, food - 0.45)
                - 0.018 * max(0, 0.35 - food) - 0.006 * (1 - climate) - 0.008 * max(0.0, 0.22 - self.moisture[i]))))
            self.food[i] = min(1.0, food + growth * water * (0.4 + climate * 0.6) * (0.5 + self.soil[i] * 0.7) * (1 - cover * 0.18) + decomposed * 0.2)
        dead: set[int] = set()
        babies: list[Creature] = []
        had_population = bool(self.creatures)
        old_counts = self.counts()
        highest_generation = max((c.generation for c in self.creatures), default=1)
        self.rng.shuffle(self.creatures)
        index = SpatialIndex(self.creatures)

        def retire(c: Creature, cause: str):
            if c.id in dead:
                return
            dead.add(c.id)
            self.deaths += 1
            self.death_causes[cause] += 1
            tile = self.tile(c.x, c.y)
            self.meat[tile] = min(3.0, self.meat[tile] + c.size * 0.25 + max(0, c.energy) / 500)
            c.health = 0.0

        for c in self.creatures:
            if c.id in dead:
                continue
            c.age += dt
            tile = self.tile(c.x, c.y)
            nearby = [self.tile(c.x + dx, c.y + dy) for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2))]
            temp = self.local_temperature(c.y, c.x)
            temp -= self.canopy[tile] * (3.0 if temp > 20 else -0.8)
            prey = index.nearest(c, "herbivore", c.vision) if c.diet == "carnivore" else None
            threat = index.nearest(c, "carnivore", c.vision) if c.diet == "herbivore" else None
            resource = self.food if c.diet == "herbivore" else self.meat
            inputs = [c.energy / 100 - 1, min(1, resource[tile]),
                      *[min(1, resource[n]) for n in nearby],
                      *[1.0 if self.land(n) else -1.0 for n in nearby],
                      (temp - c.ideal_temp) / 30, self.rng.uniform(-1, 1),
                      *sense(c, prey), *sense(c, threat)]
            dx, dy, eat, reproduce = c.think(inputs)
            old_x, old_y = c.x, c.y
            old_key = index.key(c.x, c.y)
            nx = (c.x + dx * dt * 2.4 * c.mobility) % WIDTH
            ny = max(0.01, min(HEIGHT - 0.01, c.y + dy * dt * 2.4 * c.mobility))
            blocked = not self.land(self.tile(nx, ny))
            if not blocked:
                c.x, c.y = nx, ny
                index.move(c, old_key)
            tile = self.tile(c.x, c.y)
            velocity = [wrapped_dx(c.x, old_x) / dt, (c.y - old_y) / dt] if dt > 0 else [0.0, 0.0]
            self.observations[c.id] = {
                "id": c.id, "day": self.day, "dt": dt, "inputs": inputs,
                "outputs": [dx, dy, eat, reproduce], "velocity": velocity,
                "prey": prey.id if prey else None, "threat": threat.id if threat else None,
                "blocked": blocked,
            }
            # Labels report measured movement, not assumed intent from mere proximity.
            escaping = threat is not None and sum(a * b for a, b in zip(velocity, inputs[14:16])) < -1e-6
            chasing = prey is not None and sum(a * b for a, b in zip(velocity, inputs[12:14])) > 1e-6
            c.action = "Спасается" if escaping else ("Охотится" if chasing else "Ищет пищу")
            if eat > -0.4:
                bite = min(resource[tile], dt * 0.38 * c.size)
                resource[tile] -= bite
                c.energy = min(185.0, c.energy + bite * (75 if c.diet == "herbivore" else 105))
                if bite > 0.01:
                    c.action = "Ест растения" if c.diet == "herbivore" else "Ест останки"
            c.energy -= dt * (2.1 * c.size + (abs(dx) + abs(dy)) * c.speed**2 * 0.9 * (0.8 + 0.2 * c.elongation)
                              + c.armor * 0.9 + c.vision * 0.06 + abs(temp - c.ideal_temp) * 0.16 + c.age * 0.008)
            if c.health <= 0 or c.energy <= 0 or c.age > 220:
                retire(c, "age" if c.age > 220 else "starvation")
                continue
            if c.energy > 70:
                c.health = min(100.0, c.health + dt * 1.5)
            if c.diet == "carnivore" and eat > -0.4:
                victim = index.nearest(c, "herbivore", 1.1)
                if victim is not None:
                    damage = min(victim.health, dt * 60 * c.size / victim.size / (1 + 1.6 * victim.armor))
                    victim.health -= damage
                    c.energy = min(185.0, c.energy + damage * 0.25)
                    c.action = "Атакует"
                    if victim.health <= 0:
                        retire(victim, "predation")
                        c.kills += 1
            birth_threshold = 155 if c.diet == "carnivore" else 135
            if (c.energy > birth_threshold and c.age > 12 and c.health > 45 and reproduce > -0.5
                    and len(self.creatures) - len(dead) + len(babies) < MAX_POPULATION):
                x, y = c.x, c.y
                for _ in range(4):
                    angle = self.rng.uniform(0, math.tau)
                    nx = (c.x + math.cos(angle)) % WIDTH
                    ny = max(0.01, min(HEIGHT - 0.01, c.y + math.sin(angle)))
                    if self.land(self.tile(nx, ny)):
                        x, y = nx, ny
                        break
                child = self.new_creature(x, y, c)
                child.energy = 58
                c.energy -= 88 if c.diet == "carnivore" else 68
                c.children += 1
                c.action = "Оставляет потомство"
                babies.append(child)
                self.births += 1
                if child.generation > highest_generation:
                    highest_generation = child.generation
                    self.events.append(f"День {int(self.day)}: появилось поколение {child.generation}.")
        self.creatures = [c for c in self.creatures if c.id not in dead] + babies
        self.observations = {c.id: self.observations[c.id] for c in self.creatures if c.id in self.observations}
        counts = self.counts()
        for diet, name in (("herbivores", "Травоядные"), ("carnivores", "Хищники")):
            if old_counts[diet] and not counts[diet]:
                self.events.append(f"День {int(self.day)}: {name.lower()} исчезли.")
        if had_population and not self.creatures:
            self.events.append("Популяция вымерла. Измените условия и создайте новый мир.")
        if int(self.day) > (self.history[-1]["day"] if self.history else -1):
            self.record()
        self.events = self.events[-20:]

    def counts(self) -> dict[str, int]:
        predators = sum(c.diet == "carnivore" for c in self.creatures)
        return {"herbivores": len(self.creatures) - predators, "carnivores": predators}

    def record(self):
        self.history.append({"day": int(self.day), "population": len(self.creatures), **self.counts()})
        self.history = self.history[-240:]

    def refresh_history(self):
        sample = {"day": int(self.day), "population": len(self.creatures), **self.counts()}
        if self.history and self.history[-1]["day"] == sample["day"]:
            self.history[-1] = sample
        else:
            self.history.append(sample)
            self.history = self.history[-240:]

    def biome(self, tile: int) -> int:
        """0 ocean, 1 coast, 2 tundra, 3 drylands, 4 grass, 5 forest, 6 wetland, 7 highland."""
        altitude = self.elevation[tile] - self.config.sea_level
        if altitude <= 0:
            return 0
        if altitude < 0.025:
            return 1
        if self.local_temperature(tile // WIDTH + 0.5, tile % WIDTH + 0.5) < 0:
            return 2
        if altitude > 0.28:
            return 7
        if self.moisture[tile] < 0.18 or self.soil[tile] < 0.18:
            return 3
        if altitude < 0.06 and self.moisture[tile] > 0.7:
            return 6
        return 5 if self.canopy[tile] > 0.55 else 4

    def lineages(self) -> list[dict]:
        """Living family groups, not species or a fabricated archive of dead ancestors."""
        groups: dict[int, list[Creature]] = {}
        for c in self.creatures:
            groups.setdefault(c.lineage, []).append(c)
        result = []
        for identity, members in groups.items():
            representative = max(members, key=lambda c: (c.generation, c.children, -c.id))
            result.append({"id": identity, "complete": members[0].lineage_complete,
                           "diet": members[0].diet, "population": len(members),
                           "generation": representative.generation, "representative": representative.id,
                           "mean_armor": round(sum(c.armor for c in members) / len(members), 3),
                           "mean_elongation": round(sum(c.elongation for c in members) / len(members), 3)})
        return sorted(result, key=lambda group: (-group["population"], group["id"]))

    def snapshot(self) -> dict:
        creatures = [{"id": c.id, "x": round(c.x, 3), "y": round(c.y, 3),
                      "hue": round(c.hue, 3), "energy": round(c.energy, 1),
                      "age": round(c.age, 1), "generation": c.generation,
                      "parent": c.parent, "children": c.children,
                      "ideal_temp": round(c.ideal_temp, 1), "action": c.action,
                      "diet": c.diet, "speed": round(c.speed, 2), "size": round(c.size, 2),
                      "vision": round(c.vision, 1), "health": round(c.health, 1), "kills": c.kills,
                      "local_temperature": round(self.local_temperature(c.y, c.x), 1),
                      "local_moisture": round(self.moisture[self.tile(c.x, c.y)], 3),
                      "local_rain": round(self.precipitation[self.tile(c.x, c.y)], 3),
                      "elongation": round(c.elongation, 3), "armor": round(c.armor, 3),
                      "mobility": round(c.mobility, 3), "lineage": c.lineage,
                      "lineage_complete": c.lineage_complete,
                      "memory": [round(v, 3) for v in c.memory],
                      "behavior": public_observation(self.observations.get(c.id))}
                     for c in self.creatures]
        lineages = self.lineages()
        return {"moisture": [round(v, 3) for v in self.moisture],
                "rain": [round(v, 3) for v in self.precipitation],
                "weather": {"moisture_percent": round(sum(self.moisture[i] for i in self.land_tiles) / len(self.land_tiles) * 100),
                            "rain_percent": round(sum(self.precipitation[i] for i in self.land_tiles) / len(self.land_tiles) * 100),
                            "drought_percent": round(sum(self.moisture[i] < 0.18 for i in self.land_tiles) / len(self.land_tiles) * 100)},
                "lineages": lineages,
                "evolution": {"lineages": len(lineages),
                              "mean_armor": round(sum(c.armor for c in self.creatures) / len(self.creatures), 3) if self.creatures else 0.0,
                              "mean_elongation": round(sum(c.elongation for c in self.creatures) / len(self.creatures), 3) if self.creatures else 0.0},
                "width": WIDTH, "height": HEIGHT, "config": asdict(self.config),
                "day": round(self.day, 2), "temperature": round(self.temperature, 1),
                "population": len(creatures), **self.counts(),
                "births": self.births, "deaths": self.deaths, "introduced": self.introduced, "death_causes": self.death_causes.copy(),
                "generation": max((c.generation for c in self.creatures), default=0),
                "food_percent": round(sum(self.food) / len(self.land_tiles) * 100),
                "ecosystem": {"forest_percent": round(sum(self.canopy[i] > 0.55 for i in self.land_tiles) / len(self.land_tiles) * 100),
                              "fertility_percent": round(sum(self.soil) / len(self.land_tiles) * 100),
                              "occupied_tiles": len({self.tile(c.x, c.y) for c in self.creatures}),
                              "biomass": round(sum(c.size for c in self.creatures), 1)},
                "biomes": [self.biome(i) for i in range(WIDTH * HEIGHT)],
                "temperature_bias": [round(v, 3) for v in self.temperature_bias],
                "soil": [round(v, 3) for v in self.soil], "canopy": [round(v, 3) for v in self.canopy],
                "elevation": [round(h, 5) for h in self.elevation],
                "food": [round(f, 2) for f in self.food], "meat": [round(m, 3) for m in self.meat],
                "creatures": creatures, "history": self.history.copy(), "events": self.events.copy()}
