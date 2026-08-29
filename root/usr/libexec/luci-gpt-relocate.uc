#!/usr/bin/ucode

// SPDX-License-Identifier: GPL-3.0-or-later
// Relocate the secondary GPT structures to the end of a truncated raw image.

import { open, stat } from 'fs';

const SECTOR_SIZE = 512;
const MAX_ENTRY_ARRAY_BYTES = 16 * 1024 * 1024;
const UINT32_MAX = 0xffffffff;

function fail(message) {
	warn(`GPT relocation failed: ${message}\n`);
	exit(1);
}

function read_at(file, offset, size) {
	if (!file.seek(offset, 0))
		fail(`unable to seek to byte ${offset}`);

	let data = file.read(size);
	if (data == null || length(data) != size)
		fail(`unable to read ${size} bytes at byte ${offset}`);

	return data;
}

function write_at(file, offset, data) {
	if (!file.seek(offset, 0))
		fail(`unable to seek to byte ${offset}`);

	if (file.write(data) != length(data))
		fail(`unable to write ${length(data)} bytes at byte ${offset}`);
}

function read_le(data, offset, size) {
	let value = 0;
	let factor = 1;

	for (let i = 0; i < size; i++) {
		value += ord(data, offset + i) * factor;
		factor *= 256;
	}

	return value;
}

function encode_le(value, size) {
	let data = '';

	for (let i = 0; i < size; i++) {
		data += chr(value % 256);
		value /= 256;
	}

	return data;
}

function replace_bytes(data, offset, replacement) {
	return substr(data, 0, offset) + replacement + substr(data, offset + length(replacement));
}

function put_le(data, offset, size, value) {
	return replace_bytes(data, offset, encode_le(value, size));
}

function zero_bytes(size) {
	let data = '';

	for (let i = 0; i < size; i++)
		data += chr(0);

	return data;
}

function crc32(data) {
	let crc = UINT32_MAX;

	for (let i = 0; i < length(data); i++) {
		crc ^= ord(data, i);

		for (let bit = 0; bit < 8; bit++) {
			if (crc & 1)
				crc = (crc >> 1) ^ 0xedb88320;
			else
				crc >>= 1;

			crc &= UINT32_MAX;
		}
	}

	return (~crc) & UINT32_MAX;
}

function header_with_crc(header, header_size) {
	header = put_le(header, 16, 4, 0);
	return put_le(header, 16, 4, crc32(substr(header, 0, header_size)));
}

let split_mode = false;
let image_size;
let first_path;
let last_path;
let last_start = 0;
let first_size;

if (length(ARGV) == 1) {
	first_path = ARGV[0];
	last_path = first_path;

	let metadata = stat(first_path);
	if (metadata == null || metadata.type != 'file')
		fail('the image is not a regular file');

	image_size = metadata.size;
	first_size = metadata.size;
}
else if (length(ARGV) == 5 && ARGV[0] == '--split') {
	split_mode = true;
	first_path = ARGV[1];
	last_path = ARGV[2];
	image_size = int(ARGV[3]);
	last_start = int(ARGV[4]);

	let first_metadata = stat(first_path);
	let last_metadata = stat(last_path);
	if (first_metadata == null || first_metadata.type != 'file' || last_metadata == null || last_metadata.type != 'file')
		fail('an image part is not a regular file');

	first_size = first_metadata.size;
	if (first_size > last_start || last_start < 0 || image_size <= last_start || last_metadata.size != image_size - last_start)
		fail('the split image geometry is inconsistent');
}
else {
	fail('usage: luci-gpt-relocate.uc IMAGE or luci-gpt-relocate.uc --split FIRST_PART LAST_PART IMAGE_BYTES LAST_PART_OFFSET');
}

if (image_size < 68 * SECTOR_SIZE || image_size % SECTOR_SIZE)
	fail('the image size is not a valid 512-byte sector count');

let first_file = open(first_path, 'r+');
let last_file = split_mode ? open(last_path, 'r+') : first_file;

if (first_file == null || last_file == null)
	fail('unable to open the image for update');

function read_image(offset, size) {
	if (!split_mode)
		return read_at(first_file, offset, size);
	if (offset >= 0 && offset + size <= first_size)
		return read_at(first_file, offset, size);
	if (offset >= last_start && offset + size <= image_size)
		return read_at(last_file, offset - last_start, size);

	fail(`requested read at byte ${offset} crosses an unavailable split-image region`);
}

