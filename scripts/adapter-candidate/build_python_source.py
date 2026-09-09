"""仅在受监督容器中构建源码；产物摘要不是安全或行为审查结论。"""

import hashlib
import io
import os
import pathlib
import stat
import subprocess
import sys
import tarfile

import tomllib
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name


def build_python_source(data, sha256, inspect_archive, max_archive_bytes, locked):
    checked = inspect_archive(data, sha256, "TAR")
    root = pathlib.Path("/work/source")
    root.mkdir()
    # 已完整拒绝链接和穿越；只逐文件写入新目录，不调用 extractall。
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        for entry in checked["entries"]:
            target = root / entry["path"]
            if entry["directory"]:
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with (
                    archive.extractfile(entry["path"]) as source,
                    target.open("xb") as output,
                ):
                    while chunk := source.read(65_536):
                        output.write(chunk)
    if not (root / "pyproject.toml").is_file():
        raise ValueError("CANDIDATE_BUILD_PROJECT_MISSING")
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    requirements = project.get("build-system", {}).get("requires")
    if not isinstance(requirements, list) or not all(
        isinstance(item, str) for item in requirements
    ):
        raise ValueError("CANDIDATE_BUILD_LOCK_INVALID")
    versions = {canonicalize_name(item["name"]): item["version"] for item in locked}
    for item in requirements:
        requirement = Requirement(item)
        if requirement.marker is not None and not requirement.marker.evaluate():
            continue
        version = versions.get(canonicalize_name(requirement.name))
        # 暂不把 extras 或远程构建需求当作已闭合；后续需锁定对应依赖后再支持。
        if (
            requirement.url
            or requirement.extras
            or version is None
            or version not in requirement.specifier
        ):
            raise ValueError("CANDIDATE_BUILD_LOCK_INCOMPLETE")
    completed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import runpy,sys; sys.path.append('/work/site'); runpy.run_module('pip',run_name='__main__')",
            "--isolated",
            "--disable-pip-version-check",
            "wheel",
            "--no-index",
            "--no-cache-dir",
            "--no-build-isolation",
            "--check-build-dependencies",
            "--no-deps",
            "--wheel-dir=/work/built",
            str(root),
        ],
        env={
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "TMPDIR": "/work",
            "PYTHONPATH": "/work/site",
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("CANDIDATE_SOURCE_BUILD_FAILED")
    outputs = list(pathlib.Path("/work/built").glob("*.whl"))
    if len(outputs) != 1:
        raise ValueError("CANDIDATE_BUILD_OUTPUT_INVALID")
    # 构建代码可写工作区；产物仍按不可信输入限额读取、拒绝链接/特殊文件。
    descriptor = os.open(outputs[0], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_archive_bytes:
            raise ValueError("CANDIDATE_BUILD_OUTPUT_INVALID")
        wheel = stream.read(max_archive_bytes + 1)
    digest = hashlib.sha256(wheel).hexdigest()
    manifest = inspect_archive(wheel, digest, "WHEEL")
    return {
        "sourceSha256": sha256,
        "wheelSha256": digest,
        "wheelBytes": len(wheel),
        "expandedBytes": manifest["expandedBytes"],
        "status": "BUILD_EXITED",
        "runtimeDependencies": "NOT_RUN",
        "reviewStatus": "NOT_RUN",
    }, wheel
