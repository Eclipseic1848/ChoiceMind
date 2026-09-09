"""仅在断网受监督容器内检查并安装已锁定 wheel；不执行候选入口。"""

import io
import pathlib
import re
import subprocess
import sys
import zipfile


def install_wheels(data, expected_sha256, locked, inspect_archive, max_expanded_bytes):
    # inspect_archive 由受信任启动器拼入；不从候选目录导入模块。
    manifest = inspect_archive(data, expected_sha256, "WHEEL")
    if not isinstance(locked, list) or not 0 < len(locked) <= 1000:
        raise ValueError("CANDIDATE_LOCK_INVALID")
    filenames = set()
    names = set()
    requirements = []
    for item in locked:
        if (
            not isinstance(item, dict)
            or set(item) != {"filename", "name", "version", "sha256"}
            or not all(isinstance(value, str) for value in item.values())
            or re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.+\-]*\.whl", item["filename"])
            is None
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-]*", item["name"]) is None
            or re.fullmatch(r"[0-9][A-Za-z0-9.!+_\-]*", item["version"]) is None
            or re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) is None
        ):
            raise ValueError("CANDIDATE_LOCK_INVALID")
        name = re.sub(r"[-_.]+", "-", item["name"]).lower()
        if name in names or item["filename"] in filenames:
            raise ValueError("CANDIDATE_LOCK_DUPLICATE")
        names.add(name)
        filenames.add(item["filename"])
        requirements.append(
            f"{item['name']}=={item['version']} --hash=sha256:{item['sha256']}"
        )
    if {entry["path"] for entry in manifest["entries"]} != filenames:
        raise ValueError("CANDIDATE_LOCK_CONTENT_MISMATCH")
    wheelhouse = pathlib.Path("/work/wheels")
    wheelhouse.mkdir()
    expanded = 0
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        for item in locked:
            wheel = bundle.read(item["filename"])
            checked = inspect_archive(wheel, item["sha256"], "WHEEL")
            expanded += checked["expandedBytes"]
            if expanded > max_expanded_bytes:
                raise ValueError("CANDIDATE_ARCHIVE_LIMIT")
            (wheelhouse / item["filename"]).write_bytes(wheel)
    requirements_path = pathlib.Path("/work/requirements.txt")
    requirements_path.write_text("\n".join(requirements), encoding="utf-8")
    # 不使用 --no-deps：遗漏的传递依赖必须由 pip 拒绝，不能误报闭包完成。
    completed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-m",
            "pip",
            "--isolated",
            "--disable-pip-version-check",
            "install",
            "--no-index",
            "--find-links=/work/wheels",
            "--require-hashes",
            "--only-binary=:all:",
            "--ignore-installed",
            "--no-cache-dir",
            "--no-compile",
            "--target=/work/site",
            "--report=/work/install.json",
            "-r",
            str(requirements_path),
        ],
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "TMPDIR": "/work"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("CANDIDATE_OFFLINE_INSTALL_FAILED")
    # 安装结果只是阶段证据；候选未运行，不形成安全通过或正式启用批准。
    return {
        "schemaVersion": "candidate-wheel-install.v1",
        "bundleSha256": expected_sha256,
        "lockedWheels": len(locked),
        "expandedBytes": expanded,
        "installed": True,
        "reviewStatus": "NOT_RUN",
    }
