import copy
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from simulator import persistence
from simulator.runtime import Simulation
from simulator.sandbox import Brush, TOOLS
from simulator.world import Config, HEIGHT, MAX_POPULATION, WIDTH, World

ROOT = Path(__file__).resolve().parent.parent


def packed(world):
    return json.loads(json.dumps(persistence.pack(world, False, 1)))


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.sim = Simulation()
        self.sim.world = World(Config(population=2, predator_ratio=0))
        self.world = self.sim.world
        # Controlled, save-valid landscape; no changes to population accounting.
        self.world.elevation = [0.65] * (WIDTH * HEIGHT)
        self.world.land_tiles = list(range(WIDTH * HEIGHT))
        for name, value in (("food", 0.3), ("soil", 0.4), ("canopy", 0.2), ("meat", 0.1)):
            setattr(self.world, name, [value] * (WIDTH * HEIGHT))
        self.tile = 24 * WIDTH + 40
        for c in self.world.creatures:
            c.x, c.y = 40.5, 24.5

    def brush(self, kind="plant", **kwargs):
        data = dict(kind=kind, x=40.5, y=24.5, radius=1.5, strength=1.0, count=5)
        data.update(kwargs)
        return self.sim.command("brush", data)

    def assert_valid(self, world=None):
        world = world or self.sim.world
        restored, _, _ = persistence.unpack(packed(world))
        self.assertEqual(packed(world), packed(restored))
        self.assertEqual(len(world.creatures), world.config.population + world.births + world.introduced - world.deaths)
        self.assertEqual(world.deaths, sum(world.death_causes.values()))

    def test_all_tools_change_real_model_and_can_be_saved(self):
        for tool in TOOLS:
            with self.subTest(tool=tool):
                self.setUp()
                before = packed(self.world)
                self.brush(tool)
                self.assertNotEqual(packed(self.world), before)
                self.assertTrue(self.sim.sandbox.state()["can_undo"])
                self.assert_valid()

    def test_plants_fertility_and_drought_are_bounded_and_local(self):
        far = 0
        untouched = tuple(getattr(self.world, f)[far] for f in ("food", "soil", "canopy"))
        self.brush("plant")
        self.assertGreater(self.world.food[self.tile], 0.3)
        self.assertGreater(self.world.canopy[self.tile], 0.2)
        self.brush("fertilize")
        self.assertGreater(self.world.soil[self.tile], 0.4)
        for _ in range(20):
            self.brush("dry", stroke=1)
        for field in (self.world.food, self.world.soil, self.world.canopy):
            self.assertTrue(all(0 <= v <= 1 for v in field))
            self.assertEqual(field[self.tile], 0)
        self.assertEqual(untouched, tuple(getattr(self.world, f)[far] for f in ("food", "soil", "canopy")))

    def test_wrapped_footprint_and_spawn_respect_planet_edges(self):
        brush = Brush.parse(dict(kind="warm", x=0, y=0, radius=8))
        cells = brush.footprint()
        self.assertEqual(len(cells), len({tile for tile, _ in cells}))
        self.assertTrue(all(0 <= tile < WIDTH * HEIGHT and 0 < w <= 1 for tile, w in cells))
        self.brush("warm", x=0, y=24.5)
        self.assertGreater(self.world.temperature_bias[24 * WIDTH], 0)
        self.assertGreater(self.world.temperature_bias[24 * WIDTH + WIDTH - 1], 0)
        self.brush("spawn_carnivore", x=WIDTH, y=HEIGHT, radius=0.75, count=30)
        self.assertEqual(self.world.introduced, 30)
        region = Brush.parse(dict(kind="warm", x=WIDTH, y=HEIGHT, radius=0.75))
        for c in self.world.creatures[2:]:
            self.assertTrue(0 <= c.x < WIDTH and 0 <= c.y < HEIGHT)
            self.assertLessEqual(region.distance(c.x, c.y), region.radius)
        self.assert_valid()

    def test_founders_are_not_natural_births_and_manual_deaths_are_not_hunts(self):
        self.brush("spawn_carnivore", count=7)
        newcomers = self.world.creatures[2:]
        self.assertEqual(self.world.introduced, 7)
        self.assertEqual(self.world.births, 0)
        self.assertTrue(all(c.generation == 1 and c.parent is None and c.diet == "carnivore" for c in newcomers))
        self.assertEqual(len({c.id for c in self.world.creatures}), 9)
        self.assertEqual(self.world.history[-1]["population"], 9)
        self.assertEqual(len(self.world.history), 1)
        self.brush("erase_life", radius=3)
        self.assertEqual(self.world.creatures, [])
        self.assertEqual(self.world.death_causes["intervention"], 9)
        self.assertEqual(self.world.death_causes["predation"], 0)
        self.brush("spawn_herbivore", count=2)
        self.assert_valid()

    def test_spawn_caps_population_and_noop_preserves_checkpoint_and_rng(self):
        for _ in range(17):
            self.brush("spawn_herbivore", count=30, stroke=41)
        self.assertEqual(len(self.world.creatures), MAX_POPULATION)
        before = packed(self.world)
        checkpoint = copy.deepcopy(self.sim.sandbox.checkpoint)
        with self.assertRaises(ValueError):
            self.brush("spawn_herbivore", count=30, stroke=99)
        self.assertEqual(packed(self.world), before)
        self.assertEqual(self.sim.sandbox.checkpoint, checkpoint)
        self.assert_valid()

    def test_heal_restores_actual_health_and_energy_without_births(self):
        c = self.world.creatures[0]
        c.health, c.energy = 20, 10
        self.brush("heal")
        self.assertEqual((c.health, c.energy), (55, 65))
        self.assertEqual(self.world.births + self.world.introduced + self.world.deaths, 0)
        for _ in range(5):
            try:
                self.brush("heal", stroke=1)
            except ValueError:
                pass
        self.assertEqual((c.health, c.energy), (100, 185))
        before = packed(self.world)
        checkpoint = copy.deepcopy(self.sim.sandbox.checkpoint)
        with self.assertRaises(ValueError):
            self.brush("heal")
        self.assertEqual(before, packed(self.world))
        self.assertEqual(checkpoint, self.sim.sandbox.checkpoint)

    def test_thermal_bias_is_local_clamped_and_decays_only_with_model_time(self):
        for _ in range(6):
            self.brush("warm", stroke=12)
        self.assertEqual(self.world.temperature_bias[self.tile], 40)
        self.assertEqual(self.world.temperature_bias[0], 0)
        self.assertAlmostEqual(self.world.local_temperature(24.5, 40.5) - self.world.local_temperature(24.5), 40)
        self.sim.command("control", {"paused": True})
        before = packed(self.world)
        self.sim.command("state", {})
        self.sim.command("step", {})
        self.assertEqual(before, packed(self.world))
        self.sim.command("single_step", {})
        self.assertAlmostEqual(self.world.temperature_bias[self.tile], 40 * math.exp(-0.25 / 120))
        for _ in range(10):
            self.brush("cool", stroke=13)
        self.assertEqual(self.world.temperature_bias[self.tile], -40)
        self.assert_valid()

    def test_temperature_changes_plant_growth_and_organism_energy_cost(self):
        control, _, _ = persistence.unpack(packed(self.world))
        for world in (self.world, control):
            for c in world.creatures:
                c.brain = [0.0] * len(c.brain)
                c.ideal_temp = 18
        for _ in range(4):
            self.brush("warm", stroke=1)
        self.world.step()
        control.step()
        self.assertLess(self.world.food[self.tile], control.food[self.tile])
        self.assertLess(self.world.creatures[0].energy, control.creatures[0].energy)
        self.assertGreater(self.world.snapshot()["creatures"][0]["local_temperature"], 50)

    def test_flood_removes_resources_and_counts_intervention_deaths(self):
        self.world.elevation[self.tile] = self.world.config.sea_level + 0.01
        self.brush("lower", radius=0.75)
        self.assertNotIn(self.tile, self.world.land_tiles)
        self.assertEqual(len(self.world.creatures), 0)
        self.assertEqual(self.world.deaths, 2)
        self.assertEqual(self.world.death_causes["intervention"], 2)
        for field in ("food", "meat", "soil", "canopy", "leaves", "seeds"):
            self.assertEqual(getattr(self.world, field)[self.tile], 0)
        self.assert_valid()

    def test_uplift_creates_habitable_land_with_initial_soil(self):
        self.world.elevation[self.tile] = self.world.config.sea_level - 0.01
        self.world.land_tiles.remove(self.tile)
        for c in self.world.creatures:
            c.x += 2
        for field in ("food", "meat", "soil", "canopy", "leaves", "seeds"):
            getattr(self.world, field)[self.tile] = 0
        self.brush("uplift", radius=0.75)
        self.assertIn(self.tile, self.world.land_tiles)
        self.assertEqual(self.world.food[self.tile], 0.1)
        self.assertGreater(self.world.soil[self.tile], 0)
        self.brush("spawn_herbivore", radius=0.75)
        self.assert_valid()

    def test_last_land_cannot_be_flooded_and_invalid_action_is_atomic(self):
        self.world.elevation = [0.1] * (WIDTH * HEIGHT)
        self.world.moisture = [1.0] * (WIDTH * HEIGHT)
        self.world.elevation[self.tile] = self.world.config.sea_level + 0.01
        self.world.land_tiles = [self.tile]
        for field in ("food", "meat", "soil", "canopy", "leaves", "seeds"):
            setattr(self.world, field, [0.0] * (WIDTH * HEIGHT))
        before = packed(self.world)
        with self.assertRaises(ValueError):
            self.brush("lower", radius=0.75)
        self.assertEqual(before, packed(self.world))
        self.assertFalse(self.sim.sandbox.state()["can_undo"])
        self.assert_valid()

    def test_ocean_plant_and_spawn_are_rejected_but_temperature_works(self):
        self.world.elevation[0] = 0
        self.world.moisture[0] = 1
        self.world.land_tiles.remove(0)
        for field in ("food", "meat", "soil", "canopy", "leaves", "seeds"):
            getattr(self.world, field)[0] = 0
        for kind in ("plant", "spawn_herbivore", "fertilize", "dry"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.brush(kind, x=0.5, y=0.5, radius=0.75)
        self.brush("warm", x=0.5, y=0.5, radius=0.75)
        self.assertEqual(self.world.temperature_bias[0], 12)
        self.assert_valid()

    def test_one_checkpoint_per_drag_and_undo_rewinds_autonomous_events_and_rng(self):
        self.sim.command("control", {"speed": 5})
        before = packed(self.world)
        self.brush("plant", stroke=100)
        first_checkpoint = self.sim.sandbox.checkpoint
        self.sim.command("step", {})
        self.brush("plant", x=42.5, stroke=100)
        self.assertIs(self.sim.sandbox.checkpoint, first_checkpoint)
        self.assertEqual(len([e for e in self.world.events if "песочница" in e]), 1)
        self.sim.command("step", {})
        self.sim.command("undo", {})
        self.assertTrue(self.sim.paused)
        self.assertEqual(self.sim.speed, 5)
        self.assertEqual(packed(self.sim.world), before)
        self.assertFalse(self.sim.sandbox.state()["can_undo"])
        expected, _, _ = persistence.unpack(before)
        for _ in range(8):
            expected.step()
            self.sim.command("single_step", {})
        self.assertEqual(packed(expected), packed(self.sim.world))
        with self.assertRaises(ValueError):
            self.sim.command("undo", {})

    def test_next_stroke_replaces_checkpoint_and_omitted_stroke_is_atomic(self):
        self.brush("plant", stroke=1)
        after_first = packed(self.world)
        self.brush("plant", x=43.5, stroke=2)
        self.sim.command("undo", {})
        self.assertEqual(packed(self.sim.world), after_first)
        self.world = self.sim.world
        self.brush("warm")
        after_warm = packed(self.world)
        self.brush("warm")
        self.sim.command("undo", {})
        self.assertEqual(packed(self.sim.world), after_warm)

    def test_single_step_ignores_speed_and_leaves_paused(self):
        for paused in (True, False):
            self.sim.command("control", {"paused": paused, "speed": 10})
            before = self.world.day
            self.sim.command("single_step", {})
            self.assertEqual(self.world.day - before, 0.25)
            self.assertTrue(self.sim.paused)

    def test_invalid_payloads_do_not_touch_world_or_previous_undo(self):
        self.brush("warm", stroke=1)
        before, checkpoint = packed(self.world), copy.deepcopy(self.sim.sandbox.checkpoint)
        invalid = [("kind", "meteor"), ("kind", []), ("x", -1), ("x", WIDTH + 1),
                   ("y", HEIGHT + 1), ("x", float("nan")), ("radius", float("inf")),
                   ("radius", 0), ("strength", 0), ("strength", True), ("count", True),
                   ("count", 1.0), ("count", 31), ("stroke", -1), ("stroke", 2**53 + 1),
                   ("stroke", True), ("oops", 1)]
        for key, value in invalid:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.brush(**{key: value})
            self.assertEqual(before, packed(self.world))
            self.assertEqual(checkpoint, self.sim.sandbox.checkpoint)
        for name, data in (("undo", {"x": 1}), ("single_step", {"speed": 5}), ("brush", [])):
            with self.assertRaises(ValueError):
                self.sim.command(name, data)
        self.assertEqual(before, packed(self.world))

    def test_spawn_failure_restores_rng_and_ids_and_does_not_replace_undo(self):
        self.brush("warm")
        before, checkpoint = packed(self.world), copy.deepcopy(self.sim.sandbox.checkpoint)
        original = self.world.new_creature
        calls = 0

        def failing(*args, **kwargs):
            nonlocal calls
            calls += 1
            creature = original(*args, **kwargs)
            if calls == 2:
                raise ValueError("synthetic creation failure")
            return creature

        with patch.object(self.world, "new_creature", side_effect=failing):
            with self.assertRaises(ValueError):
                self.brush("spawn_herbivore", count=3)
        self.assertEqual(before, packed(self.world))
        self.assertEqual(checkpoint, self.sim.sandbox.checkpoint)

    def test_load_and_new_world_clear_undo_only_on_success_and_save_does_not(self):
        self.brush("warm")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sandbox.biosphere"
            self.sim.command("save", {"path": str(path)})
            self.assertTrue(self.sim.sandbox.state()["can_undo"])
            for command, data in (("load", {"path": str(path) + ".missing"}), ("world", {"population": 0})):
                with self.assertRaises((ValueError, OSError)):
                    self.sim.command(command, data)
                self.assertTrue(self.sim.sandbox.state()["can_undo"])
            self.sim.command("load", {"path": str(path)})
            self.assertFalse(self.sim.sandbox.state()["can_undo"])
            self.world = self.sim.world
            self.brush("cool")
            self.sim.command("world", {"population": 4})
            self.assertFalse(self.sim.sandbox.state()["can_undo"])

    def test_current_continuation_includes_heat_introductions_and_manual_deaths(self):
        self.brush("erase_life")
        self.brush("spawn_herbivore", count=8)
        self.brush("warm")
        restored, _, _ = persistence.unpack(packed(self.world))
        for _ in range(24):
            self.world.step()
            restored.step()
        self.assertEqual(packed(self.world), packed(restored))
        self.assert_valid()

    def test_v3_migration_preserves_old_arrays_and_has_no_invented_interventions(self):
        old = packed(self.world)
        old["format"] = 3
        for field in ("leaves", "seeds", "observations"):
            old.pop(field, None)
        for record in old["creatures"]:
            for key in ("elongation", "armor", "lineage", "lineage_complete", "foraging", "experience"):
                del record[key]
        for field in ("introduced", "temperature_bias", "moisture", "rain_bias"):
            del old[field]
        del old["death_causes"]["intervention"]
        before = copy.deepcopy(old)
        migrated, _, _ = persistence.unpack(old)
        self.assertEqual(old, before)
        self.assertEqual(migrated.introduced, 0)
        self.assertEqual(migrated.death_causes["intervention"], 0)
        self.assertEqual(migrated.temperature_bias, [0] * (WIDTH * HEIGHT))
        self.assertEqual(migrated.soil, old["soil"])
        self.assertEqual(migrated.canopy, old["canopy"])
        self.assertEqual(migrated.rng.getstate(), self.world.rng.getstate())
        self.assert_valid(migrated)

    def test_current_rejects_invalid_thermal_fields_and_accounting(self):
        good = packed(self.world)
        for field, value in (("introduced", True), ("introduced", -1), ("introduced", 1),
                             ("temperature_bias", []), ("temperature_bias", [float("nan")] * (WIDTH * HEIGHT)),
                             ("temperature_bias", [41] * (WIDTH * HEIGHT)),
                             ("temperature_bias", [False] * (WIDTH * HEIGHT))):
            with self.subTest(field=field), self.assertRaises(ValueError):
                persistence.unpack({**good, field: value})
        bad = copy.deepcopy(good)
        bad["death_causes"]["intervention"] = 1
        with self.assertRaises(ValueError):
            persistence.unpack(bad)

    def test_worker_brush_single_step_and_undo_round_trip(self):
        requests = [("control", {"paused": True}),
                    ("brush", dict(kind="warm", x=40.5, y=24.5, stroke=1)),
                    ("single_step", {}), ("undo", {}), ("quit", {})]
        text = "".join(json.dumps(dict(id=i, command=name, data=data)) + "\n"
                       for i, (name, data) in enumerate(requests))
        result = subprocess.run([sys.executable, str(ROOT / "simulator/worker.py")], input=text,
                                text=True, capture_output=True, cwd=ROOT, timeout=15, check=True)
        packets = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(packets[0], {"type": "ready", "protocol": 10})
        self.assertTrue(all(packet["ok"] for packet in packets[1:]))
        before, painted, stepped, undone = [packet["state"] for packet in packets[1:5]]
        self.assertNotEqual(before["temperature_bias"], painted["temperature_bias"])
        self.assertEqual(stepped["day"], 0.25)
        self.assertTrue(stepped["paused"])
        self.assertEqual(undone, before)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
