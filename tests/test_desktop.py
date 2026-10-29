import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from simulator import persistence
from simulator.runtime import Simulation
from simulator.world import Config, World
from tools.launch import find_godot

ROOT = Path(__file__).resolve().parent.parent


class RuntimeTests(unittest.TestCase):
    def test_pause_and_speed(self):
        simulation = Simulation()
        simulation.command("control", {"speed": 5})
        simulation.command("step", {})
        self.assertEqual(simulation.world.day, 1.25)
        simulation.command("control", {"paused": True})
        before = simulation.state()
        simulation.command("step", {})
        self.assertEqual(simulation.state(), before)

    def test_bad_command_does_not_partially_mutate(self):
        simulation = Simulation()
        before = simulation.state()
        for command, data in (("control", {"paused": True, "speed": 100}),
                              ("control", {"speed": True}), ("control", {"paused": 1}),
                              ("world", {"population": 0}), ("unknown", {}), ("world", [])):
            with self.subTest(command=command, data=data), self.assertRaises(ValueError):
                simulation.command(command, data)
            self.assertEqual(simulation.state(), before)

    def test_world_reset(self):
        simulation = Simulation()
        simulation.command("step", {})
        simulation.command("control", {"paused": True})
        simulation.command("world", {"seed": 123, "population": 11})
        self.assertEqual(simulation.world.config.seed, 123)
        self.assertEqual(len(simulation.world.creatures), 11)
        self.assertEqual(simulation.world.day, 0)
        self.assertFalse(simulation.paused)


class PersistenceTests(unittest.TestCase):
    def test_round_trip_preserves_exact_future_including_brains_and_rng(self):
        original = World(Config(population=20))
        for _ in range(100):
            original.step()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "моя планета.biosphere")
            persistence.save(original, True, 5, path)
            restored, paused, speed = persistence.load(path)
        self.assertTrue(paused)
        self.assertEqual(speed, 5)
        self.assertEqual(original.snapshot(), restored.snapshot())
        self.assertEqual([c.brain for c in original.creatures], [c.brain for c in restored.creatures])
        for _ in range(100):
            original.step()
            restored.step()
        self.assertEqual(original.snapshot(), restored.snapshot())
        self.assertEqual(original.rng.getstate(), restored.rng.getstate())

    def test_rejects_malformed_saves(self):
        good = json.loads(json.dumps(persistence.pack(World(Config(population=2)), False, 1)))
        for key, value in (("format", 9), ("format", True), ("food", []), ("day", float("nan")),
                           ("speed", True), ("paused", "yes"), ("next_id", 1), ("rng", []),
                           ("creatures", [None]), ("history", []), ("events", [42])):
            with self.subTest(key=key):
                bad = copy.deepcopy(good)
                bad[key] = value
                with self.assertRaises(ValueError):
                    persistence.unpack(bad)
        for key, value in (("brain", [0]), ("energy", -1), ("x", 999), ("id", 1000), ("parent", 1000)):
            with self.subTest(creature_key=key):
                bad = copy.deepcopy(good)
                bad["creatures"][0][key] = value
                with self.assertRaises(ValueError):
                    persistence.unpack(bad)

    def test_corrupt_load_preserves_active_world(self):
        simulation = Simulation()
        before = simulation.state()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "corrupt.biosphere"
            path.write_bytes(b'{invalid')
            with self.assertRaises(ValueError):
                simulation.command("load", {"path": str(path)})
        self.assertEqual(simulation.state(), before)

    def test_failed_atomic_write_does_not_destroy_old_save(self):
        simulation = Simulation()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "world.biosphere"
            persistence.save(simulation.world, False, 1, str(path))
            original = path.read_bytes()
            with patch("simulator.persistence.os.replace", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    persistence.save(simulation.world, False, 1, str(path))
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual([f.name for f in Path(directory).iterdir()], [path.name])

    def test_oversized_save_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.biosphere"
            path.write_bytes(b'x' * (persistence.MAX_SAVE_BYTES + 1))
            with self.assertRaises(ValueError):
                persistence.load(str(path))

    def test_extinct_world_can_be_saved(self):
        world = World(Config(population=2))
        for c in world.creatures:
            c.energy = -100
        world.step()
        data = json.loads(json.dumps(persistence.pack(world, False, 1)))
        restored, _, _ = persistence.unpack(data)
        self.assertEqual(world.snapshot(), restored.snapshot())


class WorkerTests(unittest.TestCase):
    def run_worker(self, requests=None, raw=None):
        if raw is None:
            raw = b''.join(json.dumps(request, ensure_ascii=False).encode("utf-8") + b'\n' for request in requests)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, "-u", str(ROOT / "simulator" / "worker.py")],
                                    input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    cwd=directory, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b'')
        packets = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(packets[0], {"type": "ready", "protocol": 7})
        return packets[1:]

    def test_actual_process_commands_and_graceful_quit(self):
        packets = self.run_worker([
            {"id": 1, "command": "world", "data": {"seed": 123, "population": 12}},
            {"id": 2, "command": "step"},
            {"id": 3, "command": "control", "data": {"paused": True}},
            {"id": 4, "command": "step"},
            {"id": 5, "command": "quit"},
        ])
        self.assertEqual([p["id"] for p in packets], [1, 2, 3, 4, 5])
        self.assertTrue(all(p["ok"] for p in packets))
        self.assertEqual(packets[0]["state"]["population"], 12)
        self.assertEqual(packets[1]["state"]["day"], 0.25)
        self.assertEqual(packets[2]["state"], packets[3]["state"])

    def test_eof_terminates_worker_without_orphan(self):
        self.assertEqual(self.run_worker(raw=b''), [])

    def test_invalid_packet_then_recovery(self):
        packets = self.run_worker(raw=b'{broken\n[]\n{"id":1,"command":"bad"}\n{"id":2,"command":"state"}\n')
        self.assertEqual([p["ok"] for p in packets], [False, False, False, True])
        self.assertEqual(packets[-1]["id"], 2)

    def test_oversized_packet_rejected_and_exits(self):
        packets = self.run_worker(raw=b'x' * 17000 + b'\n')
        self.assertEqual(len(packets), 1)
        self.assertFalse(packets[0]["ok"])

    def test_save_and_load_through_unicode_pipe_request(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "Моя Земля.biosphere")
            packets = self.run_worker([
                {"id": 1, "command": "control", "data": {"paused": True}},
                {"id": 2, "command": "save", "data": {"path": path}},
                {"id": 3, "command": "world", "data": {"seed": -10, "population": 2}},
                {"id": 4, "command": "load", "data": {"path": path}},
            ])
        self.assertTrue(all(p["ok"] for p in packets))
        self.assertEqual(packets[0]["state"], packets[-1]["state"])
        self.assertIn("Мир сохранён", packets[1]["message"])


class LaunchTests(unittest.TestCase):
    def test_explicit_executable(self):
        self.assertEqual(Path(find_godot(sys.executable)).resolve(), Path(sys.executable).resolve())

    def test_missing_godot_has_actionable_error(self):
        with self.assertRaisesRegex(ValueError, "Godot"):
            find_godot("/a/path/that/does/not/exist/godot")

    def test_no_http_or_browser_entrypoints_remain(self):
        self.assertFalse((ROOT / "web").exists())
        self.assertFalse((ROOT / "simulator" / "server.py").exists())
        self.assertFalse((ROOT / "start_server.bat").exists())


if __name__ == "__main__":
    unittest.main()
