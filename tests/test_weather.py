import copy
import json
import math
import random
import tempfile
import unittest
from pathlib import Path

from simulator import persistence
from simulator.runtime import Simulation
from simulator.weather import advance_moisture, initial_moisture, weather_field
from simulator.world import Config, HEIGHT, WIDTH, World

SIZE = WIDTH * HEIGHT


def packed(world):
    return json.loads(json.dumps(persistence.pack(world, False, 1)))


def bare_world(**settings):
    world = World(Config(population=2, predator_ratio=0, **settings))
    world.deaths = 2
    world.death_causes["intervention"] = 2
    world.creatures.clear()
    world.refresh_history()
    return world


class WeatherFieldTests(unittest.TestCase):
    def test_weather_is_seeded_bounded_and_independent_of_agent_rng(self):
        config = Config(population=2)
        a = weather_field(config, 12.5, WIDTH, HEIGHT)
        self.assertEqual(len(a), SIZE)
        self.assertEqual(a, weather_field(config, 12.5, WIDTH, HEIGHT))
        self.assertTrue(all(math.isfinite(v) and 0 <= v <= 1 for v in a))
        self.assertNotEqual(a, weather_field(Config(seed=43), 12.5, WIDTH, HEIGHT))
        self.assertNotEqual(a, weather_field(config, 15, WIDTH, HEIGHT))
        world = World(config)
        before = world.rng.getstate()
        for _ in range(5):
            world.refresh_weather()
            world.snapshot()
        self.assertEqual(before, world.rng.getstate())

    def test_weather_does_not_depend_on_number_or_order_of_creatures(self):
        a, b = World(Config(population=2)), World(Config(population=100))
        self.assertEqual(a.precipitation, b.precipitation)
        b.creatures.reverse()
        b.refresh_weather()
        self.assertEqual(a.precipitation, b.precipitation)

    def test_longitude_seam_is_smooth_instead_of_a_discontinuous_front(self):
        for day in (0, 32.25, 1000000000000.0):
            field = weather_field(Config(rainfall=1), day, WIDTH, HEIGHT)
            for y in range(HEIGHT):
                self.assertLess(abs(field[y * WIDTH] - field[y * WIDTH + WIDTH - 1]), 0.20)
            self.assertTrue(all(math.isfinite(v) and 0 <= v <= 1 for v in field))

    def test_wet_climate_has_more_precipitation_than_arid_climate(self):
        for day in (0, 20, 60, 100):
            wet = weather_field(Config(rainfall=1), day, WIDTH, HEIGHT)
            dry = weather_field(Config(rainfall=0.05), day, WIDTH, HEIGHT)
            self.assertGreater(sum(wet), sum(dry))
            self.assertGreater(sum(v > 0.1 for v in wet), sum(v > 0.1 for v in dry))

    def test_initial_soil_water_is_climate_based_with_full_ocean_reservoir(self):
        config = Config()
        values = initial_moisture(config, [0.1, config.sea_level, 0.5, 0.9])
        self.assertEqual(values[:2], [1, 1])
        self.assertGreater(values[2], values[3])
        self.assertTrue(all(0 <= v <= 1 for v in values))

    def test_infiltration_evaporation_shade_and_bounds_have_physical_effects(self):
        def water(**kw):
            values = dict(moisture=0.5, rain=0, temperature=20, cover=0, soil=0.5,
                          elevation=0.6, sea_level=0.4, dt=1)
            values.update(kw)
            return advance_moisture(**values)
        self.assertLess(water(), 0.5)
        self.assertGreater(water(rain=1), water())
        self.assertGreater(water(cover=1), water(cover=0))
        self.assertLess(water(temperature=60), water(temperature=0))
        self.assertGreater(water(rain=1, soil=1), water(rain=1, soil=0))
        self.assertLess(water(elevation=0.9), water(elevation=0.5))
        self.assertEqual(water(moisture=1, rain=1, dt=1000), 1)
        self.assertEqual(water(moisture=0, temperature=80, dt=1000), 0)
        self.assertEqual(water(dt=0), 0.5)


