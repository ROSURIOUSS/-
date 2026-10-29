import json
import math
import random
import unittest
from dataclasses import asdict

from simulator.persistence import pack, unpack
from simulator.world import (Config, Creature, HEIGHT, HIDDEN, INPUTS, WEIGHTS,
                             WIDTH, SpatialIndex, World, initial_brain)


def stationary_brain(eat=10.0, reproduce=-10.0):
    weights = [0.0] * WEIGHTS
    output = (INPUTS + HIDDEN + 1) * HIDDEN
    weights[output + 2 * (HIDDEN + 1) + HIDDEN] = eat
    weights[output + 3 * (HIDDEN + 1) + HIDDEN] = reproduce
    return weights


def encounter(population=2):
    world = World(Config(population=population, predator_ratio=0.5))
    tile = world.land_tiles[len(world.land_tiles) // 2]
    for c in world.creatures:
        c.x, c.y = tile % WIDTH + 0.5, tile // WIDTH + 0.5
        c.size = 1.0
        c.ideal_temp = world.local_temperature(c.y)
        c.brain = stationary_brain()
        c.energy = 100
    return world, tile


class EcologyTests(unittest.TestCase):
    def test_initial_ratio_and_zero_predator_option(self):
        mixed = World(Config(population=20, predator_ratio=0.3))
        self.assertEqual(mixed.counts(), {"herbivores": 14, "carnivores": 6})
        plants_only = World(Config(population=20, predator_ratio=0))
        self.assertEqual(plants_only.counts(), {"herbivores": 20, "carnivores": 0})

    def test_predation_is_counted_once_with_two_attackers(self):
        world, tile = encounter(3)
        prey = next(c for c in world.creatures if c.diet == "herbivore")
        prey.health = 10
        world.step()
        self.assertEqual(world.deaths, 1)
        self.assertEqual(world.death_causes["predation"], 1)
        self.assertEqual(sum(c.kills for c in world.creatures), 1)
        self.assertNotIn(prey.id, [c.id for c in world.creatures])
        self.assertGreater(world.meat[tile], 0)
        world.step()
        self.assertEqual(world.deaths, 1)

    def test_carnivores_do_not_eat_plants(self):
        world, _ = encounter()
        for c in world.creatures:
            c.diet = "carnivore"
        world.step()
        self.assertTrue(all(c.energy < 100 for c in world.creatures))
        self.assertEqual(world.death_causes["predation"], 0)

    def test_herbivores_do_not_eat_carcasses(self):
        world, tile = encounter()
        for c in world.creatures:
            c.diet = "herbivore"
        world.meat[tile] = 1
        world.step()
        self.assertAlmostEqual(world.meat[tile], math.exp(-0.025 * 0.25))

    def test_carcass_decay_returns_nutrients(self):
        world = World(Config(population=2))
        world.creatures.clear()
        tile = world.land_tiles[0]
        world.food[tile] = 0
        world.meat[tile] = 1
        world.step()
        self.assertTrue(0 < world.meat[tile] < 1)
        self.assertGreater(world.food[tile], 0)
        for tile in range(WIDTH * HEIGHT):
            if not world.land(tile):
                self.assertEqual(world.food[tile], 0)
                self.assertEqual(world.meat[tile], 0)

    def test_old_age_has_its_own_death_cause(self):
        world, _ = encounter()
        for c in world.creatures:
            c.diet = "herbivore"
            c.age = 220
        world.step()
        self.assertEqual(world.death_causes["age"], 2)
        self.assertEqual(world.death_causes["starvation"], 0)
        self.assertEqual(len(world.creatures), 0)

    def test_injured_organism_cannot_reproduce(self):
        world, _ = encounter()
        for c in world.creatures:
            c.diet = "herbivore"
            c.health, c.energy, c.age = 40, 180, 20
            c.brain = stationary_brain(reproduce=10)
        world.step()
        self.assertEqual(world.births, 0)

    def test_mutation_zero_preserves_genes_but_not_lifetime_state(self):
        world = World(Config(population=2, mutation=0))
        parent = world.creatures[0]
        parent.think([0.5] * INPUTS)
        parent.health = 60
        child = world.new_creature(parent.x, parent.y, parent)
        for field in ("brain", "diet", "speed", "size", "vision", "ideal_temp", "hue", "elongation", "armor", "lineage", "lineage_complete"):
            self.assertEqual(getattr(parent, field), getattr(child, field))
        self.assertEqual(child.memory, [0.0] * HIDDEN)
        self.assertIsNot(child.memory, parent.memory)
        self.assertEqual(child.health, 100)
        self.assertEqual(child.kills, 0)

    def test_seeded_instincts_exist_as_network_weights(self):
        world = World(Config(population=2))
        c = world.creatures[0]
        c.brain = initial_brain(random.Random(42), "herbivore")
        inputs = [0.0] * INPUTS
        inputs[14] = 0.8  # Threat to the right.
        self.assertLess(c.think(inputs)[0], 0)
        c.brain = initial_brain(random.Random(42), "carnivore")
        c.memory = [0.0] * HIDDEN
        inputs[14], inputs[12] = 0, 0.8  # Prey to the right.
        self.assertGreater(c.think(inputs)[0], 0)

    def test_recurrent_state_really_changes_next_decision(self):
        world = World(Config(population=2))
        c = world.creatures[0]
        c.brain = [0.0] * WEIGHTS
        c.brain[0] = 1  # First input -> first hidden neuron.
        c.brain[INPUTS] = 0.8  # Previous first hidden neuron -> itself.
        c.brain[(INPUTS + HIDDEN + 1) * HIDDEN] = 1  # First hidden -> X output.
        c.think([1.0] + [0.0] * (INPUTS - 1))
        remembered = c.think([0.0] * INPUTS)[0]
        c.memory = [0.0] * HIDDEN
        blank = c.think([0.0] * INPUTS)[0]
        self.assertGreater(remembered, blank)
        self.assertEqual(blank, 0)


class SpatialIndexTests(unittest.TestCase):
    def creature(self, identity, x, y):
        return Creature(identity, x, y, [0.0] * WEIGHTS, 0.5, 18)

    def test_ties_boundary_move_and_dead_candidates(self):
        source = self.creature(3, 4, 4)
        left, right = self.creature(1, 1, 4), self.creature(2, 7, 4)
        index = SpatialIndex([source, right, left])
        self.assertIs(index.nearest(source, "herbivore", 3), left)
        left.health = 0
        self.assertIs(index.nearest(source, "herbivore", 3), right)
        old = index.key(right.x, right.y)
        right.x = 30
        index.move(right, old)
        self.assertIsNone(index.nearest(source, "herbivore", 3))

    def test_matches_brute_force(self):
        rng = random.Random(5)
        creatures = [self.creature(i, rng.uniform(0, WIDTH), rng.uniform(0, HEIGHT)) for i in range(120)]
        index = SpatialIndex(creatures)
        for source in creatures:
            radius = rng.uniform(3, 12)
            candidates = [c for c in creatures if c is not source and math.hypot(((c.x-source.x + WIDTH/2) % WIDTH) - WIDTH/2, c.y-source.y) <= radius]
            expected = min(candidates, key=lambda c: ((((c.x-source.x + WIDTH/2) % WIDTH) - WIDTH/2)**2 + (c.y-source.y)**2, c.id), default=None)
            self.assertIs(index.nearest(source, "herbivore", radius), expected)


class SaveCompatibilityTests(unittest.TestCase):
    def test_new_state_round_trip_and_exact_future(self):
        world = World(Config(population=20))
        for _ in range(32):
            world.step()
        data = json.loads(json.dumps(pack(world, True, 5)))
        self.assertEqual(data["format"], 6)
        restored, paused, speed = unpack(data)
        self.assertTrue(paused)
        self.assertEqual(speed, 5)
        for _ in range(32):
            world.step()
            restored.step()
        self.assertEqual(world.snapshot(), restored.snapshot())
        self.assertEqual([asdict(c) for c in world.creatures], [asdict(c) for c in restored.creatures])

    def test_save_after_a_kill_preserves_carcasses_and_counters(self):
        world, _ = encounter(3)
        prey = next(c for c in world.creatures if c.diet == "herbivore")
        prey.health = 10
        world.step()
        self.assertEqual(world.death_causes["predation"], 1)
        self.assertGreater(sum(world.meat), 0)
        restored, _, _ = unpack(json.loads(json.dumps(pack(world, False, 1))))
        self.assertEqual(world.snapshot(), restored.snapshot())
        for _ in range(16):
            world.step()
            restored.step()
        self.assertEqual(world.snapshot(), restored.snapshot())

    def test_v1_migration_preserves_original_feed_forward_computation(self):
        world = World(Config(population=2, predator_ratio=0))
        data = json.loads(json.dumps(pack(world, False, 1)))
        data["format"] = 1
        for key in ("meat", "death_causes", "soil", "canopy", "introduced", "temperature_bias", "moisture", "rain_bias"):
            del data[key]
        del data["config"]["predator_ratio"]
        for point in data["history"]:
            del point["herbivores"], point["carnivores"]
        extra = ("diet", "speed", "size", "vision", "health", "kills", "memory",
                 "elongation", "armor", "lineage", "lineage_complete")
        legacy_weights = [math.sin(i) * 0.3 for i in range(140)]
        for record in data["creatures"]:
            for key in extra:
                del record[key]
            record["brain"] = legacy_weights.copy()
        original = json.dumps(data)
        restored, _, _ = unpack(data)
        self.assertEqual(json.dumps(data), original)  # No in-place mutation of supplied save.
        self.assertEqual(restored.counts()["carnivores"], 0)
        self.assertEqual(restored.config.predator_ratio, 0)
        c = restored.creatures[0]
        inputs = [0.3] * 12
        hidden = [math.tanh(sum(inputs[j] * legacy_weights[n*13+j] for j in range(12)) + legacy_weights[n*13+12]) for n in range(8)]
        expected = [math.tanh(sum(hidden[j]*legacy_weights[104+n*9+j] for j in range(8)) + legacy_weights[104+n*9+8]) for n in range(4)]
        for _ in range(2):
            output = c.think(inputs + [0.9] * 4)
            for actual, wanted in zip(output, expected):
                self.assertAlmostEqual(actual, wanted)

    def test_rejects_corrupt_new_ecology_fields(self):
        import copy
        data = json.loads(json.dumps(pack(World(Config(population=2)), False, 1)))
        for key, value in (("memory", []), ("memory", [float("inf")] * HIDDEN),
                           ("diet", "dragon"), ("vision", 900), ("speed", 0),
                           ("health", -1), ("size", 100), ("kills", 5)):
            bad = copy.deepcopy(data)
            bad["creatures"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                unpack(bad)
        for key, value in (("meat", []), ("death_causes", {"predation": 0})):
            bad = copy.deepcopy(data)
            bad[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                unpack(bad)
        bad = copy.deepcopy(data)
        del bad["creatures"][0]["memory"]
        with self.assertRaises(ValueError):
            unpack(bad)


if __name__ == "__main__":
    unittest.main()