function write_image(offset, data) {
	if (!split_mode)
		return write_at(first_file, offset, data);
	if (offset >= 0 && offset + length(data) <= first_size)
		return write_at(first_file, offset, data);
	if (offset >= last_start && offset + length(data) <= image_size)
		return write_at(last_file, offset - last_start, data);

	fail(`requested write at byte ${offset} crosses an unavailable split-image region`);
}

const image_sectors = image_size / SECTOR_SIZE;

let mbr = read_image(0, SECTOR_SIZE);
let primary = read_image(SECTOR_SIZE, SECTOR_SIZE);

if (substr(primary, 0, 8) != 'EFI PART')
	fail('no primary GPT header was found');

const header_size = read_le(primary, 12, 4);
const stored_header_crc = read_le(primary, 16, 4);
const current_lba = read_le(primary, 24, 8);
const first_usable_lba = read_le(primary, 40, 8);
const entries_lba = read_le(primary, 72, 8);
const entry_count = read_le(primary, 80, 4);
const entry_size = read_le(primary, 84, 4);
const stored_entries_crc = read_le(primary, 88, 4);

if (header_size < 92 || header_size > SECTOR_SIZE)
	fail(`unsupported GPT header size ${header_size}`);

if (current_lba != 1)
	fail(`unexpected primary GPT location ${current_lba}`);

if (entry_count < 1 || entry_count > 4096 || entry_size < 128 || entry_size > 4096 || entry_size % 8)
	fail('unsupported GPT partition entry geometry');

const entry_bytes = entry_count * entry_size;
if (entry_bytes > MAX_ENTRY_ARRAY_BYTES)
	fail('the GPT partition entry array is too large');

const entry_sectors = (entry_bytes + SECTOR_SIZE - 1) / SECTOR_SIZE;
if (entries_lba < 2 || entries_lba + entry_sectors > first_usable_lba)
	fail('the primary GPT partition array has invalid bounds');

let primary_crc_input = put_le(primary, 16, 4, 0);
if (crc32(substr(primary_crc_input, 0, header_size)) != stored_header_crc)
	fail('the primary GPT header checksum is invalid');

let entries = read_image(entries_lba * SECTOR_SIZE, entry_sectors * SECTOR_SIZE);
if (crc32(substr(entries, 0, entry_bytes)) != stored_entries_crc)
	fail('the GPT partition array checksum is invalid');

const backup_lba = image_sectors - 1;
const backup_entries_lba = backup_lba - entry_sectors;
const last_usable_lba = backup_entries_lba - 1;

if (last_usable_lba < first_usable_lba)
	fail('the shortened image is too small for GPT metadata');

for (let index = 0; index < entry_count; index++) {
	let offset = index * entry_size;
	let used = false;

	for (let byte = 0; byte < 16; byte++) {
		if (ord(entries, offset + byte) != 0) {
			used = true;
			break;
		}
	}

	if (!used)
		continue;

	let first_lba = read_le(entries, offset + 32, 8);
	let last_lba = read_le(entries, offset + 40, 8);

	if (first_lba < first_usable_lba || last_lba < first_lba || last_lba > last_usable_lba)
		fail(`partition ${index + 1} does not fit in the shortened image`);
}

primary = put_le(primary, 32, 8, backup_lba);
primary = put_le(primary, 48, 8, last_usable_lba);
primary = header_with_crc(primary, header_size);

let backup = primary;
backup = put_le(backup, 24, 8, backup_lba);
backup = put_le(backup, 32, 8, 1);
backup = put_le(backup, 72, 8, backup_entries_lba);
backup = header_with_crc(backup, header_size);

let protective_entry = -1;
for (let index = 0; index < 4; index++) {
	let offset = 446 + index * 16;
	if (ord(mbr, offset + 4) == 0xee) {
		protective_entry = offset;
		break;
	}
}

if (protective_entry < 0)
	fail('the protective MBR entry is missing');

let protective_sectors = image_sectors - 1;
if (protective_sectors > UINT32_MAX)
	protective_sectors = UINT32_MAX;

mbr = put_le(mbr, protective_entry + 12, 4, protective_sectors);

let backup_entries = substr(entries, 0, entry_bytes);
backup_entries += zero_bytes(entry_sectors * SECTOR_SIZE - entry_bytes);

write_image(backup_entries_lba * SECTOR_SIZE, backup_entries);
write_image(backup_lba * SECTOR_SIZE, backup);
write_image(SECTOR_SIZE, primary);
write_image(0, mbr);
first_file.close();
if (split_mode)
	last_file.close();

printf('GPT_OK sectors=%u backup_lba=%u last_usable_lba=%u\n',
	image_sectors, backup_lba, last_usable_lba);
