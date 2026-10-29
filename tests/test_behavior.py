import copy
import json
import math
import unittest
from unittest.mock import patch

from simulator import persistence
from simulator.runtime import Simulation
from simulator.world import Config, Creature, HIDDEN, INPUTS, WEIGHTS, WIDTH, HEIGHT, World, wrapped_dx


def flat_world():
    world = World(Config(population=2, predator_ratio=0.5, mutation=0))
    world.elevation = [0.6] * (WIDTH * HEIGHT)
    world.land_tiles = list(range(WIDTH * HEIGHT))
    world.food = [0.5] * (WIDTH * HEIGHT)
    world.meat = [0.0] * (WIDTH * HEIGHT)
    world.soil = [0.5] * (WIDTH * HEIGHT)
    world.canopy = [0.0] * (WIDTH * HEIGHT)
    world.moisture = [0.5] * (WIDTH * HEIGHT)
    world.rain_bias = [0.0] * (WIDTH * HEIGHT)
    world.refresh_weather()
    for i, c in enumerate(world.creatures):
        c.x, c.y = 10.5 + i * 3, 12.5
    return world


def controller(x=0, y=0, eat=-10, reproduce=-10):
    weights = [0.0] * WEIGHTS
    offset = (INPUTS + HIDDEN + 1) * HIDDEN
    for i, value in enumerate((x, y, eat, reproduce)):
        weights[offset + i * (HIDDEN + 1) + HIDDEN] = value
    return weights


def payload(world):
    return json.loads(json.dumps(persistence.pack(world, True, 1)))


