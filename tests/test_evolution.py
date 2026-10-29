import copy
import json
import math
import tempfile
import unittest
from pathlib import Path

from simulator import persistence
from simulator.runtime import Simulation
from simulator.world import Config, HEIGHT, HIDDEN, INPUTS, MAX_POPULATION, WEIGHTS, WIDTH, World

NEW_FIELDS = ("elongation", "armor", "lineage", "lineage_complete")


def payload(world):
    return json.loads(json.dumps(persistence.pack(world, True, 1)))


def legacy(world, version=4):
    data = payload(world)
    data["format"] = version
    for field in ("leaves", "seeds", "observations"):
        data.pop(field, None)
    del data["moisture"], data["rain_bias"]
    for record in data["creatures"]:
        for key in (*NEW_FIELDS, "foraging"):
            del record[key]
    return data


def child_of(world, parent):
    child = world.new_creature(parent.x, parent.y, parent)
    world.creatures.append(child)
    parent.children += 1
    world.births += 1
    world.refresh_history()
    return child


def brain(move=0, eat=-10, reproduce=-10):
    weights = [0.0] * WEIGHTS
    offset = (INPUTS + HIDDEN + 1) * HIDDEN
    weights[offset + HIDDEN] = move
    weights[offset + 2 * (HIDDEN + 1) + HIDDEN] = eat
    weights[offset + 3 * (HIDDEN + 1) + HIDDEN] = reproduce
    return weights


def flat_world(mutation=0):
    world = World(Config(population=2, predator_ratio=0, mutation=mutation))
    world.elevation = [0.65] * (WIDTH * HEIGHT)
    world.land_tiles = list(range(WIDTH * HEIGHT))
    for c in world.creatures:
        c.x, c.y, c.speed, c.size = 40.5, 24.5, 1.0, 1.0
        c.brain, c.elongation, c.armor = brain(), 1.0, 0.0
    return world


class MorphologyTests(unittest.TestCase):
    def test_founder_genes_are_seeded_bounded_and_each_founder_has_own_line(self):
        a, b = World(Config(population=50)), World(Config(population=50))
        self.assertEqual(payload(a), payload(b))
        self.assertEqual(len(a.lineages()), 50)
        self.assertGreater(len({c.armor for c in a.creatures}), 1)
        self.assertGreater(len({c.elongation for c in a.creatures}), 1)
        for c in a.creatures:
            self.assertEqual(c.lineage, c.id)
            self.assertTrue(c.lineage_complete)
            self.assertTrue(0 <= c.armor <= 0.3)
            self.assertTrue(0.85 <= c.elongation <= 1.2)

    def test_zero_mutation_inherits_body_and_lineage_without_lifetime_state(self):
        world = flat_world()
        parent = world.creatures[0]
        parent.armor, parent.elongation = 0.9, 1.75
        parent.health, parent.memory = 45, [0.8] * HIDDEN
        child = world.new_creature(parent.x, parent.y, parent)
        self.assertEqual((child.armor, child.elongation, child.lineage), (0.9, 1.75, parent.lineage))
        self.assertTrue(child.lineage_complete)
        self.assertEqual(child.health, 100)
        self.assertEqual(child.memory, [0] * HIDDEN)
        self.assertIsNot(child.memory, parent.memory)
        self.assertIsNot(child.brain, parent.brain)

    def test_body_mutation_is_bounded_and_lineage_does_not_mutate(self):
        world = flat_world(mutation=0.5)
        parent = world.creatures[0]
        parent.armor, parent.elongation = 1.0, 1.8
        changed = {"armor": 0, "elongation": 0}
        for _ in range(300):
            child = world.new_creature(parent.x, parent.y, parent)
            self.assertTrue(0 <= child.armor <= 1)
            self.assertTrue(0.65 <= child.elongation <= 1.8)
            self.assertEqual(child.lineage, parent.lineage)
            for key in changed:
                changed[key] += getattr(child, key) != getattr(parent, key)
        self.assertTrue(all(value > 0 for value in changed.values()))
        self.assertEqual((parent.armor, parent.elongation), (1, 1.8))

    def test_natural_birth_transfers_body_genes_and_family(self):
        world = flat_world()
        parent = world.creatures[0]
        parent.age, parent.energy = 13, 185
        parent.brain, parent.armor, parent.elongation = brain(reproduce=10), 0.75, 1.6
        world.step()
        self.assertEqual(world.births, 1)
        child = world.creatures[-1]
        self.assertEqual((child.parent, child.generation, child.lineage), (parent.id, 2, parent.lineage))
        self.assertEqual((child.armor, child.elongation), (0.75, 1.6))
        persistence.unpack(payload(world))

    def test_shell_reduces_damage_but_is_not_invulnerability(self):
        plain = flat_world()
        plain.creatures[0].diet = "carnivore"
        for c in plain.creatures:
            c.brain = brain(eat=10)
        armored, _, _ = persistence.unpack(payload(plain))
        armored.creatures[1].armor = 1
        plain.step()
        armored.step()
        self.assertGreater(armored.creatures[1].health, plain.creatures[1].health)
        self.assertLess(armored.creatures[1].health, 100)
        self.assertLess(armored.creatures[1].energy, plain.creatures[1].energy)

    def test_shell_has_a_metabolic_cost_and_reduces_mobility(self):
        plain = flat_world()
        armored, _, _ = persistence.unpack(payload(plain))
        armored.creatures[0].armor = 1
        self.assertLess(armored.creatures[0].mobility, plain.creatures[0].mobility)
        plain.step()
        armored.step()
        self.assertAlmostEqual(plain.creatures[0].energy - armored.creatures[0].energy, 0.25 * 0.9)
        plain_c, armored_c = plain.creatures[0], armored.creatures[0]
        plain_c.brain = brain(move=10)
        armored_c.brain = brain(move=10)
        plain.step()
        armored.step()
        self.assertGreater(plain_c.x, armored_c.x)

    def test_streamlining_increases_actual_displacement_and_movement_energy_cost(self):
        plain = flat_world()
        for c in plain.creatures:
            c.brain = brain(move=10)
        elongated, _, _ = persistence.unpack(payload(plain))
        elongated.creatures[0].elongation = 1.8
        plain.step()
        elongated.step()
        self.assertGreater(elongated.creatures[0].x, plain.creatures[0].x)
        self.assertLess(elongated.creatures[0].energy, plain.creatures[0].energy)
        self.assertAlmostEqual(elongated.creatures[0].mobility, math.sqrt(1.8))


