#!/usr/bin/env python3
"""Verify that an updated LMO preserves every entry from a reference LMO."""

import struct
import sys
from pathlib import Path


def entries(path: Path) -> dict[int, tuple[int, bytes]]:
    data = path.read_bytes()
    if len(data) < 4:
        raise ValueError(f"invalid LMO: {path}")
    index_offset = struct.unpack_from(">I", data, len(data) - 4)[0]
    if index_offset >= len(data) or (len(data) - index_offset - 4) % 16:
        raise ValueError(f"invalid LMO index: {path}")
    result: dict[int, tuple[int, bytes]] = {}
    for offset in range(index_offset, len(data) - 4, 16):
        key, plural_count, value_offset, length = struct.unpack_from(">IIII", data, offset)
        result[key] = (plural_count, data[value_offset:value_offset + length])
    return result


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {Path(sys.argv[0]).name} reference.lmo updated.lmo", file=sys.stderr)
        return 2
    reference = entries(Path(sys.argv[1]))
    updated = entries(Path(sys.argv[2]))
    missing = sorted(set(reference) - set(updated))
    changed = sorted(key for key in reference.keys() & updated.keys() if reference[key] != updated[key])
    if missing or changed:
        raise SystemExit(f"LMO comparison failed: missing={len(missing)} changed={len(changed)}")
    print(f"LMO_COMPARE_OK preserved={len(reference)} added={len(updated) - len(reference)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
