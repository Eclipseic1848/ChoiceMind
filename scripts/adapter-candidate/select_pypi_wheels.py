"""使用固定 pip 的 packaging 在隔离环境筛选平台兼容 wheel。"""

import hashlib
import json
import platform
import re
import sys

from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.tags import sys_tags
from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
from pip._vendor.packaging.version import InvalidVersion, Version


def select_wheels(name, specifier, data):
    metadata = json.loads(data)
    if canonicalize_name(metadata["info"]["name"]) != name or not isinstance(
        metadata["releases"], dict
    ):
        raise ValueError("CANDIDATE_INDEX_IDENTITY_INVALID")
    constraint = SpecifierSet(specifier)
    exact = len(constraint) == 1 and any(
        item.operator in {"==", "==="} and "*" not in item.version
        for item in constraint
    )
    rank = {tag: index for index, tag in enumerate(sys_tags())}
    selected = []
    for version, files in metadata["releases"].items():
        try:
            parsed_version = Version(version)
        except InvalidVersion:
            continue
        if not constraint.contains(
            parsed_version, prereleases=bool(constraint.prereleases)
        ):
            continue
        matches = []
        for file in files:
            if file["packagetype"] != "bdist_wheel" or (
                file.get("yanked", False) and not exact
            ):
                continue
            filename = file["filename"]
            wheel_name, wheel_version, build, tags = parse_wheel_filename(filename)
            if wheel_name != name or wheel_version != parsed_version:
                raise ValueError("CANDIDATE_INDEX_WHEEL_IDENTITY_INVALID")
            supported = tags & rank.keys()
            if not supported or (
                file.get("requires_python")
                and not SpecifierSet(file["requires_python"]).contains(
                    platform.python_version(), prereleases=True
                )
            ):
                continue
            if re.fullmatch(r"[a-f0-9]{64}", file["digests"]["sha256"]) is None:
                raise ValueError("CANDIDATE_INDEX_DIGEST_INVALID")
            matches.append(
                (
                    min(rank[tag] for tag in supported),
                    build,
                    filename,
                    file["digests"]["sha256"],
                )
            )
        if matches:
            # 同版本优先更匹配的平台标签，再按 wheel build tag 选择。
            preferred_rank = min(item[0] for item in matches)
            _, _, filename, sha256 = max(
                item for item in matches if item[0] == preferred_rank
            )
            selected.append(
                {
                    "filename": filename,
                    "name": name,
                    "version": version,
                    "sha256": sha256,
                }
            )
            if len(selected) > 1000:
                raise ValueError("CANDIDATE_INDEX_LIMIT")
    return sorted(selected, key=lambda item: Version(item["version"]), reverse=True)


try:
    size = int.from_bytes(sys.stdin.buffer.read(4), "big")
    if not 0 < size <= 4096:
        raise ValueError("CANDIDATE_INDEX_INPUT_INVALID")
    header = json.loads(sys.stdin.buffer.read(size))
    data = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if (
        len(data) > 4 * 1024 * 1024
        or hashlib.sha256(data).hexdigest() != header["sha256"]
    ):
        raise ValueError("CANDIDATE_INDEX_INPUT_INVALID")
    print(
        json.dumps(
            {
                "candidates": select_wheels(header["name"], header["specifier"], data),
                "pythonVersion": platform.python_version(),
                "platform": sys.platform,
                "reviewStatus": "NOT_RUN",
            }
        )
    )
except (ValueError, KeyError, TypeError, AttributeError):
    sys.exit(2)
