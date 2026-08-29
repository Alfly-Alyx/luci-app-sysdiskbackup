#!/usr/bin/env python3
"""Create and validate a small GPT image used to test luci-gpt-relocate.uc."""

from __future__ import annotations

import argparse
import binascii
import struct
from pathlib import Path


SECTOR = 512
ENTRY_COUNT = 128
ENTRY_SIZE = 128
ENTRY_BYTES = ENTRY_COUNT * ENTRY_SIZE
ENTRY_SECTORS = ENTRY_BYTES // SECTOR
SOURCE_SECTORS = 32768
PARTITION_FIRST = 2048
PARTITION_LAST = 8191
TARGET_SECTORS = PARTITION_LAST + 1 + 2048
SPLIT_PART_BYTES = 2 * 1024 * 1024
DISK_GUID = bytes.fromhex("00112233445566778899aabbccddeeff")
TYPE_GUID = bytes.fromhex("af3dc60f838472478e793d69d8477de4")
UNIQUE_GUID = bytes.fromhex("102132435465768798a9bacbdcedfe0f")


def crc32(data: bytes) -> int:
    return binascii.crc32(data) & 0xFFFFFFFF


def make_header(
    *, current: int, backup: int, last_usable: int, entries_lba: int, entries_crc: int
) -> bytes:
    header = bytearray(SECTOR)
    struct.pack_into(
        "<8sIIIIQQQQ16sQIII",
        header,
        0,
        b"EFI PART",
        0x00010000,
        92,
        0,
        0,
        current,
        backup,
        34,
        last_usable,
        DISK_GUID,
        entries_lba,
        ENTRY_COUNT,
        ENTRY_SIZE,
        entries_crc,
    )
    struct.pack_into("<I", header, 16, crc32(header[:92]))
    return bytes(header)


def create_fixture(path: Path) -> None:
    entries = bytearray(ENTRY_BYTES)
    name = "OpenWrt test".encode("utf-16le")
    struct.pack_into(
        "<16s16sQQQ72s",
        entries,
        0,
        TYPE_GUID,
        UNIQUE_GUID,
        PARTITION_FIRST,
        PARTITION_LAST,
        0,
        name.ljust(72, b"\0"),
    )
    entries_crc = crc32(entries)

    image = bytearray(SOURCE_SECTORS * SECTOR)
    image[510:512] = b"\x55\xaa"
    struct.pack_into(
        "<B3sB3sII",
        image,
        446,
        0,
        b"\x00\x02\x00",
        0xEE,
        b"\xff\xff\xff",
        1,
        SOURCE_SECTORS - 1,
    )

    primary = make_header(
        current=1,
        backup=SOURCE_SECTORS - 1,
        last_usable=SOURCE_SECTORS - 34,
        entries_lba=2,
        entries_crc=entries_crc,
    )
    backup = make_header(
        current=SOURCE_SECTORS - 1,
        backup=1,
        last_usable=SOURCE_SECTORS - 34,
        entries_lba=SOURCE_SECTORS - 33,
        entries_crc=entries_crc,
    )

    image[SECTOR : 2 * SECTOR] = primary
    image[2 * SECTOR : (2 + ENTRY_SECTORS) * SECTOR] = entries
    backup_entries = (SOURCE_SECTORS - 33) * SECTOR
    image[backup_entries : backup_entries + ENTRY_BYTES] = entries
    image[(SOURCE_SECTORS - 1) * SECTOR :] = backup

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(image[: TARGET_SECTORS * SECTOR])
    print(f"FIXTURE_OK path={path} sectors={TARGET_SECTORS}")


def parse_header(data: bytes, lba: int) -> dict[str, int | bytes]:
    sector = data[lba * SECTOR : (lba + 1) * SECTOR]
    values = struct.unpack_from("<8sIIIIQQQQ16sQIII", sector)
    keys = (
        "signature",
        "revision",
        "header_size",
        "header_crc",
        "reserved",
        "current",
        "backup",
        "first_usable",
        "last_usable",
        "disk_guid",
        "entries_lba",
        "entry_count",
        "entry_size",
        "entries_crc",
    )
    result = dict(zip(keys, values, strict=True))
    crc_input = bytearray(sector[: result["header_size"]])
    struct.pack_into("<I", crc_input, 16, 0)
    assert crc32(crc_input) == result["header_crc"]
    return result


def validate_fixture(path: Path) -> None:
    data = path.read_bytes()
    assert len(data) % SECTOR == 0
    sectors = len(data) // SECTOR
    assert sectors == TARGET_SECTORS
    assert data[510:512] == b"\x55\xaa"
    assert data[446 + 4] == 0xEE
    assert struct.unpack_from("<I", data, 446 + 12)[0] == sectors - 1

    primary = parse_header(data, 1)
    backup = parse_header(data, sectors - 1)
    expected_entries_lba = sectors - 1 - ENTRY_SECTORS
    expected_last_usable = expected_entries_lba - 1

    assert primary["current"] == 1
    assert primary["backup"] == sectors - 1
    assert primary["last_usable"] == expected_last_usable
    assert primary["entries_lba"] == 2
    assert backup["current"] == sectors - 1
    assert backup["backup"] == 1
    assert backup["last_usable"] == expected_last_usable
    assert backup["entries_lba"] == expected_entries_lba

    primary_entries = data[2 * SECTOR : 2 * SECTOR + ENTRY_BYTES]
    backup_entries = data[
        expected_entries_lba * SECTOR : expected_entries_lba * SECTOR + ENTRY_BYTES
    ]
    assert primary_entries == backup_entries
    assert crc32(primary_entries) == primary["entries_crc"] == backup["entries_crc"]
    assert struct.unpack_from("<Q", primary_entries, 40)[0] == PARTITION_LAST
    print(f"VALIDATE_OK path={path} sectors={sectors}")


def split_fixture(path: Path) -> None:
    data = path.read_bytes()
    parts = []
    for index, offset in enumerate(range(0, len(data), SPLIT_PART_BYTES), 1):
        part = Path(f"{path}.part{index:03d}")
        part.write_bytes(data[offset : offset + SPLIT_PART_BYTES])
        parts.append(part)
    last_start = (len(parts) - 1) * SPLIT_PART_BYTES
    print(
        f"SPLIT_OK path={path} parts={len(parts)} bytes={len(data)} "
        f"last_start={last_start}"
    )


def validate_split_fixture(path: Path) -> None:
    parts = sorted(path.parent.glob(f"{path.name}.part[0-9][0-9][0-9]"))
    if not parts:
        raise ValueError(f"no split parts found for {path}")
    reassembled = Path(f"{path}.reassembled")
    reassembled.write_bytes(b"".join(part.read_bytes() for part in parts))
    validate_fixture(reassembled)
    print(f"SPLIT_VALIDATE_OK parts={len(parts)} path={path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=("create", "validate", "split", "validate-split")
    )
    parser.add_argument("path", type=Path)
    args = parser.parse_args()

    if args.action == "create":
        create_fixture(args.path)
    elif args.action == "validate":
        validate_fixture(args.path)
    elif args.action == "split":
        split_fixture(args.path)
    else:
        validate_split_fixture(args.path)


if __name__ == "__main__":
    main()