class HydrologyTests(unittest.TestCase):
    def test_rain_brush_changes_authoritative_rain_and_soil_without_creating_life(self):
        sim = Simulation()
        world = sim.world
        c = world.creatures[0]
        tile = world.tile(c.x, c.y)
        before_moisture, before_rain = world.moisture[tile], world.precipitation[tile]
        sim.command("brush", dict(kind="rain", x=c.x, y=c.y, radius=0.75, strength=1))
        self.assertGreater(world.moisture[tile], before_moisture)
        self.assertGreater(world.precipitation[tile], before_rain)
        self.assertEqual(world.births + world.introduced + world.deaths, 0)
        state = sim.state()
        creature = next(x for x in state["creatures"] if x["id"] == c.id)
        self.assertEqual(creature["local_rain"], round(world.precipitation[tile], 3))
        self.assertEqual(creature["local_moisture"], round(world.moisture[tile], 3))
        persistence.unpack(packed(world))

    def test_rain_brush_wraps_seam_and_is_allowed_over_ocean(self):
        sim = Simulation()
        sim.command("brush", dict(kind="rain", x=0, y=24.5, radius=2, strength=1))
        self.assertGreater(sim.world.rain_bias[24 * WIDTH], 0)
        self.assertGreater(sim.world.rain_bias[24 * WIDTH + WIDTH - 1], 0)
        ocean = next(i for i in range(SIZE) if not sim.world.land(i))
        sim.command("brush", dict(kind="rain", x=ocean % WIDTH + 0.5, y=ocean // WIDTH + 0.5, radius=0.75))
        self.assertEqual(sim.world.moisture[ocean], 1)
        self.assertGreater(sim.world.rain_bias[ocean], 0)
        persistence.unpack(packed(sim.world))

    def test_rain_drought_and_noop_preserve_valid_bounds_and_previous_undo(self):
        sim = Simulation()
        c = sim.world.creatures[0]
        data = dict(x=c.x, y=c.y, radius=0.75, strength=1, stroke=1)
        for _ in range(2):
            sim.command("brush", {**data, "kind": "rain"})
        tile = sim.world.tile(c.x, c.y)
        self.assertEqual(sim.world.moisture[tile], 1)
        self.assertEqual(sim.world.rain_bias[tile], 1)
        checkpoint = copy.deepcopy(sim.sandbox.checkpoint)
        before = packed(sim.world)
        with self.assertRaises(ValueError):
            sim.command("brush", {**data, "kind": "rain", "stroke": 99})
        self.assertEqual(before, packed(sim.world))
        self.assertEqual(checkpoint, sim.sandbox.checkpoint)
        for _ in range(2):
            sim.command("brush", {**data, "kind": "dry"})
        self.assertEqual(sim.world.moisture[tile], 0)
        self.assertEqual(sim.world.rain_bias[tile], 1)  # Drying soil is not deleting the atmosphere.

    def test_pause_freezes_weather_and_bias_decay_but_single_step_advances_them(self):
        sim = Simulation()
        c = sim.world.creatures[0]
        sim.command("control", dict(paused=True))
        sim.command("brush", dict(kind="rain", x=c.x, y=c.y, radius=0.75, strength=1))
        tile = sim.world.tile(c.x, c.y)
        before = packed(sim.world)
        state = sim.state()
        for _ in range(3):
            sim.command("step", {})
            self.assertEqual(sim.state(), state)
        self.assertEqual(before, packed(sim.world))
        sim.command("single_step", {})
        self.assertAlmostEqual(sim.world.rain_bias[tile], 0.7 * math.exp(-0.25 / 3))
        self.assertNotEqual(sim.world.precipitation, state["rain"])
        self.assertTrue(sim.paused)

    def test_wet_soil_grows_more_food_and_cover_than_drought_at_same_climate(self):
        dry = bare_world(temperature=22)
        wet, _, _ = persistence.unpack(packed(dry))
        tile = next(i for i in dry.land_tiles if 20 < i // WIDTH < 28)
        for world in (dry, wet):
            world.food[tile], world.canopy[tile], world.soil[tile] = 0.8, 0.4, 0.6
        dry.moisture[tile], wet.moisture[tile] = 0, 0.9
        dry.step()
        wet.step()
        self.assertGreater(wet.food[tile], dry.food[tile])
        self.assertGreater(wet.canopy[tile], dry.canopy[tile])
        self.assertGreater(wet.soil[tile], dry.soil[tile])

    def test_heating_increases_evaporation_and_local_drought_changes_biome(self):
        cool = bare_world()
        hot, _, _ = persistence.unpack(packed(cool))
        tile = next(i for i in cool.land_tiles if 0.04 < cool.elevation[i] - cool.config.sea_level < 0.15 and 20 < i // WIDTH < 28)
        hot.temperature_bias[tile] = 40
        cool.step()
        hot.step()
        self.assertLess(hot.moisture[tile], cool.moisture[tile])
        cool.moisture[tile] = 0
        self.assertEqual(cool.biome(tile), 3)
        cool.moisture[tile] = 0.8
        self.assertNotEqual(cool.biome(tile), 3)

    def test_dry_climate_loses_soil_water_while_wet_climate_retains_more(self):
        dry = bare_world(rainfall=0.05, temperature=40)
        wet = bare_world(rainfall=1, temperature=18)
        before = sum(dry.moisture[i] for i in dry.land_tiles)
        for _ in range(80):
            dry.step()
            wet.step()
        self.assertLess(sum(dry.moisture[i] for i in dry.land_tiles), before)
        self.assertGreater(wet.snapshot()["weather"]["moisture_percent"], dry.snapshot()["weather"]["moisture_percent"])
        self.assertTrue(all(dry.moisture[i] == 1 for i in range(SIZE) if not dry.land(i)))

    def test_flood_sets_full_reservoir_and_uplift_initializes_new_soil_water(self):
        sim = Simulation()
        world = sim.world
        tile = world.land_tiles[len(world.land_tiles) // 2]
        world.elevation[tile] = world.config.sea_level + 0.01
        x, y = tile % WIDTH + 0.5, tile // WIDTH + 0.5
        sim.command("brush", dict(kind="lower", x=x, y=y, radius=0.75, strength=1))
        self.assertFalse(world.land(tile))
        self.assertEqual(world.moisture[tile], 1)
        persistence.unpack(packed(world))
        sim.command("brush", dict(kind="uplift", x=x, y=y, radius=0.75, strength=1))
        self.assertTrue(world.land(tile))
        self.assertEqual(world.moisture[tile], initial_moisture(world.config, [world.elevation[tile]])[0])
        self.assertLess(world.moisture[tile], 1)
        persistence.unpack(packed(world))

    def test_weather_summary_counts_only_land_and_is_finite_after_extinction(self):
        world = bare_world()
        for i in world.land_tiles:
            world.moisture[i] = 0.1
        weather = world.snapshot()["weather"]
        self.assertEqual(weather["moisture_percent"], 10)
        self.assertEqual(weather["drought_percent"], 100)
        self.assertEqual(weather["rain_percent"], round(sum(world.precipitation[i] for i in world.land_tiles) / len(world.land_tiles) * 100))
        json.dumps(world.snapshot(), allow_nan=False)


class WeatherPersistenceTests(unittest.TestCase):
    def test_v6_preserves_heat_rain_water_and_exact_future(self):
        sim = Simulation()
        sim.command("world", dict(population=12))
        c = sim.world.creatures[0]
        for kind in ("rain", "warm"):
            sim.command("brush", dict(kind=kind, x=c.x, y=c.y, radius=2))
        for _ in range(7):
            sim.command("single_step", {})
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "погода.biosphere"
            persistence.save(sim.world, True, 5, str(path))
            restored, paused, speed = persistence.load(str(path))
        self.assertTrue(paused)
        self.assertEqual(speed, 5)
        self.assertEqual(packed(sim.world)["format"], 7)
        self.assertEqual(packed(restored), packed(sim.world))
        self.assertEqual(restored.precipitation, sim.world.precipitation)
        for _ in range(32):
            sim.world.step()
            restored.step()
        self.assertEqual(packed(restored), packed(sim.world))
        self.assertEqual(restored.precipitation, sim.world.precipitation)

    def test_undo_restores_weather_water_and_rng_for_entire_rain_stroke(self):
        sim = Simulation()
        sim.command("world", dict(population=8))
        before, weather = packed(sim.world), sim.world.precipitation.copy()
        c = sim.world.creatures[0]
        data = dict(kind="rain", x=c.x, y=c.y, radius=2, stroke=120)
        sim.command("brush", data)
        sim.command("step", {})
        sim.command("brush", {**data, "x": (c.x + 1) % WIDTH})
        sim.command("step", {})
        sim.command("undo", {})
        self.assertEqual(before, packed(sim.world))
        self.assertEqual(weather, sim.world.precipitation)
        self.assertTrue(sim.paused)

    def test_v5_migration_is_deterministic_nonmutating_and_preserves_old_fields(self):
        world = World(Config(population=8))
        for _ in range(7):
            world.step()
        old = packed(world)
        old["format"] = 5
        for field in ("leaves", "seeds", "observations"):
            old.pop(field, None)
        for record in old["creatures"]:
            record.pop("foraging", None)
        del old["moisture"], old["rain_bias"]
        unchanged = copy.deepcopy(old)
        a, _, _ = persistence.unpack(old)
        b, _, _ = persistence.unpack(old)
        self.assertEqual(old, unchanged)
        self.assertEqual(a.moisture, initial_moisture(world.config, world.elevation))
        self.assertEqual(a.rain_bias, [0] * SIZE)
        self.assertEqual(a.rng.getstate(), world.rng.getstate())
        self.assertEqual(a.soil, world.soil)
        self.assertEqual(a.canopy, world.canopy)
        self.assertEqual(a.temperature_bias, world.temperature_bias)
        self.assertEqual([c.brain for c in a.creatures], [c.brain for c in world.creatures])
        self.assertEqual(a.lineages(), world.lineages())
        self.assertEqual(packed(a), packed(b))
        persistence.unpack(packed(a))

    def test_v6_rejects_missing_nonfinite_bad_length_and_impossible_ocean_water(self):
        good = packed(World(Config(population=2)))
        for field in ("moisture", "rain_bias"):
            for value in ([], [float("nan")] * SIZE, [True] * SIZE, [-0.01] * SIZE, [1.01] * SIZE):
                with self.subTest(field=field), self.assertRaises(ValueError):
                    persistence.unpack({**good, field: value})
            bad = copy.deepcopy(good)
            del bad[field]
            with self.assertRaises(ValueError):
                persistence.unpack(bad)
        bad = copy.deepcopy(good)
        ocean = next(i for i in range(SIZE) if bad["elevation"][i] <= bad["config"]["sea_level"])
        bad["moisture"][ocean] = 0.5
        with self.assertRaises(ValueError):
            persistence.unpack(bad)

    def test_mixed_interventions_preserve_hydrology_and_population_invariants(self):
        sim = Simulation()
        sim.command("world", dict(population=8))
        rng = random.Random(83)
        for _ in range(35):
            tile = rng.choice(sim.world.land_tiles)
            kind = rng.choice(["rain", "dry", "warm", "cool", "uplift", "lower"])
            sim.command("brush", dict(kind=kind, x=tile % WIDTH + 0.5, y=tile // WIDTH + 0.5,
                                      radius=rng.uniform(0.75, 4), strength=rng.uniform(0.1, 1)))
            sim.command("single_step", {})
            self.assertIsNone(sim.error)
            restored, _, _ = persistence.unpack(packed(sim.world))
            self.assertEqual(restored.snapshot(), sim.world.snapshot())


if __name__ == "__main__":
    unittest.main()
