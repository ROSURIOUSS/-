import json
import math
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from simulator.persistence import pack, unpack
from simulator.world import Config, Creature, HEIGHT, WEIGHTS, WIDTH, SpatialIndex, World, sense
from tools.bundle_core import DEFAULT_BUNDLE, ROOT, build_bundle


class PlanetTopologyTests(unittest.TestCase):
    def test_tiles_wrap_at_longitude_but_not_latitude(self):
        world = World(Config(population=2))
        self.assertEqual(world.tile(-0.2, 5), 5 * WIDTH + WIDTH - 1)
        self.assertEqual(world.tile(WIDTH + 0.2, 5), 5 * WIDTH)
        self.assertEqual(world.tile(0, -10), 0)
        self.assertEqual(world.tile(0, HEIGHT + 10), (HEIGHT - 1) * WIDTH)

    def test_perception_and_neighbors_cross_the_seam(self):
        source = Creature(1, 0.2, 10, [0.0] * WEIGHTS, 0.5, 18)
        neighbor = Creature(2, WIDTH - 0.2, 10, [0.0] * WEIGHTS, 0.5, 18)
        index = SpatialIndex([source, neighbor])
        self.assertIs(index.nearest(source, "herbivore", 1), neighbor)
        self.assertLess(sense(source, neighbor)[0], 0)
        self.assertEqual(sense(source, neighbor)[1], 0)

    def test_agent_can_cross_longitude_without_teleporting_to_a_new_world(self):
        world = World(Config(population=2, predator_ratio=0))
        world.elevation = [0.7] * (WIDTH * HEIGHT)
        world.land_tiles = list(range(WIDTH * HEIGHT))
        c = world.creatures[0]
        c.x, c.y = WIDTH - 0.01, HEIGHT / 2
        c.brain = [0.0] * WEIGHTS
        # X output bias, no hidden state needed.
        c.brain[200 + 8] = 10
        identity = c.id
        world.step()
        self.assertLess(c.x, 2)
        self.assertEqual(c.id, identity)
        self.assertIn(c, world.creatures)


class SuccessionTests(unittest.TestCase):
    def worlds(self):
        config = Config(population=2, rainfall=0.9, temperature=22)
        a, b = World(config), World(config)
        for world in (a, b):
            world.creatures.clear()
        tile = next(i for i in a.land_tiles if HEIGHT * 0.35 < i // WIDTH < HEIGHT * 0.65)
        return a, b, tile

    def test_vegetation_and_soil_respond_to_grazing_pressure(self):
        lush, depleted, tile = self.worlds()
        for world in (lush, depleted):
            world.soil[tile] = 0.6
            world.canopy[tile] = 0.6
        lush.food[tile], depleted.food[tile] = 1, 0
        for _ in range(16):
            lush.step()
            depleted.step()
        self.assertGreater(lush.canopy[tile], depleted.canopy[tile])
        self.assertGreater(lush.soil[tile], depleted.soil[tile])

    def test_decomposition_fertilizes_soil(self):
        organic, control, tile = self.worlds()
        organic.meat[tile] = 1
        organic.step()
        control.step()
        self.assertGreater(organic.soil[tile], control.soil[tile])
        self.assertGreater(organic.food[tile], control.food[tile])

    def test_oceans_do_not_grow_forests(self):
        world = World(Config(population=2))
        for _ in range(16):
            world.step()
        for i in range(WIDTH * HEIGHT):
            self.assertTrue(0 <= world.soil[i] <= 1)
            self.assertTrue(0 <= world.canopy[i] <= 1)
            if not world.land(i):
                self.assertEqual(world.soil[i], 0)
                self.assertEqual(world.canopy[i], 0)
                self.assertEqual(world.biome(i), 0)
        state = world.snapshot()
        self.assertEqual(len(state["biomes"]), WIDTH * HEIGHT)
        self.assertLessEqual(state["ecosystem"]["occupied_tiles"], state["population"])

    def test_current_round_trip_preserves_succession(self):
        a = World(Config(population=12))
        for _ in range(24):
            a.step()
        payload = json.loads(json.dumps(pack(a, False, 1)))
        self.assertEqual(payload["format"], 6)
        b, _, _ = unpack(payload)
        for _ in range(24):
            a.step()
            b.step()
        self.assertEqual(a.soil, b.soil)
        self.assertEqual(a.canopy, b.canopy)
        self.assertEqual(a.snapshot(), b.snapshot())

    def test_v2_saves_upgrade_without_losing_neural_state(self):
        world = World(Config(population=2))
        world.step()
        payload = json.loads(json.dumps(pack(world, False, 1)))
        payload["format"] = 2
        for record in payload["creatures"]:
            for key in ("elongation", "armor", "lineage", "lineage_complete"):
                del record[key]
        for key in ("soil", "canopy", "introduced", "temperature_bias", "moisture", "rain_bias"):
            del payload[key]
        del payload["death_causes"]["intervention"]
        restored, _, _ = unpack(payload)
        self.assertEqual(restored.creatures[0].brain, world.creatures[0].brain)
        self.assertEqual(restored.creatures[0].memory, world.creatures[0].memory)
        self.assertEqual(restored.day, world.day)
        self.assertEqual(len(restored.soil), WIDTH * HEIGHT)

    def test_corrupt_succession_data_is_rejected(self):
        data = json.loads(json.dumps(pack(World(Config(population=2)), False, 1)))
        data["soil"][0] = math.nan
        with self.assertRaises(ValueError):
            unpack(data)


class BundledCoreTests(unittest.TestCase):
    def test_bundle_is_reproducible_and_matches_canonical_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            a = build_bundle(Path(directory) / "a.zip")
            b = build_bundle(Path(directory) / "b.zip")
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(a.read_bytes(), DEFAULT_BUNDLE.read_bytes(),
                             "Run python tools/bundle_core.py after editing simulator/")
            with zipfile.ZipFile(a) as archive:
                for source in (ROOT / "simulator").glob("*.py"):
                    self.assertEqual(archive.read("simulator/" + source.name), source.read_bytes())
                self.assertTrue(all(name.startswith("simulator/") and name.endswith(".py")
                                    and ".." not in name for name in archive.namelist()))

    def test_bundled_core_runs_without_repository_or_sibling_simulator(self):
        with tempfile.TemporaryDirectory() as directory:
            with zipfile.ZipFile(DEFAULT_BUNDLE) as archive:
                archive.extractall(directory)
            worker = Path(directory) / "simulator" / "worker.py"
            result = subprocess.run([sys.executable, "-u", str(worker)], cwd=directory,
                                    input=b'{"id":1,"command":"state"}\n{"id":2,"command":"quit"}\n',
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            packets = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(packets[0]["protocol"], 7)
            self.assertTrue(packets[1]["ok"])
            self.assertIn("canopy", packets[1]["state"])
            self.assertIn("ecosystem", packets[1]["state"])
            self.assertIn("lineages", packets[1]["state"])
            self.assertIn("moisture", packets[1]["state"])
            self.assertIn("rain", packets[1]["state"])
            self.assertIn("armor", packets[1]["state"]["creatures"][0])

    def test_exports_include_bundle_and_exclude_dev_scene(self):
        presets = (ROOT / "godot" / "export_presets.cfg").read_text()
        self.assertEqual(presets.count('include_filter="python_core.zip"'), 2)
        self.assertEqual(presets.count('exclude_filter="tests/*"'), 2)


if __name__ == "__main__":
    unittest.main()
