import copy
import json
import math
import tempfile
import unittest
from pathlib import Path

from simulator import persistence
from simulator.feeding import advance_forage, efficiencies, food_signal, take_meal
from simulator.runtime import Simulation
from simulator.world import Config, HEIGHT, HIDDEN, INPUTS, WEIGHTS, WIDTH, World


def payload(world):
    return json.loads(json.dumps(persistence.pack(world, True, 1)))


def fixed_brain(eat=10):
    weights = [0.0] * WEIGHTS
    offset = (INPUTS + HIDDEN + 1) * HIDDEN
    weights[offset + 2 * (HIDDEN + 1) + HIDDEN] = eat
    weights[offset + 3 * (HIDDEN + 1) + HIDDEN] = -10
    return weights


def world_and_creature():
    world = World(Config(population=2, predator_ratio=0, mutation=0))
    c = world.creatures[0]
    c.brain = fixed_brain()
    c.energy, c.size = 50, 1
    tile = world.tile(c.x, c.y)
    world.food[tile] = world.leaves[tile] = world.seeds[tile] = world.meat[tile] = 0
    return world, c, tile


class FeedingTests(unittest.TestCase):
    def test_new_stocks_seeded_bounded_and_zero_in_ocean(self):
        a, b = World(Config()), World(Config())
        self.assertEqual(a.leaves, b.leaves)
        self.assertEqual(a.seeds, b.seeds)
        self.assertGreater(sum(a.leaves), 0)
        self.assertGreater(sum(a.seeds), 0)
        for i, height in enumerate(a.elevation):
            self.assertTrue(0 <= a.leaves[i] <= 1 and 0 <= a.seeds[i] <= 1)
            if height <= a.config.sea_level:
                self.assertEqual((a.leaves[i], a.seeds[i]), (0, 0))

    def test_specialization_has_tradeoffs_not_a_universal_bonus(self):
        grass, mixed, leaf = (efficiencies(v) for v in (0, 0.5, 1))
        self.assertGreater(grass[0], mixed[0])
        self.assertGreater(leaf[1], mixed[1])
        self.assertGreater(mixed[2], grass[2])
        self.assertGreater(mixed[2], leaf[2])

    def test_same_patch_selects_different_food_by_inherited_trait(self):
        world, c, tile = world_and_creature()
        for trait, expected in [(0, 'grass'), (1, 'leaves'), (0.5, 'seeds')]:
            c.foraging, c.energy = trait, 50
            world.food[tile] = world.leaves[tile] = world.seeds[tile] = 1
            meal = take_meal(world, c, tile, 0.25)
            self.assertEqual(meal['food'], expected)
            self.assertAlmostEqual(meal['amount'], 0.095)
            self.assertAlmostEqual(c.energy - 50, meal['energy'])
            # Exactly one resource is consumed, never three full meals per step.
            self.assertAlmostEqual(sum((world.food[tile], world.leaves[tile], world.seeds[tile])), 3 - 0.095)

    def test_can_eat_less_preferred_resource_when_preferred_is_empty(self):
        world, c, tile = world_and_creature()
        c.foraging = 0
        world.leaves[tile] = 0.4
        self.assertEqual(take_meal(world, c, tile, 0.25)['food'], 'leaves')

    def test_no_food_no_meal_and_no_energy(self):
        world, c, tile = world_and_creature()
        self.assertIsNone(take_meal(world, c, tile, 0.25))
        self.assertEqual(c.energy, 50)

    def test_meal_cannot_create_biomass_or_overfill_energy(self):
        world, c, tile = world_and_creature()
        c.energy = 184.99
        world.food[tile] = 0.0001
        meal = take_meal(world, c, tile, 0.25)
        self.assertLessEqual(c.energy, 185)
        self.assertAlmostEqual(meal['amount'], 0.0001)
        self.assertEqual(world.food[tile], 0)
        self.assertAlmostEqual(meal['energy'], c.energy - 184.99)

    def test_carnivore_ignores_plants_and_herbivore_ignores_carrion(self):
        world, c, tile = world_and_creature()
        world.food[tile] = world.leaves[tile] = world.seeds[tile] = 1
        c.diet = 'carnivore'
        self.assertEqual(food_signal(world, c, tile), 0)
        self.assertIsNone(take_meal(world, c, tile, 0.25))
        world.meat[tile] = 0.5
        self.assertEqual(take_meal(world, c, tile, 0.25)['food'], 'carrion')
        c.diet = 'herbivore'
        world.food[tile] = world.leaves[tile] = world.seeds[tile] = 0
        self.assertEqual(food_signal(world, c, tile), 0)

    def test_sensors_measure_digestible_food_not_raw_sum(self):
        world, c, tile = world_and_creature()
        world.food[tile] = 0.2
        c.foraging = 0
        grazer = food_signal(world, c, tile)
        c.foraging = 1
        self.assertGreater(grazer, food_signal(world, c, tile))
        world.food[tile] = world.leaves[tile] = world.seeds[tile] = 1
        self.assertEqual(food_signal(world, c, tile), 1)

    def test_drought_and_temperature_reduce_leaf_growth(self):
        args = dict(leaves=0.3, seeds=0.1, cover=0.8, soil=0.7, day=0, dt=1)
        wet = advance_forage(**args, moisture=0.8, temperature=23)
        dry = advance_forage(**args, moisture=0, temperature=23)
        cold = advance_forage(**args, moisture=0.8, temperature=-10)
        self.assertGreater(wet[0], dry[0])
        self.assertGreater(wet[0], cold[0])

    def test_seed_season_and_decay_and_leaf_cost(self):
        args = dict(leaves=0.8, seeds=0, cover=0.8, soil=0.7, moisture=0.8, temperature=23, dt=1)
        peak = advance_forage(**args, day=30)
        trough = advance_forage(**args, day=90)
        self.assertGreater(peak[1], trough[1])
        self.assertLess(peak[0], trough[0])  # Seed production costs leaves.
        empty = advance_forage(0, 0.5, 0, 0, 0, -20, 30, 1)
        self.assertLess(empty[1], 0.5)
        self.assertGreater(empty[2], 0)

    def test_forage_update_bounded_at_extremes(self):
        for leaves in (0, 1):
            for seeds in (0, 1):
                for moisture in (0, 1):
                    values = advance_forage(leaves, seeds, 1, moisture, 1, 45, 30, 0.25)
                    self.assertTrue(all(math.isfinite(v) for v in values))
                    self.assertTrue(0 <= values[0] <= 1 and 0 <= values[1] <= 1)

    def test_founder_variation_and_mutation_zero_inheritance(self):
        world = World(Config(population=20, mutation=0))
        self.assertGreater(len({round(c.foraging, 2) for c in world.creatures}), 5)
        for parent in world.creatures:
            child = world.new_creature(parent.x, parent.y, parent)
            self.assertEqual(child.foraging, parent.foraging)

    def test_mutation_is_seeded_bounded_and_not_a_new_diet(self):
        a = World(Config(population=2, mutation=0.5))
        b = World(Config(population=2, mutation=0.5))
        values = []
        for _ in range(80):
            ca = a.new_creature(a.creatures[0].x, a.creatures[0].y, a.creatures[0])
            cb = b.new_creature(b.creatures[0].x, b.creatures[0].y, b.creatures[0])
            self.assertEqual(ca.foraging, cb.foraging)
            self.assertTrue(0 <= ca.foraging <= 1)
            self.assertEqual(ca.diet, a.creatures[0].diet)
            values.append(ca.foraging)
        self.assertGreater(len(set(values)), 3)

    def test_real_step_records_meal_and_preserves_snapshot_isolation(self):
        world, c, tile = world_and_creature()
        world.leaves[tile], c.foraging = 1, 1
        world.step()
        record = world.observations[c.id]
        self.assertEqual(c.action, 'Ест листву')
        self.assertEqual(record['meal']['food'], 'leaves')
        snapshot = next(v for v in world.snapshot()['creatures'] if v['id'] == c.id)
        self.assertEqual(snapshot['foraging'], 1)
        snapshot['behavior']['meal']['food'] = 'changed'
        self.assertEqual(record['meal']['food'], 'leaves')

    def test_negative_eat_output_does_not_trigger_a_meal(self):
        world, c, tile = world_and_creature()
        c.brain = fixed_brain(eat=-10)
        world.leaves[tile] = 1
        world.step()
        self.assertIsNone(world.observations[c.id]['meal'])

    def test_v6_migration_is_nonmutating_preserves_existing_world_and_rng(self):
        world = World(Config(population=8))
        world.step()
        data = payload(world)
        data['format'] = 6
        del data['leaves'], data['seeds']
        for c in data['creatures']:
            del c['foraging']
        for record in data['observations']:
            del record['meal']
        before = copy.deepcopy(data)
        restored, _, _ = persistence.unpack(data)
        self.assertEqual(data, before)
        self.assertEqual(restored.food, world.food)
        self.assertEqual(restored.rng.getstate(), world.rng.getstate())
        self.assertEqual([c.brain for c in restored.creatures], [c.brain for c in world.creatures])
        self.assertEqual([c.memory for c in restored.creatures], [c.memory for c in world.creatures])
        self.assertEqual(sum(restored.leaves) + sum(restored.seeds), 0)
        self.assertTrue(all(c.foraging == 0 for c in restored.creatures))
        self.assertTrue(all(r['meal'] is None for r in restored.observations.values()))
        restored.step()
        self.assertGreater(sum(restored.leaves), 0)
        self.assertEqual(payload(restored)['format'], 7)

    def test_current_save_and_autocopy_recover_exact_future(self):
        sim = Simulation()
        for _ in range(8):
            sim.command('single_step', {})
        with tempfile.TemporaryDirectory() as root:
            sim.command('autosave', {'directory': root})
            before = payload(sim.world)
            sim.command('single_step', {})
            sim.command('recover', {'directory': root})
            self.assertEqual(payload(sim.world), before)
            path = str(Path(root) / 'manual.biosphere')
            persistence.save(sim.world, True, 1, path)
            other, _, _ = persistence.load(path)
            for _ in range(8):
                sim.world.step()
                other.step()
            self.assertEqual(payload(sim.world), payload(other))

    def test_invalid_stocks_and_trait_and_meal_rejected(self):
        world, c, tile = world_and_creature()
        world.leaves[tile] = 1
        world.step()
        good = payload(world)
        for key, value in [('leaves', []), ('seeds', [float('nan')] * (WIDTH * HEIGHT))]:
            data = copy.deepcopy(good)
            data[key] = value
            with self.assertRaises(ValueError):
                persistence.unpack(data)
        for value in (-0.1, 1.1, True, float('inf')):
            data = copy.deepcopy(good)
            data['creatures'][0]['foraging'] = value
            with self.assertRaises(ValueError):
                persistence.unpack(data)
        for meal in [{'food': 'magic', 'amount': 1, 'energy': 1},
                     {'food': 'grass', 'amount': -1, 'energy': 1},
                     {'food': 'grass', 'amount': 1, 'energy': float('nan')}]:
            data = copy.deepcopy(good)
            data['observations'][0]['meal'] = meal
            with self.assertRaises(ValueError):
                persistence.unpack(data)
        for key in ('leaves', 'seeds'):
            data = copy.deepcopy(good)
            del data[key]
            with self.assertRaises(ValueError):
                persistence.unpack(data)
            data = copy.deepcopy(good)
            ocean = next(i for i in range(WIDTH * HEIGHT) if not world.land(i))
            data[key][ocean] = 0.1
            with self.assertRaises(ValueError):
                persistence.unpack(data)

    def test_plant_dry_flood_and_undo_include_new_stocks(self):
        sim = Simulation()
        c = sim.world.creatures[0]
        tile = sim.world.tile(c.x, c.y)
        before = payload(sim.world)
        sim.command('brush', dict(kind='plant', x=c.x, y=c.y))
        self.assertGreater(sim.world.leaves[tile], before['leaves'][tile])
        sim.command('single_step', {})
        sim.command('undo', {})
        self.assertEqual(payload(sim.world), before)
        sim.world.seeds[tile] = 0.8
        sim.command('brush', dict(kind='dry', x=c.x, y=c.y))
        self.assertLess(sim.world.seeds[tile], 0.8)
        sim.world.elevation[tile] = sim.world.config.sea_level + 0.001
        sim.command('brush', dict(kind='lower', x=c.x, y=c.y, radius=0.75))
        self.assertEqual((sim.world.food[tile], sim.world.leaves[tile], sim.world.seeds[tile]), (0, 0, 0))
        persistence.unpack(payload(sim.world))

    def test_500_feeding_agents_fit_ipc_budget(self):
        world, c, tile = world_and_creature()
        while len(world.creatures) < 500:
            tile2 = world.land_tiles[len(world.creatures) % len(world.land_tiles)]
            newcomer = world.new_creature(tile2 % WIDTH + 0.5, tile2 // WIDTH + 0.5)
            newcomer.brain = fixed_brain()
            world.creatures.append(newcomer)
            world.introduced += 1
        world.refresh_history()
        world.step()
        self.assertLess(len(json.dumps(world.snapshot(), ensure_ascii=True).encode()), 2 * 1024 * 1024 - 16384)


if __name__ == '__main__':
    unittest.main()
