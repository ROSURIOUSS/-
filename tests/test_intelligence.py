import copy
import json
import math
import random
import tempfile
import unittest
from pathlib import Path

from simulator import persistence
from simulator.intelligence import act, learn, new_experience, outcome_reward, summary, validate_experience
from simulator.runtime import Simulation
from simulator.world import Config, HEIGHT, HIDDEN, INPUTS, MAX_POPULATION, WEIGHTS, WIDTH, World
from unittest.mock import patch


def payload(world):
    return json.loads(json.dumps(persistence.pack(world, True, 1)))


def train_direction(target, seed=1, iterations=2000):
    state = new_experience()
    rng = random.Random(seed)
    for _ in range(iterations):
        inputs = [0.0] * INPUTS
        inputs[1], inputs[11] = 0.6, rng.uniform(-1, 1)
        output = act(state, inputs, [0.0] * HIDDEN, [0.0] * 4)
        learn(state, 1 - abs(output[0] - target))
    state['enabled'] = False
    return state


class IndividualIntelligenceTests(unittest.TestCase):
    def test_every_founder_and_newcomer_has_private_learning_state(self):
        sim = Simulation()
        sim.command('world', {'population': 30, 'predator_ratio': 0.5})
        self.assertTrue(all(c.experience['enabled'] for c in sim.world.creatures))
        first, second = sim.world.creatures[:2]
        self.assertIsNot(first.experience, second.experience)
        self.assertIsNot(first.experience['weights'], second.experience['weights'])
        first.experience['weights'][0] = 0.5
        self.assertEqual(second.experience['weights'][0], 0)
        tile = sim.world.land_tiles[0]
        sim.command('brush', dict(kind='spawn_herbivore', x=tile % 80 + 0.5, y=tile // 80 + 0.5))
        newcomer = max(sim.world.creatures, key=lambda c: c.id)
        self.assertTrue(newcomer.experience['enabled'])
        self.assertEqual(newcomer.experience['updates'], 0)

    def test_real_world_learns_without_overwriting_inherited_genomes(self):
        world = World(Config(population=12))
        brains = {c.id: c.brain.copy() for c in world.creatures}
        for _ in range(12):
            world.step()
        self.assertTrue(any(summary(c.experience)['adaptation'] > 0 for c in world.creatures))
        for c in world.creatures:
            if c.id in brains:
                self.assertEqual(c.brain, brains[c.id])
                self.assertEqual(c.experience['updates'], 12)
            self.assertEqual(c.experience['trace'], [])

    def test_child_inherits_genes_but_not_parent_learned_experience(self):
        world = World(Config(population=2, mutation=0))
        parent = world.creatures[0]
        parent.experience = train_direction(0.6)
        parent.think([0.3] * INPUTS)
        child = world.new_creature(parent.x, parent.y, parent)
        self.assertEqual(child.brain, parent.brain)
        self.assertEqual(child.memory, [0.0] * HIDDEN)
        self.assertEqual(child.experience, new_experience())
        self.assertIsNot(child.experience['weights'], parent.experience['weights'])

    def test_no_exploration_before_first_feedback_and_frozen_mode_preserves_instinct(self):
        state = new_experience()
        inputs = [0.2] * INPUTS
        logits = [0.3, -0.2, 0.8, 0.4]
        self.assertEqual(act(state, inputs, [0.1] * HIDDEN, logits), [math.tanh(v) for v in logits])
        learn(state, 0.5)
        self.assertEqual(state['updates'], 1)
        state['enabled'] = False
        frozen = copy.deepcopy(state['weights'])
        self.assertEqual(act(state, inputs, [0.1] * HIDDEN, logits), [math.tanh(v) for v in logits])
        learn(state, -1)
        self.assertEqual(state['weights'], frozen)
        self.assertEqual(state['updates'], 1)

    def test_actual_experience_diverges_for_same_genome(self):
        left, right = train_direction(-0.6), train_direction(0.6)
        inputs = [0.0] * INPUTS
        inputs[1] = 0.6
        a = act(left, inputs, [0.0] * HIDDEN, [0.0] * 4)[0]
        b = act(right, inputs, [0.0] * HIDDEN, [0.0] * 4)[0]
        self.assertLess(a, -0.4)
        self.assertGreater(b, 0.4)

    def test_contextual_learning_beats_frozen_policy_on_controlled_task(self):
        # Not a claim about whole-world survival: an explicit two-context task.
        # A fixed zero-logit controller cannot turn left for one signal and right
        # for another. The personal neural layer is trained on scored outcomes.
        for seed in (1, 2, 3):
            state = new_experience()
            rng = random.Random(seed)
            for i in range(3500):
                side = -1 if i % 2 else 1
                inputs = [0.0] * INPUTS
                inputs[2 if side < 0 else 3] = 1
                inputs[11] = rng.uniform(-1, 1)
                output = act(state, inputs, [0.0] * HIDDEN, [0.0] * 4)
                learn(state, 1 - abs(output[0] - side * 0.6))
            state['enabled'] = False
            errors = []
            for side in (-1, 1):
                inputs = [0.0] * INPUTS
                inputs[2 if side < 0 else 3] = 1
                output = act(state, inputs, [0.0] * HIDDEN, [0.0] * 4)[0]
                self.assertGreater(output * side, 0.4)
                errors.append(abs(output - side * 0.6))
            self.assertLess(sum(errors) / 2, 0.15)  # Frozen policy error is 0.6.

    def test_rewards_reflect_food_costs_wounds_and_blocked_movement(self):
        positive = outcome_reward(50, 58, 100, 100, False, 0, 68)
        hunger = outcome_reward(50, 48, 100, 100, False, 0, 68)
        wound = outcome_reward(50, 48, 100, 80, False, 0, 68)
        blocked = outcome_reward(50, 48, 100, 100, True, 0, 68)
        self.assertGreater(positive, 0)
        self.assertLess(hunger, 0)
        self.assertLess(wound, hunger)
        self.assertLess(blocked, hunger)
        self.assertGreater(outcome_reward(150, 82, 100, 100, False, 1, 68), 0)
        self.assertEqual(outcome_reward(50, 50, 100, 100, False, 0, 68), 0)

    def test_injuries_count_even_when_predator_acts_first(self):
        for predator_first in (False, True):
            world = World(Config(population=2, predator_ratio=0.5))
            world.elevation = [0.6] * (WIDTH * HEIGHT)
            world.land_tiles = list(range(WIDTH * HEIGHT))
            for field in ('food', 'leaves', 'seeds', 'meat', 'canopy'):
                setattr(world, field, [0.0] * (WIDTH * HEIGHT))
            hunter = next(c for c in world.creatures if c.diet == 'carnivore')
            prey = next(c for c in world.creatures if c.diet == 'herbivore')
            for c in (hunter, prey):
                c.x, c.y, c.size, c.armor, c.energy = 40.5, 24.5, 1, 0, 50
                c.brain = [0.0] * WEIGHTS
            world.creatures = [hunter, prey] if predator_first else [prey, hunter]
            with patch.object(world.rng, 'shuffle', lambda values: None):
                world.step()
            self.assertLess(prey.health, 100)
            expected = outcome_reward(50, prey.energy, 100, prey.health, False, 0, 68)
            self.assertAlmostEqual(prey.experience['reward'], expected)
            self.assertLess(expected, -0.5)

    def test_feedback_applied_once_and_noise_is_deterministic(self):
        a, b = new_experience(), new_experience()
        for _ in range(10):
            self.assertEqual(act(a, [0.4] * INPUTS, [0.1] * HIDDEN, [0.1] * 4),
                             act(b, [0.4] * INPUTS, [0.1] * HIDDEN, [0.1] * 4))
            learn(a, 0.4)
            learn(b, 0.4)
        self.assertEqual(a, b)
        before = copy.deepcopy(a)
        learn(a, -1)
        self.assertEqual(a, before)

    def test_updates_and_outputs_remain_bounded_under_extreme_feedback(self):
        state = new_experience()
        for i in range(1000):
            outputs = act(state, [100.0] * INPUTS, [1.0] * HIDDEN, [100, -100, 0, 0])
            self.assertTrue(all(math.isfinite(v) and -1 <= v <= 1 for v in outputs))
            learn(state, 100 if i % 2 else -100)
        self.assertEqual(validate_experience(state), state)
        self.assertTrue(all(abs(v) <= 1.5 for v in state['weights']))

    def test_observing_or_pausing_does_not_train(self):
        sim = Simulation()
        sim.command('single_step', {})
        before = payload(sim.world)
        for _ in range(4):
            sim.command('state', {})
            sim.command('step', {})  # paused after single_step
        self.assertEqual(payload(sim.world), before)

    def test_current_save_preserves_personal_learning_and_exact_future(self):
        a = World(Config(population=8))
        for _ in range(8):
            a.step()
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'individuals.biosphere')
            persistence.save(a, True, 1, path)
            b, _, _ = persistence.load(path)
        self.assertEqual(payload(a), payload(b))
        for _ in range(8):
            a.step()
            b.step()
        self.assertEqual(payload(a), payload(b))

    def test_v7_migration_preserves_genomes_memory_rng_and_food(self):
        world = World(Config(population=8))
        world.step()
        data = payload(world)
        data['format'] = 7
        for record in data['creatures']:
            del record['experience']
        untouched = copy.deepcopy(data)
        restored, _, _ = persistence.unpack(data)
        self.assertEqual(data, untouched)
        self.assertEqual(restored.rng.getstate(), world.rng.getstate())
        self.assertEqual(restored.leaves, world.leaves)
        self.assertEqual(restored.seeds, world.seeds)
        for a, b in zip(world.creatures, restored.creatures):
            self.assertEqual(a.brain, b.brain)
            self.assertEqual(a.memory, b.memory)
            self.assertEqual(b.experience, new_experience())

    def test_undo_and_recovery_return_individual_experience(self):
        sim = Simulation()
        for _ in range(4):
            sim.command('single_step', {})
        before = payload(sim.world)
        c = sim.world.creatures[0]
        sim.command('brush', dict(kind='warm', x=c.x, y=c.y))
        sim.command('single_step', {})
        sim.command('undo', {})
        self.assertEqual(payload(sim.world), before)
        with tempfile.TemporaryDirectory() as folder:
            sim.command('autosave', {'directory': folder})
            sim.command('single_step', {})
            sim.command('recover', {'directory': folder})
            self.assertEqual(payload(sim.world), before)

    def test_invalid_learning_state_is_rejected_atomically(self):
        sim = Simulation()
        sim.command('single_step', {})
        good = payload(sim.world)
        bad_values = [('weights', []), ('weights', [float('nan')] * 100),
                      ('weights', [2.0] * 100), ('trace', [0]), ('updates', True),
                      ('updates', -1), ('reward', 2), ('baseline', float('inf')),
                      ('exploration', [1.0] * 4), ('enabled', 'yes')]
        for key, value in bad_values:
            data = copy.deepcopy(good)
            data['creatures'][0]['experience'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                persistence.unpack(data)
        data = copy.deepcopy(good)
        del data['creatures'][0]['experience']
        with self.assertRaises(ValueError):
            persistence.unpack(data)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bad-learning.biosphere'
            path.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValueError):
                sim.command('load', {'path': str(path)})
        self.assertEqual(payload(sim.world), good)

    def test_pending_decision_survives_save_and_no_state_aliasing(self):
        world = World(Config(population=2))
        world.creatures[0].think([0.4] * INPUTS)
        restored, _, _ = persistence.unpack(payload(world))
        a, b = world.creatures[0], restored.creatures[0]
        learn(a.experience, 0.4)
        learn(b.experience, 0.4)
        self.assertEqual(a.experience, b.experience)
        b.experience['weights'][0] = 1
        self.assertNotEqual(a.experience['weights'], b.experience['weights'])

    def test_full_population_ipc_and_save_size_and_no_weight_leak(self):
        world = World(Config(population=2))
        founder = world.creatures[0]
        while len(world.creatures) < MAX_POPULATION:
            world.creatures.append(world.new_creature(founder.x, founder.y))
            world.introduced += 1
        world.refresh_history()
        for _ in range(2):
            world.step()
        state = world.snapshot()
        self.assertLess(len(json.dumps(state, ensure_ascii=True).encode()), 2 * 1024 * 1024 - 16384)
        self.assertLess(len(json.dumps(payload(world)).encode()), persistence.MAX_SAVE_BYTES)
        self.assertNotIn('experience', state['creatures'][0])
        self.assertNotIn('weights', state['creatures'][0]['intelligence'])


if __name__ == '__main__':
    unittest.main()
