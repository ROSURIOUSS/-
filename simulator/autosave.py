"""Three validated, atomic recovery slots. No live-world mutation or clock-based ordering."""
from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import persistence

SLOTS = 3
MAX_GENERATION = 10**12
TAG = "biosphere_autosave"


def directory(value: str) -> Path:
    if not isinstance(value, str) or not value.strip() or len(value) > 4096 or "\x00" in value:
        raise ValueError("Нужен абсолютный каталог автосохранений")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("Каталог автосохранений должен быть абсолютным")
    return path.resolve()


def slot_path(root: Path, slot: int) -> Path:
    if type(slot) is not int or not 0 <= slot < SLOTS:
        raise ValueError("Слот автосохранения: 0, 1 или 2")
    return root / f"slot-{slot + 1}.biosphere"


@contextmanager
def locked(root: Path):
    """OS lock is released even on worker crashes; no stale PID/lock-file timeout."""
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".write.lock").open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ValueError("Автосохранения заняты другим экземпляром программы; попробуйте позже") from exc
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def read_slot(root: Path, slot: int):
    path = slot_path(root, slot)
    data = persistence.read_payload(str(path))
    world, paused, speed = persistence.unpack(data)
    metadata = data.get(TAG)
    if not isinstance(metadata, dict) or metadata.keys() != {"format", "generation", "utc"}:
        raise ValueError("Не найдена метка автосохранения")
    if type(metadata["format"]) is not int or metadata["format"] != 1:
        raise ValueError("Неизвестная метка автосохранения")
    generation = persistence.integer(metadata["generation"], 1, MAX_GENERATION)
    stamp = metadata["utc"]
    if not isinstance(stamp, str) or len(stamp) > 64:
        raise ValueError("Неверное время автосохранения")
    parsed = datetime.fromisoformat(stamp)
    if parsed.tzinfo is None:
        raise ValueError("У времени автосохранения нет часового пояса")
    record = {"slot": slot, "generation": generation, "utc": stamp,
              "day": world.day, "earth_age_myr": world.earth["age_myr"] if world.earth is not None else None,
              "population": len(world.creatures), "seed": world.config.seed,
              "path": str(path)}
    return record, world, paused, speed


def scan(value: str) -> dict:
    root = directory(value)
    if root.exists() and not root.is_dir():
        raise ValueError("Путь автосохранений не является каталогом")
    records, warnings = [], []
    for slot in range(SLOTS):
        try:
            record, *_ = read_slot(root, slot)
            records.append(record)
        except FileNotFoundError:
            continue
        except (ValueError, OSError, RecursionError) as exc:
            warnings.append(f"Слот {slot + 1} пропущен: {str(exc)[:400]}")
    records.sort(key=lambda row: (-row["generation"], row["slot"]))
    return {"directory": str(root), "records": records, "warnings": warnings}


def save(world, paused: bool, speed: int, value: str) -> dict:
    root = directory(value)
    # Validate the actual checkpoint before replacing any good slot.
    data = persistence.pack(world, paused, speed)
    # Validation expects JSON-compatible RNG state, while pack uses Random.getstate().
    version, internal, gaussian = data["rng"]
    data["rng"] = [version, list(internal), gaussian]
    persistence.unpack(data)
    with locked(root):
        before = scan(str(root))
        records = before["records"]
        used = {record["slot"] for record in records}
        target = next((slot for slot in range(SLOTS) if slot not in used), records[-1]["slot"] if records else 0)
        generation = max((row["generation"] for row in records), default=0) + 1
        if generation > MAX_GENERATION:
            raise ValueError("Достигнут предел нумерации автокопий")
        data[TAG] = {"format": 1, "generation": generation,
                     "utc": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        persistence.write_payload(data, str(slot_path(root, target)))
        after = scan(str(root))
        if not any(row["slot"] == target and row["generation"] == generation for row in after["records"]):
            raise ValueError("Записанную автокопию не удалось подтвердить; другие слоты сохранены")
        return after


def recover(value: str, slot: int | None = None, generation: int | None = None):
    root = directory(value)
    if slot is not None:
        slot_path(root, slot)  # Strict type/range validation even when the directory is empty.
    if generation is not None:
        persistence.integer(generation, 1, MAX_GENERATION)
    if not root.is_dir():
        raise ValueError("Каталог автосохранений не найден")
    with locked(root):
        info = scan(str(root))
        records = info["records"]
        chosen = next((row for row in records if slot is None or row["slot"] == slot), None)
        if chosen is None:
            raise ValueError("Нет исправной автокопии для восстановления")
        if generation is not None and chosen["generation"] != generation:
            raise ValueError("Выбранная автокопия уже изменилась; обновите список")
        record, world, _paused, speed = read_slot(root, chosen["slot"])
        if record["generation"] != chosen["generation"]:
            raise ValueError("Автокопия изменилась во время чтения; попробуйте ещё раз")
        return world, speed, info
