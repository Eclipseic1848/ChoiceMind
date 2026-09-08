"""在隔离容器内扫描归档，不执行候选文件，不导出原文或原始扫描日志。"""

import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile
import zipfile

SCANNER_SHA256 = "09d435057df51b800201bc3bbe0820554b1cac3cd98162e9e02b20c8b441b5bd"
SCANNER_BYTES = 23_294_237


def scan_archive_secrets(data, expected_sha256, kind, inspect_archive):
    # inspect_archive 与依赖的标准库由受信任启动器拼入，不导入候选模块。
    executable = pathlib.Path("/usr/local/bin/gitleaks")
    scanner = executable.read_bytes()
    if (
        len(scanner) != SCANNER_BYTES
        or hashlib.sha256(scanner).hexdigest() != SCANNER_SHA256
    ):
        raise ValueError("CANDIDATE_SCANNER_INVALID")
    manifest = inspect_archive(
        data, expected_sha256, "WHEEL" if kind == "WHEEL_BUNDLE" else kind
    )
    if kind != "WHEEL_BUNDLE":
        return _scan_archive(data, expected_sha256, kind, manifest)
    if len(manifest["entries"]) > 1000:
        raise ValueError("CANDIDATE_SCAN_BUNDLE_LIMIT")
    reports = [
        _scan_archive(data, expected_sha256, "WHEEL", manifest, metadata_only=True)
    ]
    expanded = entries = 0
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        for entry in manifest["entries"]:
            if entry["directory"] or not entry["path"].endswith(".whl"):
                raise ValueError("CANDIDATE_SCAN_BUNDLE_INVALID")
            wheel = bundle.read(entry["path"])
            checked = inspect_archive(wheel, entry["sha256"], "WHEEL")
            expanded += checked["expandedBytes"]
            entries += len(checked["entries"])
            if expanded > 256 * 1024 * 1024 or entries > 10_000:
                raise ValueError("CANDIDATE_SCAN_BUNDLE_LIMIT")
            reports.append(_scan_archive(wheel, entry["sha256"], "WHEEL", checked))
    return {
        "schemaVersion": "candidate-wheel-bundle-secrets.v1",
        "archiveSha256": expected_sha256,
        "scannerSha256": SCANNER_SHA256,
        "status": _status(reports),
        "archives": reports,
    }


def _scan_archive(data, expected_sha256, kind, manifest, metadata_only=False):
    executable = pathlib.Path("/usr/local/bin/gitleaks")
    results = []

    def scan(entry, content):
        if (
            len(content) != entry["bytes"]
            or hashlib.sha256(content).hexdigest() != entry["sha256"]
        ):
            raise ValueError("CANDIDATE_SCAN_CONTENT_MISMATCH")
        status = "NOT_RUN"
        if not content:
            status = "EMPTY"
        else:
            try:
                content.decode("utf-8", errors="strict")
                valid_text = b"\0" not in content
            except UnicodeDecodeError:
                valid_text = False
            if valid_text:
                with open("/work/scan.log", "w+b") as log:
                    completed = subprocess.run(
                        [
                            str(executable),
                            "stdin",
                            "--no-banner",
                            "--no-color",
                            "--ignore-gitleaks-allow",
                            "--exit-code",
                            "42",
                            "--redact=100",
                        ],
                        input=content,
                        stdout=subprocess.DEVNULL,
                        stderr=log,
                        env={"PATH": "/usr/bin:/bin"},
                        cwd="/work",
                        check=False,
                    )
                    if log.tell() <= 1024 * 1024:
                        log.seek(0)
                        counts = re.findall(rb"scanned ~([0-9]+) bytes", log.read())
                        if len(counts) == 1 and int(counts[0]) == len(content):
                            if completed.returncode == 0:
                                status = "NO_FINDINGS"
                            elif completed.returncode == 42:
                                status = "FINDINGS"
        results.append(
            {
                "pathSha256": hashlib.sha256(entry["path"].encode("utf-8")).hexdigest(),
                "sha256": entry["sha256"],
                "bytes": entry["bytes"],
                "status": status,
                "kind": entry.get("kind", "FILE"),
            }
        )

    by_path = {
        entry["path"]: entry for entry in manifest["entries"] if not entry["directory"]
    }
    metadata = []
    if kind == "WHEEL":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            metadata.append(archive.comment)
            for member in archive.infolist():
                metadata.extend(
                    [member.filename.encode("utf-8"), member.comment, member.extra]
                )
            if not metadata_only:
                for path, entry in by_path.items():
                    scan(entry, archive.read(path))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
            for member in archive:
                info = member.get_info()
                info["type"] = member.type.decode("ascii")
                metadata.append(json.dumps(info, sort_keys=True).encode("utf-8"))
                if member.isfile():
                    with archive.extractfile(member) as stream:
                        scan(by_path[member.name], stream.read())
    if not metadata_only and len(results) != len(by_path):
        raise ValueError("CANDIDATE_SCAN_COVERAGE_INVALID")
    content = b"\n".join(metadata)
    scan(
        {
            "path": "<archive-metadata>",
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "kind": "METADATA",
        },
        content,
    )
    return {
        "schemaVersion": "candidate-archive-secrets.v1",
        "archiveSha256": expected_sha256,
        "scannerSha256": SCANNER_SHA256,
        "status": _status(results),
        "files": results,
    }


def _status(results):
    if any(item["status"] == "FINDINGS" for item in results):
        return "FINDINGS"
    if not results or any(item["status"] == "NOT_RUN" for item in results):
        return "NOT_RUN"
    return "NO_FINDINGS"