class LineageTests(unittest.TestCase):
    def test_population_totals_rankings_and_representative_are_real(self):
        world = flat_world()
        founder = world.creatures[0]
        child = child_of(world, founder)
        grandchild = child_of(world, child)
        child_of(world, founder)
        groups = world.lineages()
        self.assertEqual(sum(group["population"] for group in groups), len(world.creatures))
        self.assertEqual(groups[0]["id"], founder.id)
        self.assertEqual(groups[0]["population"], 4)
        self.assertEqual(groups[0]["generation"], 3)
        self.assertEqual(groups[0]["representative"], grandchild.id)
        self.assertEqual(groups[0]["mean_armor"], 0)
        self.assertEqual(groups[0]["mean_elongation"], 1)
        self.assertEqual(world.snapshot()["evolution"]["lineages"], 2)
        # Equal population ties are ordered by ID, never random colors or hash order.
        singleton_ids = [group["id"] for group in World(Config(population=12)).lineages()]
        self.assertEqual(singleton_ids, sorted(singleton_ids))

    def test_death_of_founder_does_not_rename_descendant_lineage(self):
        world = flat_world()
        parent = world.creatures[0]
        child = child_of(world, parent)
        parent.energy = -1
        world.step()
        self.assertNotIn(parent, world.creatures)
        self.assertIn(child, world.creatures)
        self.assertEqual(child.lineage, parent.id)
        restored, _, _ = persistence.unpack(payload(world))
        self.assertEqual(restored.lineages(), world.lineages())

    def test_introduced_founders_start_new_families_not_existing_families(self):
        sim = Simulation()
        c = sim.world.creatures[0]
        sim.command("brush", dict(kind="spawn_herbivore", x=c.x, y=c.y, count=4))
        for newcomer in sim.world.creatures[-4:]:
            self.assertEqual(newcomer.lineage, newcomer.id)
            self.assertTrue(newcomer.lineage_complete)
            self.assertIsNone(newcomer.parent)
        self.assertEqual(len(sim.world.lineages()), sim.world.config.population + 4)

    def test_empty_world_statistics_are_finite_and_no_family_is_invented(self):
        world = flat_world()
        sim = Simulation()
        sim.world = world
        sim.command("brush", dict(kind="erase_life", x=40.5, y=24.5))
        state = sim.state()
        self.assertEqual(state["lineages"], [])
        self.assertEqual(state["evolution"], dict(lineages=0, mean_armor=0, mean_elongation=0))
        json.dumps(state, allow_nan=False)
        persistence.unpack(payload(world))

    def test_snapshot_contains_body_traits_but_no_private_brain_weights(self):
        world = flat_world()
        snapshot = world.snapshot()
        for c in snapshot["creatures"]:
            for field in (*NEW_FIELDS, "mobility"):
                self.assertIn(field, c)
            self.assertNotIn("brain", c)
        snapshot["lineages"][0]["population"] = 999
        self.assertEqual(world.lineages()[0]["population"], 1)

    def test_max_population_snapshot_fits_native_pipe_response_limit(self):
        sim = Simulation()
        sim.world = flat_world()
        founder = sim.world.creatures[0]
        for _ in range(MAX_POPULATION - 2):
            c = sim.world.new_creature(founder.x, founder.y)
            sim.world.creatures.append(c)
            sim.world.introduced += 1
        sim.world.refresh_history()
        self.assertLess(len(json.dumps(sim.state(), ensure_ascii=True).encode("ascii")), 2 * 1024 * 1024)
        self.assertLess(len(json.dumps(payload(sim.world)).encode()), persistence.MAX_SAVE_BYTES)


