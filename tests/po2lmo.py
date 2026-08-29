#!/usr/bin/env python3
"""Compile the simple gettext PO catalog used by this LuCI app to LMO.

The binary layout and SuperFastHash implementation follow LuCI's Apache-2.0
licensed po2lmo and lmo sources. Context and plural entries are supported.
"""

from __future__ import annotations

import ast
import struct
import sys
from pathlib import Path


MASK32 = 0xFFFFFFFF


def u32(value: int) -> int:
    return value & MASK32


def get16(data: bytes, offset: int) -> int:
    return data[offset] | (data[offset + 1] << 8)


def signed_byte(value: int) -> int:
    return value if value < 128 else value - 256


def sfh_hash(data: bytes) -> int:
    length = len(data)
    if not length:
        return 0

    value = length
    blocks, remainder = divmod(length, 4)
    offset = 0
    for _ in range(blocks):
        value = u32(value + get16(data, offset))
        tmp = u32((get16(data, offset + 2) << 11) ^ value)
        value = u32((value << 16) ^ tmp)
        offset += 4
        value = u32(value + (value >> 11))

    if remainder == 3:
        value = u32(value + get16(data, offset))
        value = u32(value ^ (value << 16))
        value = u32(value ^ (signed_byte(data[offset + 2]) << 18))
        value = u32(value + (value >> 11))
    elif remainder == 2:
        value = u32(value + get16(data, offset))
        value = u32(value ^ (value << 11))
        value = u32(value + (value >> 17))
    elif remainder == 1:
        value = u32(value + signed_byte(data[offset]))
        value = u32(value ^ (value << 10))
        value = u32(value + (value >> 1))

    value = u32(value ^ (value << 3))
    value = u32(value + (value >> 5))
    value = u32(value ^ (value << 4))
    value = u32(value + (value >> 17))
    value = u32(value ^ (value << 25))
    value = u32(value + (value >> 6))
    return value


def quoted_value(line: str) -> str:
    quote = line.find('"')
    if quote < 0:
        return ""
    return ast.literal_eval(line[quote:].strip())


def parse_po(path: Path) -> list[dict[str, object]]:
    messages: list[dict[str, object]] = []
    message: dict[str, object] = {"msgstr": {}}
    current: tuple[str, int | None] | None = None

    def finish() -> None:
        nonlocal message, current
        if "msgid" in message or message.get("msgstr"):
            messages.append(message)
        message = {"msgstr": {}}
        current = None

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            finish()
            continue
        if line.startswith("#"):
            continue
        if line.startswith("msgctxt "):
            message["msgctxt"] = quoted_value(line)
            current = ("msgctxt", None)
        elif line.startswith("msgid_plural "):
            message["msgid_plural"] = quoted_value(line)
            current = ("msgid_plural", None)
        elif line.startswith("msgid "):
            if "msgid" in message:
                finish()
            message["msgid"] = quoted_value(line)
            current = ("msgid", None)
        elif line.startswith("msgstr["):
            index = int(line[7:line.index("]")])
            strings = message.setdefault("msgstr", {})
            assert isinstance(strings, dict)
            strings[index] = quoted_value(line)
            current = ("msgstr", index)
        elif line.startswith("msgstr "):
            strings = message.setdefault("msgstr", {})
            assert isinstance(strings, dict)
            strings[0] = quoted_value(line)
            current = ("msgstr", 0)
        elif line.startswith('"') and current:
            value = quoted_value(line)
            field, index = current
            if field == "msgstr":
                strings = message["msgstr"]
                assert isinstance(strings, dict) and index is not None
                strings[index] = str(strings.get(index, "")) + value
            else:
                message[field] = str(message.get(field, "")) + value

    finish()
    return messages


def compile_lmo(messages: list[dict[str, object]]) -> bytes:
    values = bytearray()
    entries: list[tuple[int, int, int, int]] = []

    def append_value(key_id: int, plural_count: int, value: str) -> None:
        encoded = value.encode("utf-8")
        offset = len(values)
        values.extend(encoded)
        values.extend(b"\0" * ((-len(encoded)) % 4))
        entries.append((key_id, plural_count, offset, len(encoded)))

    for message in messages:
        msgid = str(message.get("msgid", ""))
        strings = message.get("msgstr", {})
        assert isinstance(strings, dict)

        if not msgid:
            header = str(strings.get(0, ""))
            for field in header.splitlines():
                if field.lower().startswith("plural-forms: "):
                    append_value(0, 0, field[14:])
                    break
            continue

        context = str(message.get("msgctxt", ""))
        plural = "msgid_plural" in message
        plural_count = max(strings, default=0) + 1
        for index, translation in sorted(strings.items()):
            translation = str(translation)
            if not translation:
                continue
            if context and plural:
                key = f"{context}\x01{msgid}\x02{index}"
            elif context:
                key = f"{context}\x01{msgid}"
            elif plural:
                key = f"{msgid}\x02{index}"
            else:
                key = msgid
            key_id = sfh_hash(key.encode("utf-8"))
            if key_id != sfh_hash(translation.encode("utf-8")):
                append_value(key_id, plural_count, translation)

    entries.sort(key=lambda entry: entry[0])
    index_offset = len(values)
    for entry in entries:
        values.extend(struct.pack(">IIII", *entry))
    values.extend(struct.pack(">I", index_offset))
    return bytes(values)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {Path(sys.argv[0]).name} input.po output.lmo", file=sys.stderr)
        return 2
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    data = compile_lmo(parse_po(source))
    if not data:
        raise SystemExit("empty LMO output")
    destination.write_bytes(data)
    print(f"LMO_OK entries={len(parse_po(source))} bytes={len(data)} path={destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
