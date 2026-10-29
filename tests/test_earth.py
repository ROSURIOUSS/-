import copy
import json
import tempfile
import unittest
from pathlib import Path

from simulator import persistence
from simulator.earth import END_MYR, RADIUS_M
from simulator.runtime import Simulation
from simulator.world import Config, World


def payload(world):
    return json.loads(json.dumps(persistence.pack(world, True, 1)))


class EarlyEarthTests(unittest.TestCase):
    def test_starts_with_no_invented_life_food_soil_or_deaths(self):
        world = World.early_earth(42)
        self.assertEqual(world.config.population, 0)
        self.assertEqual(world.creatures, [])
        self.assertEqual((world.births, world.deaths, world.introduced, world.next_id), (0, 0, 0, 1))
        for name in ('food', 'leaves', 'seeds', 'meat', 'soil', 'canopy'):
            self.assertEqual(sum(getattr(world, name)), 0)
        state = world.snapshot()
        self.assertEqual(state['earth']['radius_m'], RADIUS_M)
        self.assertEqual(state['earth']['age_myr'], 0)
        self.assertGreater(state['temperature'], 1000)
        self.assertEqual(state['earth']['ocean_percent'], 0)

    def test_cooling_crust_and_water_but_no_scripted_animals_or_plants(self):
        world = World.early_earth()
        temperatures, crust, oceans = [], [], []
        for _ in range(120):
            world.step()
            state = world.snapshot()['earth']
            temperatures.append(state['temperature_c'])
            crust.append(state['solid_fraction'])
            oceans.append(state['ocean_percent'])
            if state['temperature_c'] > 100:
                self.assertEqual(state['ocean_percent'], 0)
            self.assertEqual(world.creatures, [])
            self.assertEqual(sum(world.food) + sum(world.leaves) + sum(world.seeds) + sum(world.soil), 0)
        self.assertEqual(temperatures, sorted(temperatures, reverse=True))
        self.assertEqual(crust, sorted(crust))
        self.assertEqual(oceans, sorted(oceans))
        self.assertGreater(oceans[-1], 70)
        self.assertLess(oceans[-1], 72)
        self.assertTrue(world.snapshot()['earth']['complete'])

    def test_geological_years_are_not_simulated_ecological_days(self):
        world = World.early_earth()
        world.step()
        self.assertEqual(world.earth['age_myr'], 5)
        self.assertEqual(world.day, 0.25)  # Internal clock, labelled as years in native UI.
        self.assertEqual(world.snapshot()['earth']['years_ago_myr'], 4535)

    def test_seeded_scenario_and_observation_does_not_consume_rng(self):
        a, b = World.early_earth(123), World.early_earth(123)
        before = a.rng.getstate()
        for _ in range(3):
            self.assertEqual(a.snapshot(), b.snapshot())
        self.assertEqual(a.rng.getstate(), before)
        for _ in range(60):
            a.step()
            b.step()
        self.assertEqual(payload(a), payload(b))
        self.assertEqual(a.rng.getstate(), before)

    def test_native_command_is_explicit_paused_and_clears_old_undo(self):
        sim = Simulation()
        c = sim.world.creatures[0]
        sim.command('brush', dict(kind='warm', x=c.x, y=c.y))
        self.assertTrue(sim.sandbox.state()['can_undo'])
        sim.command('earth', {'seed': 111})
        self.assertTrue(sim.paused)
        self.assertFalse(sim.sandbox.state()['can_undo'])
        self.assertEqual(sim.world.config.seed, 111)
        self.assertEqual(sim.world.earth['age_myr'], 0)
        sim.command('step', {})
        self.assertEqual(sim.world.earth['age_myr'], 0)
        sim.command('single_step', {})
        self.assertEqual(sim.world.earth['age_myr'], 5)

    def test_invalid_creation_does_not_replace_current_world_or_undo(self):
        sim = Simulation()
        for data in ({'seed': True}, {'seed': 1.2}, {'seed': 2**40}, {'population': 0}, {'temperature': 10}):
            before = sim.state()
            with self.assertRaises(ValueError):
                sim.command('earth', data)
            self.assertEqual(sim.state(), before)
        with self.assertRaises(ValueError):
            sim.command('world', {'population': 0})
        with self.assertRaises(ValueError):
            Config.parse({'population': 0})

    def test_geological_speed_and_stop_at_implemented_boundary(self):
        sim = Simulation()
        sim.command('earth', {})
        sim.command('control', {'paused': False, 'speed': 10})
        sim.command('step', {})
        self.assertEqual(sim.world.earth['age_myr'], 50)
        for _ in range(11):
            sim.command('step', {})
        self.assertEqual(sim.world.earth['age_myr'], END_MYR)
        self.assertTrue(sim.paused)
        before = payload(sim.world)
        sim.command('single_step', {})
        self.assertEqual(payload(sim.world), before)

    def test_no_brush_can_sneak_life_into_geological_mode(self):
        sim = Simulation()
        sim.command('earth', {})
        before = payload(sim.world)
        for kind in ('spawn_herbivore', 'spawn_carnivore', 'plant', 'fertilize', 'warm', 'rain'):
            with self.assertRaises(ValueError):
                sim.command('brush', dict(kind=kind, x=40.5, y=24.5))
        self.assertEqual(payload(sim.world), before)

    def test_geological_snapshot_geometry_and_land_water_agree(self):
        world = World.early_earth()
        for _ in range(80):
            world.step()
        state = world.snapshot()
        self.assertEqual(state['surface_sea_level'], state['earth']['sea_level'])
        self.assertNotEqual(state['surface_sea_level'], state['config']['sea_level'])
        for i, height in enumerate(world.elevation):
            self.assertEqual(world.land(i), height > state['surface_sea_level'])
            self.assertEqual(world.moisture[i], 0 if world.land(i) else 1)
        persistence.unpack(payload(world))

    def test_save_and_autocopy_resume_exact_geological_future(self):
        sim = Simulation()
        sim.command('earth', {'seed': 37})
        for _ in range(65):
            sim.command('single_step', {})
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'ранняя Земля.biosphere')
            persistence.save(sim.world, True, 1, path)
            restored, _, _ = persistence.load(path)
            self.assertEqual(payload(sim.world), payload(restored))
            sim.command('autosave', {'directory': directory})
            record = sim.autosaves['records'][0]
            self.assertEqual(record['earth_age_myr'], 325)
            before = payload(sim.world)
            sim.command('single_step', {})
            sim.command('recover', {'directory': directory})
            self.assertEqual(payload(sim.world), before)
            for _ in range(8):
                sim.world.step()
                restored.step()
            self.assertEqual(payload(sim.world), payload(restored))

    def test_malformed_epoch_clock_and_life_invariant_rejected(self):
        good = payload(World.early_earth())
        for state in ({}, {'format': 1, 'age_myr': True}, {'format': True, 'age_myr': 0},
                      {'format': 1, 'age_myr': -1}, {'format': 1, 'age_myr': 601},
                      {'format': 1, 'age_myr': float('nan')}, {'format': 2, 'age_myr': 0}):
            bad = copy.deepcopy(good)
            bad['earth'] = state
            with self.assertRaises(ValueError):
                persistence.unpack(bad)
        bad = copy.deepcopy(good)
        bad['earth']['age_myr'] = 5
        with self.assertRaises(ValueError):
            persistence.unpack(bad)
        for field in ('food', 'soil', 'leaves', 'temperature_bias'):
            bad = copy.deepcopy(good)
            bad[field][0] = 0.5
            with self.assertRaises(ValueError):
                persistence.unpack(bad)
        bad = copy.deepcopy(good)
        bad['earth'] = None
        with self.assertRaises(ValueError):
            persistence.unpack(bad)  # Normal worlds still cannot have initial population zero.

    def test_legacy_v8_biosphere_keeps_personal_learning_and_is_not_earth(self):
        world = World(Config(population=8))
        for _ in range(3):
            world.step()
        data = payload(world)
        data['format'] = 8
        del data['earth']
        restored, _, _ = persistence.unpack(data)
        self.assertIsNone(restored.earth)
        self.assertEqual(payload(restored), payload(world))
        restored.step()
        world.step()
        self.assertEqual(payload(restored), payload(world))

    def test_return_to_normal_biosphere_keeps_previous_mode_available(self):
        sim = Simulation()
        sim.command('earth', {})
        sim.command('world', {'population': 8})
        self.assertIsNone(sim.world.earth)
        self.assertEqual(len(sim.world.creatures), 8)
        self.assertTrue(all(c.experience['enabled'] for c in sim.world.creatures))


if __name__ == '__main__':
    unittest.main()