class BodySaveTests(unittest.TestCase):
    def test_current_round_trip_and_exact_continuation_with_mutation_and_undo(self):
        sim = Simulation()
        sim.world = flat_world(mutation=0.5)
        child_of(sim.world, sim.world.creatures[0])
        sim.world.creatures[0].armor = 0.9
        sim.world.creatures[1].elongation = 1.65
        before = payload(sim.world)
        self.assertEqual(before["format"], 7)
        sim.command("brush", dict(kind="warm", x=40.5, y=24.5))
        sim.command("single_step", {})
        sim.command("undo", {})
        self.assertEqual(payload(sim.world), before)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "families.biosphere"
            persistence.save(sim.world, False, 2, str(path))
            restored, paused, speed = persistence.load(str(path))
        self.assertFalse(paused)
        self.assertEqual(speed, 2)
        for _ in range(24):
            sim.world.step()
            restored.step()
        self.assertEqual(payload(sim.world), payload(restored))

    def test_v4_migration_uses_neutral_genes_and_recovers_only_available_ancestry(self):
        world = flat_world()
        founder = world.creatures[0]
        child = child_of(world, founder)
        grandchild = child_of(world, child)
        sibling = child_of(world, founder)
        world.creatures.remove(founder)
        world.deaths += 1
        world.death_causes["intervention"] += 1
        world.refresh_history()
        old = legacy(world)
        old["creatures"].reverse()  # Ancestors need not precede children in the file.
        untouched = copy.deepcopy(old)
        restored, _, _ = persistence.unpack(old)
        self.assertEqual(old, untouched)
        self.assertEqual(restored.rng.getstate(), world.rng.getstate())
        by_id = {c.id: c for c in restored.creatures}
        for original in (child, grandchild, sibling):
            c = by_id[original.id]
            self.assertEqual(c.lineage, founder.id)
            self.assertFalse(c.lineage_complete)
            self.assertEqual((c.elongation, c.armor), (1, 0))
            self.assertEqual(c.brain, original.brain)
            self.assertEqual(c.memory, original.memory)
        self.assertTrue(by_id[2].lineage_complete)
        persistence.unpack(payload(restored))

    def test_v4_migration_recovers_complete_chain_when_founder_is_present(self):
        world = flat_world()
        founder = world.creatures[0]
        parent = founder
        for _ in range(120):
            parent = child_of(world, parent)
        old = legacy(world)
        old["creatures"].reverse()
        restored, _, _ = persistence.unpack(old)
        self.assertTrue(all(c.lineage == founder.id and c.lineage_complete
                            for c in restored.creatures if c.id != 2))
        self.assertEqual(restored.lineages()[0]["generation"], 121)

    def test_v4_migration_rejects_bad_parent_graphs_instead_of_guessing(self):
        good = legacy(flat_world())
        for field, value in (("parent", True), ("parent", 2), ("id", True), ("id", -1)):
            bad = copy.deepcopy(good)
            bad["creatures"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                persistence.unpack(bad)
        bad = copy.deepcopy(good)
        bad["creatures"][1]["id"] = bad["creatures"][0]["id"]
        with self.assertRaises(ValueError):
            persistence.unpack(bad)

    def test_current_rejects_missing_nonfinite_out_of_range_and_forged_family_fields(self):
        world = flat_world()
        child_of(world, world.creatures[0])
        good = payload(world)
        for field, value in (("elongation", True), ("elongation", 0.1), ("elongation", 2),
                             ("armor", float("nan")), ("armor", -1), ("armor", 2),
                             ("lineage", True), ("lineage", 0), ("lineage", 100),
                             ("lineage_complete", 1), ("lineage_complete", False), ("generation", 2)):
            bad = copy.deepcopy(good)
            bad["creatures"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                persistence.unpack(bad)
        for field in NEW_FIELDS:
            bad = copy.deepcopy(good)
            del bad["creatures"][0][field]
            with self.subTest(missing=field), self.assertRaises(ValueError):
                persistence.unpack(bad)
        for field, value in (("lineage", 2), ("lineage_complete", False),
                             ("diet", "carnivore"), ("generation", 4)):
            bad = copy.deepcopy(good)
            bad["creatures"][-1][field] = value
            with self.subTest(child_field=field), self.assertRaises(ValueError):
                persistence.unpack(bad)


if __name__ == "__main__":
    unittest.main()
