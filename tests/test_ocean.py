import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from simulator import ocean, persistence
from simulator.runtime import Simulation
from simulator.world import World


def cooled(seed=42):
    world = World.early_earth(seed)
    for _ in range(120):
        world.step()
    return world


def microcosm(seed=42):
    world = cooled(seed)
    world.ocean = ocean.new_ocean(world)
    return world


def payload(world):
    return json.loads(json.dumps(persistence.pack(world, True, 1)))


def controlled(world, energy=40):
    cell = world.ocean['cells'][0]
    cell.brain = [0.0] * 236
    cell.experience['enabled'] = False
    cell.energy = energy
    return cell


class OceanTests(unittest.TestCase):
    def test_no_silent_first_cell_after_cooling(self):
        world = cooled()
        for _ in range(8):
            world.step()
        self.assertIsNone(world.ocean)
        self.assertEqual(world.creatures, [])

    def test_explicit_creation_pauses_and_uses_real_wet_anchor(self):
        sim = Simulation()
        sim.world = cooled()
        sim.command('ocean_begin', {})
        state = sim.world.ocean
        self.assertTrue(sim.paused)
        self.assertFalse(sim.sandbox.state()['can_undo'])
        self.assertEqual((len(state['cells']), state['births'], state['deaths']), (1, 0, 0))
        self.assertFalse(sim.world.land(state['anchor']))
        self.assertEqual(state['cells'][0].diameter_um, 4)
        self.assertEqual(state['hours'], 0)
        self.assertEqual((ocean.WIDTH_UM, ocean.HEIGHT_UM), (400, 240))
        self.assertIn('не получена', sim.world.events[-1])

    def test_invalid_begin_is_atomic_including_rng(self):
        sim = Simulation()
        for world in (sim.world, World.early_earth(), microcosm()):
            sim.world = world
            before = payload(world)
            with self.assertRaises(ValueError):
                sim.command('ocean_begin', {})
            self.assertEqual(payload(world), before)
        sim.world = cooled()
        before = payload(sim.world)
        with self.assertRaises(ValueError):
            sim.command('ocean_begin', {'population': 20})
        self.assertEqual(payload(sim.world), before)

    def test_biological_clock_runs_without_moving_geological_clock(self):
        sim = Simulation()
        sim.world = microcosm()
        sim.command('control', {'paused': False, 'speed': 10})
        sim.command('step', {})
        self.assertFalse(sim.paused)
        self.assertEqual((sim.world.day, sim.world.earth['age_myr']), (30, 600))
        self.assertEqual(sim.world.ocean['hours'], 2.5)
        sim.command('single_step', {})
        self.assertTrue(sim.paused)
        self.assertEqual(sim.world.ocean['hours'], 2.75)
        self.assertFalse(sim.state()['earth']['complete'])
        self.assertTrue(sim.world._earth_surface['complete'])

    def test_land_ecosystem_stays_empty_and_brushes_remain_locked(self):
        sim = Simulation()
        sim.world = microcosm()
        for _ in range(200):
            sim.world.step()
        self.assertEqual(sim.world.creatures, [])
        self.assertEqual((sim.world.births, sim.world.deaths, sim.world.introduced), (0, 0, 0))
        for name in ('food', 'leaves', 'seeds', 'meat', 'soil', 'canopy'):
            self.assertEqual(sum(getattr(sim.world, name)), 0)
        with self.assertRaises(ValueError):
            sim.command('brush', {'kind': 'spawn_herbivore', 'x': 40, 'y': 24})
        persistence.unpack(payload(sim.world))

    def test_real_nutrient_uptake_and_metabolic_cost(self):
        world = microcosm()
        cell = controlled(world)
        world.ocean['feed_rate'] = 0
        before = sum(world.ocean['nutrients'])
        factor = max(0.05, 1 - abs(world.temperature - 23) / 35)
        world.step()
        absorbed = 0.25 * 0.075 * factor
        self.assertAlmostEqual(cell.absorbed, absorbed)
        self.assertAlmostEqual(before - sum(world.ocean['nutrients']), absorbed)
        self.assertAlmostEqual(cell.energy, 40 + 100 * absorbed - 0.25 * 0.95)
        self.assertEqual(len(cell.inputs), 16)
        self.assertEqual(len(cell.outputs), 4)

    def test_network_outputs_actually_gate_absorption(self):
        world = microcosm()
        cell = controlled(world)
        cell.brain[226] = -4
        world.step()
        self.assertEqual(cell.absorbed, 0)
        self.assertLess(cell.energy, 40)

    def test_division_conserves_energy_and_equivalent_volume(self):
        world = microcosm()
        cell = controlled(world, 100)
        cell.age = 2
        world.ocean['hours'] = 2
        world.step()
        mother, child = world.ocean['cells']
        available = 100 + cell.absorbed * 100 - 0.25 * 0.95
        self.assertEqual(world.ocean['births'], 1)
        self.assertEqual(mother.energy, child.energy)
        self.assertAlmostEqual(mother.energy + child.energy, available)
        self.assertAlmostEqual(mother.diameter_um**3 + child.diameter_um**3, 4**3 * available / 40)
        self.assertEqual((child.parent, child.generation, child.age), (1, 2, 0))
        self.assertNotEqual(mother.brain, child.brain)

    def test_newborn_has_private_reset_lifetime_learning(self):
        world = microcosm()
        cell = world.ocean['cells'][0]
        cell.energy, cell.age = 100, 2
        cell.brain[235] = 3
        world.ocean['hours'] = 2
        cell.experience['weights'][0] = 0.8
        world.step()
        self.assertEqual(len(world.ocean['cells']), 2)
        parent, child = world.ocean['cells']
        self.assertEqual(child.experience['updates'], 0)
        self.assertEqual(sum(abs(v) for v in child.experience['weights']), 0)
        self.assertEqual(child.memory, [0] * 8)
        self.assertIsNot(parent.brain, child.brain)
        self.assertIsNot(parent.memory, child.memory)
        self.assertIsNot(parent.experience['weights'], child.experience['weights'])
        self.assertEqual(parent.experience['updates'], 1)

    def test_individual_weights_change_but_lifetime_genome_does_not(self):
        world = microcosm()
        cell = world.ocean['cells'][0]
        genome = cell.brain.copy()
        for _ in range(20):
            world.step()
        self.assertEqual(cell.brain, genome)
        self.assertEqual(cell.experience['updates'], 20)
        self.assertGreater(sum(abs(v) for v in cell.experience['weights']), 0)
        self.assertGreater(sum(abs(v) for v in cell.memory), 0)

    def test_extinction_never_causes_respawn(self):
        world = microcosm()
        cell = controlled(world, 1.01)
        world.ocean['nutrients'] = [0.0] * (ocean.COLS * ocean.ROWS)
        world.ocean['feed_rate'] = 0
        world.step()
        self.assertEqual(world.ocean['deaths'], 1)
        self.assertEqual(world.ocean['cells'], [])
        world.ocean['feed_rate'] = 1
        for _ in range(40):
            world.step()
        self.assertEqual(world.ocean['cells'], [])
        self.assertEqual(world.ocean['next_id'], 2)
        persistence.unpack(payload(world))

    def test_population_limit_bounds_and_birth_death_balance(self):
        world = microcosm()
        for _ in range(500):
            world.step()
            state = world.ocean
            self.assertLessEqual(len(state['cells']), ocean.MAX_CELLS)
            self.assertEqual(len(state['cells']), 1 + state['births'] - state['deaths'])
            for cell in state['cells']:
                radius = cell.diameter_um / 2
                self.assertTrue(radius <= cell.x <= ocean.WIDTH_UM - radius)
                self.assertTrue(radius <= cell.y <= ocean.HEIGHT_UM - radius)
        self.assertGreater(world.ocean['births'], 1)
        self.assertGreater(world.ocean['deaths'], 0)
        persistence.unpack(payload(world))

    def test_snapshots_are_read_only_and_do_not_draw_global_animals(self):
        world = microcosm()
        before = payload(world)
        state = world.snapshot()
        state['ocean']['cells'][0]['memory'][0] = 1
        state['ocean']['nutrients'][0] = 0
        state['ocean']['history'][0]['population'] = 99
        self.assertEqual(payload(world), before)
        self.assertEqual(state['population'], 0)
        self.assertEqual(state['creatures'], [])
        self.assertNotIn('brain', state['ocean']['cells'][0])

    def test_seeded_future_and_save_resume_are_exact(self):
        world, other = microcosm(37), microcosm(37)
        for _ in range(220):
            world.step()
            other.step()
        self.assertEqual(payload(world), payload(other))
        restored, paused, speed = persistence.unpack(payload(world))
        self.assertTrue(paused)
        self.assertEqual(speed, 1)
        self.assertEqual(payload(restored), payload(world))
        for _ in range(20):
            world.step()
            restored.step()
        self.assertEqual(payload(restored), payload(world))
        self.assertLess(len(json.dumps(world.snapshot()).encode()), 2 * 1024 * 1024)

    def test_feed_control_is_validated_without_partial_mutation(self):
        sim = Simulation()
        sim.world = microcosm()
        for rate in (True, -1, 1.01, float('nan'), float('inf'), '0.1'):
            before = payload(sim.world)
            with self.assertRaises(ValueError):
                sim.command('ocean_feed', {'rate': rate})
            self.assertEqual(payload(sim.world), before)
        sim.command('ocean_feed', {'rate': 0})
        self.assertEqual(sim.world.ocean['feed_rate'], 0)
        with self.assertRaises(ValueError):
            sim.command('ocean_feed', {'rate': 1, 'hidden': True})
        sim.command('world', {'population': 8})
        with self.assertRaises(ValueError):
            sim.command('ocean_feed', {'rate': 1})
        self.assertIsNone(sim.world.ocean)

    def test_autocopies_include_biological_clock_and_resume_exactly(self):
        sim = Simulation()
        sim.world = microcosm()
        for _ in range(12):
            sim.world.step()
        before = payload(sim.world)
        with tempfile.TemporaryDirectory() as directory:
            message = sim.command('autosave', {'directory': directory})
            self.assertIn('3.00 ч', message)
            record = sim.autosaves['records'][0]
            self.assertEqual(record['ocean_hours'], 3)
            self.assertEqual(record['population'], len(sim.world.ocean['cells']))
            sim.world.step()
            message = sim.command('recover', {'directory': directory})
            self.assertIn('3.00 ч', message)
            self.assertTrue(sim.paused)
            self.assertEqual(payload(sim.world), before)

    def test_legacy_v9_has_no_invented_ocean(self):
        world = cooled()
        data = payload(world)
        data['format'] = 9
        del data['ocean']
        restored, _, _ = persistence.unpack(data)
        self.assertIsNone(restored.ocean)
        self.assertEqual(payload(restored), payload(world))

    def test_corrupt_ocean_state_is_rejected(self):
        good = payload(microcosm())
        changes = [('format', True), ('format', 2), ('hours', True), ('hours', float('nan')),
                   ('feed_rate', -1), ('births', 1), ('deaths', 1), ('next_id', 5),
                   ('nutrients', []), ('cells', {}), ('history', [])]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                data = copy.deepcopy(good)
                data['ocean'][key] = value
                with self.assertRaises(ValueError):
                    persistence.unpack(data)
        data = copy.deepcopy(good)
        world = cooled()
        data['ocean']['anchor'] = next(i for i in range(len(data['elevation'])) if world.land(i))
        with self.assertRaises(ValueError):
            persistence.unpack(data)
        data = copy.deepcopy(good)
        data['earth']['age_myr'] = 0
        data['day'] = 0
        with self.assertRaises(ValueError):
            persistence.unpack(data)

    def test_corrupt_cell_and_neural_state_are_rejected(self):
        good = payload(microcosm())
        for key, value in [('id', True), ('x', -1), ('y', 241), ('energy', 0), ('age', 1),
                           ('generation', 2), ('parent', 1), ('threshold', 1), ('metabolism', 3),
                           ('brain', [0]), ('memory', [0]), ('inputs', None), ('outputs', [True] * 4),
                           ('absorbed', float('nan')), ('action', 'Fake action'), ('experience', {})]:
            with self.subTest(key=key):
                data = copy.deepcopy(good)
                data['ocean']['cells'][0][key] = value
                with self.assertRaises(ValueError):
                    persistence.unpack(data)
        data = copy.deepcopy(good)
        data['ocean']['cells'].append(copy.deepcopy(data['ocean']['cells'][0]))
        data['ocean'].update(births=1, next_id=3)
        with self.assertRaises(ValueError):
            persistence.unpack(data)

    def test_worker_executes_first_cell_command_with_correct_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'cold.biosphere')
            persistence.save(cooled(), True, 1, path)
            commands = [('load', {'path': path}), ('ocean_begin', {}), ('single_step', {}),
                        ('ocean_feed', {'rate': 0}), ('ocean_begin', {})]
            requests = ''.join(json.dumps(dict(id=i, command=c, data=d)) + '\n' for i, (c, d) in enumerate(commands))
            result = subprocess.run([sys.executable, '-m', 'simulator.worker'], input=requests, text=True,
                                    capture_output=True, timeout=20, check=True)
        packets = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(packets[0], {'type': 'ready', 'protocol': 12})
        self.assertEqual([p['ok'] for p in packets[1:]], [True, True, True, True, False])
        self.assertEqual(packets[3]['state']['ocean']['hours'], 0.25)
        self.assertEqual(packets[3]['state']['ocean']['cells'][0]['intelligence']['updates'], 1)
        self.assertEqual(packets[4]['state']['ocean']['feed_rate'], 0)


if __name__ == '__main__':
    unittest.main()
