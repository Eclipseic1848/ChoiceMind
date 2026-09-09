"""在断网容器内复用 pip 求解候选 wheel 集；不安装或运行候选。"""

import email.parser
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse
import zipfile

from pip._vendor.packaging.requirements import Requirement


def resolve_wheels(data, expected_sha256, roots, inspect_archive, max_expanded_bytes):
    manifest = inspect_archive(data, expected_sha256, "WHEEL")
    if not 0 < len(manifest["entries"]) <= 1000:
        raise ValueError("CANDIDATE_CATALOGUE_LIMIT")
    if not isinstance(roots, list) or not 0 < len(roots) <= 1000:
        raise ValueError("CANDIDATE_ROOTS_INVALID")
    requirements = []
    for value in roots:
        if not isinstance(value, str) or len(value) > 1000:
            raise ValueError("CANDIDATE_ROOTS_INVALID")
        requirement = Requirement(value)
        if requirement.url:
            raise ValueError("CANDIDATE_DIRECT_DEPENDENCY_DENIED")
        requirements.append(str(requirement))
    wheelhouse = pathlib.Path("/work/wheels")
    wheelhouse.mkdir()
    candidates = {}
    expanded = 0
    entry_count = 0
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        for entry in manifest["entries"]:
            filename = entry["path"]
            if re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.+\-]*\.whl", filename) is None:
                raise ValueError("CANDIDATE_WHEEL_FILENAME_INVALID")
            wheel = bundle.read(filename)
            sha256 = hashlib.sha256(wheel).hexdigest()
            checked = inspect_archive(wheel, sha256, "WHEEL")
            expanded += checked["expandedBytes"]
            entry_count += len(checked["entries"])
            if expanded > max_expanded_bytes or entry_count > 10000:
                raise ValueError("CANDIDATE_ARCHIVE_LIMIT")
            with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
                paths = [
                    name
                    for name in archive.namelist()
                    if name.endswith(".dist-info/METADATA")
                ]
                if len(paths) != 1:
                    raise ValueError("CANDIDATE_METADATA_INVALID")
                metadata = email.parser.BytesParser().parsebytes(archive.read(paths[0]))
                for value in metadata.get_all("Requires-Dist", []):
                    if Requirement(value).url:
                        raise ValueError("CANDIDATE_DIRECT_DEPENDENCY_DENIED")
            candidates[filename] = sha256
            (wheelhouse / filename).write_bytes(wheel)
    pathlib.Path("/work/roots.txt").write_text(
        "\n".join(requirements), encoding="utf-8"
    )
    completed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-m",
            "pip",
            "--isolated",
            "--disable-pip-version-check",
            "install",
            "--dry-run",
            "--ignore-installed",
            "--no-index",
            "--find-links=/work/wheels",
            "--only-binary=:all:",
            "--no-cache-dir",
            "--report=/work/resolved.json",
            "-r",
            "/work/roots.txt",
        ],
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "TMPDIR": "/work"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("CANDIDATE_RESOLUTION_FAILED")
    report = json.loads(pathlib.Path("/work/resolved.json").read_text(encoding="utf-8"))
    locked = []
    names = set()
    for item in report["install"]:
        url = urllib.parse.urlsplit(item["download_info"]["url"])
        path = urllib.parse.unquote(url.path)
        filename = pathlib.PurePosixPath(path).name
        if (
            url.scheme != "file"
            or url.netloc
            or path != f"/work/wheels/{filename}"
            or filename not in candidates
        ):
            raise ValueError("CANDIDATE_RESOLUTION_SOURCE_INVALID")
        name = re.sub(r"[-_.]+", "-", item["metadata"]["name"]).lower()
        version = item["metadata"]["version"]
        if (
            name in names
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-]*", name)
            or not re.fullmatch(r"[0-9][A-Za-z0-9.!+_\-]*", version)
        ):
            raise ValueError("CANDIDATE_RESOLUTION_IDENTITY_INVALID")
        names.add(name)
        locked.append(
            {
                "filename": filename,
                "name": name,
                "version": version,
                "sha256": candidates[filename],
            }
        )
    selected = io.BytesIO()
    with zipfile.ZipFile(selected, "w", compression=zipfile.ZIP_STORED) as archive:
        for item in sorted(locked, key=lambda item: item["filename"]):
            archive.writestr(
                zipfile.ZipInfo(item["filename"]),
                (wheelhouse / item["filename"]).read_bytes(),
            )
    return {
        "locked": sorted(locked, key=lambda item: item["name"]),
        "pipVersion": report["pip_version"],
        "reviewStatus": "NOT_RUN",
    }, selected.getvalue()
