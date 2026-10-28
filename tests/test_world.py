import json
import math
import unittest
from dataclasses import asdict

from simulator.world import Config, HEIGHT, INPUTS, MAX_POPULATION, WEIGHTS, WIDTH, World


class ConfigTests(unittest.TestCase):
    def test_defaults_and_round_trip(self):
        self.assertEqual(Config.parse({}), Config())
        self.assertEqual(Config.parse(asdict(Config())), Config())

    def test_rejects_bad_values(self):
        for values in ({"seed": 10**1000}, {"seed": 1.5}, {"population": True}, {"population": 0},
                       {"temperature": math.nan}, {"rainfall": math.inf},
                       {"mutation": "0.1"}, {"predator_ratio": 0.9}, {"predator_ratio": True}, {"sea_level": 2}, {"unknown": 1}, []):
            with self.subTest(values=values), self.assertRaises(ValueError):
                Config.parse(values)


class WorldTests(unittest.TestCase):
    def test_seed_is_reproducible(self):
        a, b = World(Config(population=12)), World(Config(population=12))
        for _ in range(60):
            a.step()
            b.step()
        self.assertEqual(a.snapshot(), b.snapshot())
        self.assertNotEqual(a.elevation, World(Config(seed=43)).elevation)

    def test_all_spawn_on_land_including_extreme_sea(self):
        for sea in (0.15, 0.42, 0.75):
            for seed in (0, -12, 42):
                with self.subTest(sea=sea, seed=seed):
                    world = World(Config(seed=seed, population=20, sea_level=sea))
                    self.assertTrue(world.land_tiles)
                    self.assertTrue(all(world.land(world.tile(c.x, c.y)) for c in world.creatures))
                    json.dumps(world.snapshot(), allow_nan=False)

    def test_brain_and_inheritance(self):
        world = World(Config(population=2, mutation=0))
        parent = world.creatures[0]
        child = world.new_creature(parent.x, parent.y, parent)
        self.assertEqual(len(parent.brain), WEIGHTS)
        self.assertEqual(len(parent.think([0.5] * INPUTS)), 4)
        self.assertTrue(all(-1 <= v <= 1 for v in parent.think([0.5] * INPUTS)))
        self.assertEqual(child.brain, parent.brain)
        self.assertIsNot(child.brain, parent.brain)
        self.assertEqual(child.parent, parent.id)
        self.assertEqual(child.generation, 2)
        world_mutating = World(Config(population=2, mutation=0.5))
        parent = world_mutating.creatures[0]
        child = world_mutating.new_creature(parent.x, parent.y, parent)
        self.assertNotEqual(parent.brain, child.brain)

    def test_population_evolves_and_invariants_hold(self):
        world = World(Config())
        for _ in range(240):
            world.step()
        self.assertGreater(world.births, 0)
        self.assertGreater(max(c.generation for c in world.creatures), 1)
        self.assertEqual(len(world.creatures), world.config.population + world.births - world.deaths)
        self.assertLessEqual(len(world.creatures), MAX_POPULATION)
        self.assertEqual(len({c.id for c in world.creatures}), len(world.creatures))
        for creature in world.creatures:
            self.assertTrue(0 <= creature.x < WIDTH and 0 <= creature.y < HEIGHT)
            self.assertTrue(world.land(world.tile(creature.x, creature.y)))
            self.assertGreater(creature.energy, 0)
            self.assertEqual(len(creature.brain), WEIGHTS)
        self.assertTrue(all(0 <= f <= 1 for f in world.food))
        self.assertTrue(all(0 <= m <= 3 for m in world.meat))
        self.assertEqual(sum(world.death_causes.values()), world.deaths)
        self.assertLessEqual(sum(c.kills for c in world.creatures), world.death_causes["predation"])
        for c in world.creatures:
            self.assertTrue(0 < c.health <= 100)
            self.assertEqual(len(c.memory), 8)
            self.assertTrue(all(-1 <= v <= 1 for v in c.memory))
        for point in world.history:
            self.assertEqual(point["population"], point["herbivores"] + point["carnivores"])

    def test_extinction_records_once_without_spontaneous_respawn(self):
        world = World(Config(population=2))
        for c in world.creatures:
            c.energy = -100
        world.step()
        self.assertEqual(len(world.creatures), 0)
        self.assertEqual(world.deaths, 2)
        self.assertIn("вымерла", world.events[-1])
        count = len(world.events)
        for _ in range(20):
            world.step()
        self.assertEqual(len(world.events), count)
        self.assertEqual(len(world.creatures), 0)

    def test_snapshot_is_json_and_does_not_expose_brain(self):
        snapshot = World(Config()).snapshot()
        self.assertEqual(len(snapshot["food"]), WIDTH * HEIGHT)
        self.assertNotIn("brain", snapshot["creatures"][0])
        self.assertEqual(json.loads(json.dumps(snapshot, allow_nan=False)), snapshot)

    def test_history_is_bounded(self):
        world = World(Config(population=2))
        world.creatures.clear()
        for _ in range(1000):
            world.step()
        self.assertEqual(len(world.history), 240)
        self.assertEqual(world.history[-1]["day"], 250)


if __name__ == "__main__":
    unittest.main()
