"""Generate real simulation states for native graphics/lineage tests, not demo agents."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from simulator.runtime import Simulation
from simulator.world import wrapped_dx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(".cache/snapshot.json"))
    args = parser.parse_args()
    simulation = Simulation()
    # Let natural reproduction create actual relatives, not a synthetic display family.
    for _ in range(64):
        simulation.command("step", {})
    simulation.command("control", {"paused": True})
    before = simulation.state()
    chosen = None
    for group in before["lineages"]:
        members = [c for c in simulation.world.creatures if c.lineage == group["id"]]
        for candidate in members:
            if any((wrapped_dx(c.x, candidate.x)**2 + (c.y - candidate.y)**2) > 0.75**2 for c in members):
                chosen = candidate
                break
        if chosen:
            break
    if chosen is None:
        raise RuntimeError("Fixture has no separated surviving relatives; inspect ecology changes")
    after_path = args.output.with_name(args.output.stem + "-after.json").resolve()
    before["_lineage_test"] = {"selected": chosen.id, "lineage": chosen.lineage, "after": str(after_path)}
    simulation.command("brush", dict(kind="erase_life", x=chosen.x, y=chosen.y, radius=0.75))
    after = simulation.state()
    if not any(c["lineage"] == chosen.lineage for c in after["creatures"]):
        raise RuntimeError("Fixture brush left no family to follow")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(before), encoding="utf-8")
    after_path.write_text(json.dumps(after), encoding="utf-8")
    early = Simulation()
    early.command("earth", {"seed": 42})
    hot_path = args.output.with_name(args.output.stem + "-earth-hot.json")
    cold_path = args.output.with_name(args.output.stem + "-earth-cold.json")
    hot_path.write_text(json.dumps(early.state()), encoding="utf-8")
    for _ in range(120):
        early.command("single_step", {})
    cold_path.write_text(json.dumps(early.state()), encoding="utf-8")
    early.command("ocean_begin", {})
    for _ in range(240):
        early.command("single_step", {})
    ocean_path = args.output.with_name(args.output.stem + "-ocean.json")
    ocean_path.write_text(json.dumps(early.state()), encoding="utf-8")
    print(ocean_path.resolve())
    print(hot_path.resolve())
    print(cold_path.resolve())
    print(args.output.resolve())
    print(after_path)


if __name__ == "__main__":
    main()
