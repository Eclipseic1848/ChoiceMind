"""在隔离容器内扫描归档，不执行候选文件，不导出原文或原始扫描日志。"""

import hashlib
import io
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
    manifest = inspect_archive(data, expected_sha256, kind)
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
            }
        )

    by_path = {
        entry["path"]: entry for entry in manifest["entries"] if not entry["directory"]
    }
    if kind == "WHEEL":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for path, entry in by_path.items():
                scan(entry, archive.read(path))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
            for member in archive:
                if member.isfile():
                    with archive.extractfile(member) as stream:
                        scan(by_path[member.name], stream.read())
    if len(results) != len(by_path):
        raise ValueError("CANDIDATE_SCAN_COVERAGE_INVALID")
    status = "NO_FINDINGS"
    if not results or any(item["status"] == "NOT_RUN" for item in results):
        status = "NOT_RUN"
    if any(item["status"] == "FINDINGS" for item in results):
        status = "FINDINGS"
    return {
        "schemaVersion": "candidate-archive-secrets.v1",
        "archiveSha256": expected_sha256,
        "scannerSha256": SCANNER_SHA256,
        "status": status,
        "files": results,
    }