class BehaviorTests(unittest.TestCase):
    def test_no_invented_observation_before_first_step(self):
        world = flat_world()
        self.assertTrue(all(c['behavior'] is None for c in world.snapshot()['creatures']))

    def test_reports_actual_network_call_and_real_displacement(self):
        world = flat_world()
        captured = {}
        before = {c.id: (c.x, c.y) for c in world.creatures}
        original = Creature.think
        def observe(c, inputs):
            outputs = original(c, inputs)
            captured[c.id] = (list(inputs), list(outputs), list(c.memory))
            return outputs
        with patch.object(Creature, 'think', observe):
            world.step()
        for c in world.creatures:
            record = world.observations[c.id]
            inputs, outputs, memory = captured[c.id]
            self.assertEqual(record['inputs'], inputs)
            self.assertEqual(record['outputs'], outputs)
            self.assertEqual(memory, c.memory)
            x, y = before[c.id]
            self.assertAlmostEqual(record['velocity'][0], wrapped_dx(c.x, x) / 0.25)
            self.assertAlmostEqual(record['velocity'][1], (c.y - y) / 0.25)
            self.assertEqual((record['day'], record['dt']), (world.day, 0.25))
            self.assertEqual(len(inputs), 16)
            self.assertEqual(len(outputs), 4)

    def test_targets_are_seen_at_decision_not_an_invented_goal(self):
        world = flat_world()
        for c in world.creatures:
            c.brain = controller()
        world.step()
        for c in world.creatures:
            record = world.observations[c.id]
            other = next(o for o in world.creatures if o is not c)
            key = 'prey' if c.diet == 'carnivore' else 'threat'
            self.assertEqual(record[key], other.id)
            self.assertEqual(record['threat' if key == 'prey' else 'prey'], None)
            # Merely seeing a target does not mean moving toward/away from it.
            self.assertEqual(c.action, 'Ищет пищу')

    def test_labels_use_motion_direction(self):
        for prey_moves, predator_moves, expected_prey, expected_predator in [
            (1, 1, 'Спасается', 'Охотится'),
            (-1, -1, 'Ищет пищу', 'Ищет пищу'),
        ]:
            world = flat_world()
            hunter = next(c for c in world.creatures if c.diet == 'carnivore')
            prey = next(c for c in world.creatures if c.diet == 'herbivore')
            hunter.x, prey.x = 10.5, 13.5
            hunter.brain, prey.brain = controller(x=predator_moves), controller(x=prey_moves)
            world.step()
            self.assertEqual(prey.action, expected_prey)
            self.assertEqual(hunter.action, expected_predator)

    def test_no_targets_outside_vision(self):
        world = flat_world()
        world.creatures[1].x = 40.5
        world.step()
        self.assertTrue(all(r['prey'] is None and r['threat'] is None for r in world.observations.values()))

    def test_blocked_command_does_not_report_motion(self):
        world = flat_world()
        c = world.creatures[0]
        c.brain = controller(x=10)
        c.x = 10.99
        destination = world.tile(c.x + math.tanh(10) * 0.25 * 2.4 * c.mobility, c.y)
        world.elevation[destination] = 0.0
        world.food[destination] = world.meat[destination] = world.soil[destination] = world.canopy[destination] = 0.0
        world.moisture[destination] = 1.0
        world.land_tiles.remove(destination)
        world.step()
        record = world.observations[c.id]
        self.assertTrue(record['blocked'])
        self.assertGreater(record['outputs'][0], 0.99)
        self.assertEqual(record['velocity'], [0.0, 0.0])

    def test_seam_velocity_is_short_path_not_planet_width(self):
        world = flat_world()
        c = world.creatures[0]
        c.x, c.brain = WIDTH - 0.01, controller(x=10)
        world.step()
        self.assertLess(c.x, 2)
        self.assertAlmostEqual(world.observations[c.id]['velocity'][0], math.tanh(10) * 2.4 * c.mobility)

    def test_snapshot_does_not_advance_rng_or_share_mutable_vectors(self):
        world = flat_world()
        world.step()
        rng = world.rng.getstate()
        before = copy.deepcopy(world.observations)
        state = world.snapshot()
        for c in state['creatures']:
            c['behavior']['inputs'][0] = 99
        self.assertEqual(world.observations, before)
        self.assertEqual(world.rng.getstate(), rng)

    def test_newborn_has_no_fake_decision_and_dead_records_are_pruned(self):
        world = flat_world()
        parent = world.creatures[0]
        parent.age, parent.energy, parent.brain = 13, 180, controller(reproduce=10)
        world.step()
        children = [c for c in world.snapshot()['creatures'] if c['parent'] == parent.id]
        self.assertTrue(children)
        self.assertTrue(all(c['behavior'] is None for c in children))
        for c in world.creatures:
            c.energy = 0.001
            c.brain = controller()
        world.step()
        self.assertEqual(world.observations, {})

    def test_optional_metadata_roundtrip_and_old_save(self):
        world = flat_world()
        world.step()
        data = payload(world)
        restored, _, _ = persistence.unpack(copy.deepcopy(data))
        self.assertEqual(restored.snapshot(), world.snapshot())
        for _ in range(4):
            restored.step()
            world.step()
        self.assertEqual(restored.snapshot(), world.snapshot())
        del data['observations']
        old, _, _ = persistence.unpack(data)
        self.assertTrue(all(c['behavior'] is None for c in old.snapshot()['creatures']))
        old.step()
        self.assertTrue(old.observations)

    def test_malformed_metadata_is_rejected(self):
        world = flat_world()
        world.step()
        good = payload(world)
        changes = [('inputs', [0]), ('outputs', [0, 0, 0, 2]), ('velocity', [float('nan'), 0]),
                   ('day', world.day + 1), ('dt', 0), ('blocked', 1), ('prey', True),
                   ('threat', -1), ('id', True)]
        for key, value in changes:
            with self.subTest(key=key):
                bad = copy.deepcopy(good)
                bad['observations'][0][key] = value
                with self.assertRaises(ValueError):
                    persistence.unpack(bad)
        for records in [None, {}, good['observations'] + good['observations'][:1],
                        [good['observations'][0], good['observations'][0]]]:
            bad = copy.deepcopy(good)
            bad['observations'] = records
            with self.assertRaises(ValueError):
                persistence.unpack(bad)

    def test_undo_preserves_last_decision(self):
        sim = Simulation()
        sim.command('single_step', {})
        before = sim.world.snapshot()
        c = sim.world.creatures[0]
        sim.command('brush', dict(kind='warm', x=c.x, y=c.y))
        sim.command('single_step', {})
        sim.command('undo', {})
        self.assertEqual(sim.world.snapshot(), before)

    def test_500_observed_creatures_stay_below_ipc_limit(self):
        world = flat_world()
        while len(world.creatures) < 500:
            c = world.new_creature(10.5, 12.5)
            c.brain = controller()
            world.creatures.append(c)
            world.introduced += 1
        for c in world.creatures:
            c.brain = controller()
        world.refresh_history()
        world.step()
        self.assertEqual(len(world.observations), 500)
        self.assertLess(len(json.dumps(world.snapshot(), ensure_ascii=True).encode()), 2 * 1024 * 1024 - 16384)


if __name__ == '__main__':
    unittest.main()
