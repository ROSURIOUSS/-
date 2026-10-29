import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from simulator import autosave, persistence
from simulator.runtime import Simulation
from simulator.world import Config, World

ROOT = Path(__file__).resolve().parent.parent


def packed(world):
    return json.loads(json.dumps(persistence.pack(world, False, 1)))


class AutosaveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "автокопии"
        self.sim = Simulation()
        self.sim.command("world", {"population": 8})

    def command(self, name="autosave", **kw):
        return self.sim.command(name, {"directory": str(self.root), **kw})

    def test_empty_scan_does_not_create_files_or_mutate_world(self):
        before = self.sim.state()
        self.command("autosave_info")
        self.assertFalse(self.root.exists())
        self.assertEqual(self.sim.autosaves, dict(directory=str(self.root), records=[], warnings=[]))
        for key in before:
            if key != "autosaves":
                self.assertEqual(self.sim.state()[key], before[key])

    def test_first_save_is_atomic_valid_and_readable_as_an_ordinary_save(self):
        before = packed(self.sim.world)
        self.command()
        records = self.sim.autosaves["records"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["generation"], 1)
        self.assertEqual(records[0]["slot"], 0)
        restored, paused, speed = persistence.load(records[0]["path"])
        self.assertFalse(paused)
        self.assertEqual(speed, 1)
        self.assertEqual(packed(restored), before)
        self.assertEqual(packed(self.sim.world), before)
        self.assertEqual(self.sim.autosaves["warnings"], [])

    def test_ring_keeps_three_latest_generations_not_three_latest_clock_times(self):
        for _ in range(7):
            self.sim.command("single_step", {})
            self.command()
        records = self.sim.autosaves["records"]
        self.assertEqual([row["generation"] for row in records], [7, 6, 5])
        self.assertEqual([row["day"] for row in records], [1.75, 1.5, 1.25])
        self.assertEqual(len(list(self.root.glob("*.biosphere"))), 3)
        for row in records:
            os.utime(row["path"], (1000000000 - row["generation"],) * 2)
        self.command("autosave_info")
        self.assertEqual([row["generation"] for row in self.sim.autosaves["records"]], [7, 6, 5])

    def test_recovery_selects_latest_valid_and_always_pauses(self):
        self.sim.command("control", {"speed": 5})
        self.sim.command("step", {})
        self.command()
        before = packed(self.sim.world)
        self.sim.command("step", {})
        self.command("recover")
        self.assertEqual(packed(self.sim.world), before)
        self.assertTrue(self.sim.paused)
        self.assertEqual(self.sim.speed, 5)
        self.assertIsNone(self.sim.error)

    def test_explicit_older_generation_can_be_selected(self):
        self.command()
        older = copy.deepcopy(self.sim.autosaves["records"][0])
        self.sim.command("step", {})
        self.command()
        self.command("recover", slot=older["slot"], generation=older["generation"])
        self.assertEqual(self.sim.world.day, 0)
        self.assertTrue(self.sim.paused)

    def test_corrupt_latest_is_skipped_and_previous_good_copy_recovers(self):
        self.command()
        old = packed(self.sim.world)
        self.sim.command("step", {})
        self.command()
        newest = self.sim.autosaves["records"][0]
        Path(newest["path"]).write_bytes(b'{partial')
        self.command("autosave_info")
        self.assertEqual(len(self.sim.autosaves["records"]), 1)
        self.assertEqual(len(self.sim.autosaves["warnings"]), 1)
        self.command("recover")
        self.assertEqual(packed(self.sim.world), old)

    def test_corrupt_slot_can_be_replaced_without_touching_good_slots_or_other_files(self):
        self.command()
        first = self.sim.autosaves["records"][0]
        first_bytes = Path(first["path"]).read_bytes()
        self.root.joinpath("slot-2.biosphere").write_bytes(b'broken')
        unrelated = self.root / "my-world.biosphere"
        unrelated.write_bytes(b'not ours')
        self.command()
        self.assertEqual(Path(first["path"]).read_bytes(), first_bytes)
        self.assertEqual(unrelated.read_bytes(), b'not ours')
        self.assertEqual(self.sim.autosaves["warnings"], [])
        self.assertEqual(len(self.sim.autosaves["records"]), 2)

    def test_failed_replace_preserves_all_three_good_slots_and_cleans_temporary_file(self):
        for _ in range(3):
            self.command()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        status = copy.deepcopy(self.sim.autosaves)
        with patch("simulator.persistence.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.command()
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)
        self.assertEqual(self.sim.autosaves, status)
        self.command("recover")

    def test_unreadable_post_write_is_not_reported_as_a_success(self):
        self.command()
        path = Path(self.sim.autosaves["records"][0]["path"])
        good = path.read_bytes()
        status = copy.deepcopy(self.sim.autosaves)
        def corrupt(data, target):
            Path(target).write_bytes(b'{corrupted after write')
        with patch("simulator.persistence.write_payload", side_effect=corrupt):
            with self.assertRaises(ValueError):
                self.command()
        self.assertEqual(path.read_bytes(), good)
        self.assertEqual(self.sim.autosaves, status)

    def test_failed_flush_preserves_latest_copy(self):
        self.command()
        path = Path(self.sim.autosaves["records"][0]["path"])
        before = path.read_bytes()
        with patch("simulator.persistence.os.fsync", side_effect=OSError("flush failed")):
            with self.assertRaises(OSError):
                self.command()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len(list(self.root.glob("*.biosphere"))), 1)

    def test_invalid_live_world_is_never_allowed_to_replace_a_good_backup(self):
        self.command()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.sim.world.food[0] = float("nan")
        with self.assertRaises(ValueError):
            self.command()
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)

    def test_runtime_error_blocks_autosave_without_hiding_the_failure(self):
        self.command()
        self.sim.error = "synthetic calculation failure"
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        with self.assertRaises(ValueError):
            self.command()
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)
        self.assertEqual(self.sim.error, "synthetic calculation failure")
        self.command("recover")
        self.assertIsNone(self.sim.error)

    def test_stale_selection_rejects_restore_instead_of_loading_another_world(self):
        self.command()
        choice = copy.deepcopy(self.sim.autosaves["records"][0])
        for _ in range(3):
            self.sim.command("step", {})
            self.command()
        before, undo = self.sim.state(), self.sim.sandbox.state()
        with self.assertRaises(ValueError):
            self.command("recover", slot=choice["slot"], generation=choice["generation"])
        self.assertEqual(self.sim.state(), before)
        self.assertEqual(self.sim.sandbox.state(), undo)

    def test_recovery_clears_undo_only_after_success(self):
        self.command()
        c = self.sim.world.creatures[0]
        self.sim.command("brush", dict(kind="warm", x=c.x, y=c.y))
        self.assertTrue(self.sim.sandbox.state()["can_undo"])
        with self.assertRaises(ValueError):
            self.command("recover", slot=2)
        self.assertTrue(self.sim.sandbox.state()["can_undo"])
        self.command("recover")
        self.assertFalse(self.sim.sandbox.state()["can_undo"])

    def test_autosaving_does_not_consume_rng_or_clear_brush_undo(self):
        c = self.sim.world.creatures[0]
        self.sim.command("brush", dict(kind="rain", x=c.x, y=c.y))
        before, checkpoint = packed(self.sim.world), copy.deepcopy(self.sim.sandbox.checkpoint)
        self.command()
        self.assertEqual(packed(self.sim.world), before)
        self.assertEqual(self.sim.sandbox.checkpoint, checkpoint)

    def test_all_invalid_files_are_reported_and_restore_leaves_live_world_untouched(self):
        self.root.mkdir()
        for slot in range(3):
            autosave.slot_path(self.root, slot).write_bytes(b'{}')
        before = self.sim.state()
        with self.assertRaises(ValueError):
            self.command("recover")
        self.assertEqual(self.sim.state(), before)
        self.command("autosave_info")
        self.assertEqual(self.sim.autosaves["records"], [])
        self.assertEqual(len(self.sim.autosaves["warnings"]), 3)

    def test_unknown_tags_bad_metadata_and_invalid_worlds_are_not_offered(self):
        self.command()
        path = Path(self.sim.autosaves["records"][0]["path"])
        good = persistence.read_payload(str(path))
        for key, value in (("format", True), ("format", 2), ("generation", True),
                           ("generation", -1), ("generation", 1.5), ("utc", "bad"),
                           ("utc", "2026-10-29T10:20:00"), ("utc", 3)):
            bad = copy.deepcopy(good)
            bad[autosave.TAG][key] = value
            persistence.write_payload(bad, str(path))
            with self.subTest(key=key, value=value):
                self.assertEqual(autosave.scan(str(self.root))["records"], [])
        bad = copy.deepcopy(good)
        del bad[autosave.TAG]
        persistence.write_payload(bad, str(path))
        self.assertEqual(autosave.scan(str(self.root))["records"], [])
        bad = copy.deepcopy(good)
        bad["moisture"] = []
        persistence.write_payload(bad, str(path))
        self.assertEqual(autosave.scan(str(self.root))["records"], [])

    def test_input_validation_does_not_create_paths_or_mutate_state(self):
        before = self.sim.state()
        cases = [("autosave", {"directory": "relative"}), ("autosave", {"directory": True}),
                 ("autosave", {"directory": str(self.root), "slot": 1}),
                 ("autosave_info", {"directory": str(self.root), "extra": 1}),
                 ("recover", {"directory": str(self.root), "slot": True}),
                 ("recover", {"directory": str(self.root), "slot": None}),
                 ("recover", {"directory": str(self.root), "slot": -1}),
                 ("recover", {"directory": str(self.root), "generation": True}),
                 ("recover", {"directory": str(self.root), "generation": None}),
                 ("autosave_info", {}), ("autosave", {"directory": "\x00"})]
        for command, data in cases:
            with self.subTest(command=command, data=data), self.assertRaises(ValueError):
                self.sim.command(command, data)
            self.assertEqual(self.sim.state(), before)
        self.assertFalse(self.root.exists())

    def test_empty_missing_or_file_directory_cannot_replace_live_world(self):
        before = self.sim.state()
        with self.assertRaises(ValueError):
            self.command("recover")
        self.assertFalse(self.root.exists())
        self.root.write_bytes(b'not a directory')
        for command in ("autosave", "autosave_info", "recover"):
            with self.subTest(command=command), self.assertRaises((ValueError, OSError)):
                self.command(command)
        self.assertEqual(self.sim.state(), before)

    def test_lock_conflict_cannot_overwrite_and_lock_releases_after_exception(self):
        self.command()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        with autosave.locked(self.root):
            with self.assertRaises(ValueError):
                self.command()
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)
        self.command()
        self.assertEqual(len(self.sim.autosaves["records"]), 2)

    def test_generation_limit_does_not_overwrite_files(self):
        self.command()
        path = Path(self.sim.autosaves["records"][0]["path"])
        data = persistence.read_payload(str(path))
        data[autosave.TAG]["generation"] = autosave.MAX_GENERATION
        persistence.write_payload(data, str(path))
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            self.command()
        self.assertEqual(path.read_bytes(), before)

    def test_old_lock_file_is_not_a_stale_process_lock(self):
        self.root.mkdir()
        self.root.joinpath(".write.lock").write_bytes(b'old process')
        self.command()
        self.assertEqual(len(self.sim.autosaves["records"]), 1)

    def test_worker_restart_discovers_autosave_and_preserves_exact_future(self):
        requests = [("world", {"population": 8}), ("single_step", {}),
                    ("autosave", {"directory": str(self.root)}), ("quit", {})]
        def worker(rows):
            result = subprocess.run([sys.executable, str(ROOT / "simulator/worker.py")],
                                    input="".join(json.dumps(dict(id=i, command=name, data=data)) + "\n"
                                                  for i, (name, data) in enumerate(rows)),
                                    text=True, capture_output=True, timeout=20, check=True)
            self.assertEqual(result.stderr, "")
            packets = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(packets[0]["protocol"], 7)
            self.assertTrue(all(row["ok"] for row in packets[1:]))
            return packets
        first = worker(requests)
        second = worker([("autosave_info", {"directory": str(self.root)}),
                         ("recover", {"directory": str(self.root)}), ("quit", {})])
        self.assertEqual(second[2]["state"], first[3]["state"])


if __name__ == "__main__":
    unittest.main()
