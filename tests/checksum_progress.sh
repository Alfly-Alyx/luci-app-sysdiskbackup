#!/bin/sh

# Exercise the /proc/<pid>/fdinfo based checksum progress counter used by the
# backend. The input is only read; temporary state is kept under /tmp.

set -eu

[ "$#" -eq 1 ] || {
	echo "Usage: $0 INPUT_FILE" >&2
	exit 2
}

input="$1"
test_dir="/tmp/luci-sysdiskbackup-checksum-test-$$"
progress="$test_dir/progress"
progress_tmp="$progress.tmp"
hash_file="$test_dir/hash"

cleanup() {
	rm -rf "$test_dir"
}

trap cleanup EXIT INT TERM
mkdir "$test_dir"

size="$(ls -ln "$input" 2>/dev/null | awk 'NR == 1 { print $5; exit }')"
case "$size" in
	''|*[!0-9]*) echo "Unable to determine input size" >&2; exit 1 ;;
esac

(
	cat < "$input" &
	reader_pid=$!
	printf '%s 0\n' "$reader_pid" > "$progress_tmp"
	mv "$progress_tmp" "$progress"
	wait "$reader_pid"
) | sha256sum > "$hash_file" &
hash_pid=$!

last=0
updates=0
while kill -0 "$hash_pid" 2>/dev/null; do
	reader_pid=""
	completed=""
	if IFS=' ' read -r reader_pid completed < "$progress" 2>/dev/null; then
		position="$(awk '$1 == "pos:" { print $2; exit }' "/proc/$reader_pid/fdinfo/0" 2>/dev/null)"
		case "$position" in
			''|*[!0-9]*) position=0 ;;
		esac
		if [ "$position" -gt "$last" ]; then
			last="$position"
			updates=$((updates + 1))
			printf 'progress=%s/%s\n' "$last" "$size"
		fi
	fi
	sleep 1
done

wait "$hash_pid"
hash="$(awk 'NR == 1 { print $1; exit }' "$hash_file")"
[ "${#hash}" -eq 64 ]
[ "$last" -gt 0 ]
[ "$updates" -ge 2 ]
printf 'CHECKSUM_PROGRESS_OK updates=%s last=%s size=%s sha256=%s\n' "$updates" "$last" "$size" "$hash"
