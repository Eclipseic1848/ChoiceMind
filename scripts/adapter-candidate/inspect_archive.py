"""隔离环境内的归档只读检查；当前宿主测试仅用合成归档，不执行安装。"""

import gzip
import hashlib
import io
import re
import stat
import tarfile
import unicodedata
import zipfile

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 10_000


def inspect_archive(data: bytes, expected_sha256: str, kind: str) -> dict:
    if (
        not isinstance(data, bytes)
        or not 0 < len(data) <= MAX_ARCHIVE_BYTES
        or not isinstance(expected_sha256, str)
        or re.fullmatch(r"[a-f0-9]{64}", expected_sha256) is None
        or not isinstance(kind, str)
        or kind not in {"TAR", "WHEEL"}
    ):
        raise ValueError("CANDIDATE_ARCHIVE_INVALID")
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("CANDIDATE_ARCHIVE_HASH_MISMATCH")
    entries = []
    names = set()
    files = set()
    parents = set()
    expanded = 0

    def record(name, size, directory, read):
        nonlocal expanded
        path = name.rstrip("/") if directory else name
        segments = path.split("/")
        if (
            not path
            or len(path.encode("utf-8")) > 1024
            or any(part in {"", ".", ".."} for part in segments)
            or any(ord(character) < 32 for character in path)
            or "\\" in path
            or ":" in path
            or size < 0
        ):
            raise ValueError("CANDIDATE_ARCHIVE_PATH_INVALID")
        normalized = unicodedata.normalize("NFC", path).casefold()
        if normalized in names:
            raise ValueError("CANDIDATE_ARCHIVE_DUPLICATE")
        ancestors = {
            "/".join(normalized.split("/")[:index]) for index in range(1, len(segments))
        }
        if ancestors & files or (not directory and normalized in parents):
            raise ValueError("CANDIDATE_ARCHIVE_PATH_CONFLICT")
        if directory and size != 0:
            raise ValueError("CANDIDATE_ARCHIVE_ENTRY_FORBIDDEN")
        names.add(normalized)
        parents.update(ancestors)
        if not directory:
            files.add(normalized)
        expanded += size
        if len(names) > MAX_ENTRIES or expanded > MAX_EXPANDED_BYTES:
            raise ValueError("CANDIDATE_ARCHIVE_LIMIT")
        digest = hashlib.sha256()
        remaining = size
        while remaining:
            chunk = read(min(remaining, 65_536))
            if not chunk:
                raise ValueError("CANDIDATE_ARCHIVE_TRUNCATED")
            digest.update(chunk)
            remaining -= len(chunk)
        entries.append(
            {
                "path": path,
                "directory": directory,
                "bytes": size,
                "sha256": None if directory else digest.hexdigest(),
            }
        )

    try:
        if kind == "TAR":
            # 流式逐项检查，不构建不受控的 getmembers() 列表。
            raw = io.BytesIO(data)
            source = gzip.GzipFile(fileobj=raw) if data.startswith(b"\x1f\x8b") else raw
            with (
                source,
                tarfile.open(fileobj=BoundedReader(source), mode="r|") as archive,
            ):
                for member in archive:
                    if not (member.isfile() or member.isdir()) or member.issparse():
                        raise ValueError("CANDIDATE_ARCHIVE_ENTRY_FORBIDDEN")
                    if member.isdir():
                        record(member.name, member.size, True, None)
                    else:
                        stream = archive.extractfile(member)
                        if stream is None:
                            raise ValueError("CANDIDATE_ARCHIVE_TRUNCATED")
                        with stream:
                            record(member.name, member.size, False, stream.read)
        else:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                if len(archive.infolist()) > MAX_ENTRIES:
                    raise ValueError("CANDIDATE_ARCHIVE_LIMIT")
                for member in archive.infolist():
                    mode = member.external_attr >> 16
                    if member.flag_bits & 1 or stat.S_IFMT(mode) not in {
                        0,
                        stat.S_IFREG,
                        stat.S_IFDIR,
                    }:
                        raise ValueError("CANDIDATE_ARCHIVE_ENTRY_FORBIDDEN")
                    if member.is_dir():
                        record(member.filename, member.file_size, True, None)
                    else:
                        with archive.open(member) as stream:
                            record(
                                member.filename, member.file_size, False, stream.read
                            )
    except (
        tarfile.TarError,
        zipfile.BadZipFile,
        EOFError,
        OSError,
        RuntimeError,
    ) as error:
        raise ValueError("CANDIDATE_ARCHIVE_CORRUPT") from error
    if not entries:
        raise ValueError("CANDIDATE_ARCHIVE_EMPTY")
    return {
        "schemaVersion": "candidate-archive.v1",
        "archiveSha256": expected_sha256,
        "expandedBytes": expanded,
        "entries": sorted(entries, key=lambda entry: entry["path"]),
    }


class BoundedReader:
    """连 TAR 扩展头和填充也计入解压预算，不能只限制普通文件数据。"""

    def __init__(self, source):
        self.source = source
        self.remaining = MAX_EXPANDED_BYTES + MAX_ENTRIES * 2048

    def read(self, size):
        data = self.source.read(min(size, self.remaining + 1))
        self.remaining -= len(data)
        if self.remaining < 0:
            raise ValueError("CANDIDATE_ARCHIVE_LIMIT")
        return data
