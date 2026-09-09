"""在隔离容器中组装已核验原字节，不展开或导入 wheel。"""

import hashlib
import io
import json
import re
import sys
import zipfile


def pack_wheels(stream):
    limit = 64 * 1024 * 1024
    header_size = int.from_bytes(stream.read(4), "big")
    if not 0 < header_size <= 1024 * 1024:
        raise ValueError("CANDIDATE_BUNDLE_INVALID")
    entries = json.loads(stream.read(header_size))
    if not isinstance(entries, list) or not 0 < len(entries) <= 1000:
        raise ValueError("CANDIDATE_BUNDLE_INVALID")
    output = io.BytesIO()
    names = set()
    total = 4 + header_size
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as bundle:
        for entry in entries:
            if (
                not isinstance(entry, dict)
                or set(entry) != {"filename", "size", "sha256"}
                or not isinstance(entry["filename"], str)
                or re.fullmatch(
                    r"[A-Za-z0-9_][A-Za-z0-9_.+\-]{0,239}\.whl", entry["filename"]
                )
                is None
                or type(entry["size"]) is not int
                or not 0 < entry["size"] <= limit
                or not isinstance(entry["sha256"], str)
                or re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]) is None
                or entry["filename"].lower() in names
            ):
                raise ValueError("CANDIDATE_BUNDLE_INVALID")
            names.add(entry["filename"].lower())
            total += entry["size"]
            if total > limit:
                raise ValueError("CANDIDATE_BUNDLE_LIMIT")
            data = stream.read(entry["size"])
            if (
                len(data) != entry["size"]
                or hashlib.sha256(data).hexdigest() != entry["sha256"]
            ):
                raise ValueError("CANDIDATE_BUNDLE_HASH_MISMATCH")
            # 固定时间戳，避免同一锁定集合每次产生不同 bundle 身份。
            bundle.writestr(zipfile.ZipInfo(entry["filename"]), data)
    if stream.read(1) or output.tell() > limit:
        raise ValueError("CANDIDATE_BUNDLE_LIMIT")
    return output.getvalue()


try:
    sys.stdout.buffer.write(pack_wheels(sys.stdin.buffer))
except (ValueError, TypeError, KeyError, OSError, OverflowError):
    sys.exit(2)
