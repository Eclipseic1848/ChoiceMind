"""只在隔离环境解析 wheel 元数据；不执行候选模块。"""

import email.parser
import io
import zipfile

from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import Version


def read_dependencies(wheel, header, inspect_archive):
    inspect_archive(wheel, header["sha256"], "WHEEL")
    with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
        paths = [
            name for name in archive.namelist() if name.endswith(".dist-info/METADATA")
        ]
        if len(paths) != 1:
            raise ValueError("CANDIDATE_METADATA_INVALID")
        metadata = email.parser.BytesParser().parsebytes(archive.read(paths[0]))
    if canonicalize_name(metadata["Name"]) != header["name"] or Version(
        metadata["Version"]
    ) != Version(header["version"]):
        raise ValueError("CANDIDATE_METADATA_IDENTITY_INVALID")
    dependencies = []
    for text in metadata.get_all("Requires-Dist", []):
        requirement = Requirement(text)
        if requirement.url:
            raise ValueError("CANDIDATE_DIRECT_DEPENDENCY_DENIED")
        if requirement.marker and not any(
            requirement.marker.evaluate({"extra": extra})
            for extra in ["", *header["extras"]]
        ):
            continue
        dependencies.append(
            {
                "packageName": canonicalize_name(requirement.name),
                "specifier": str(requirement.specifier),
                "extras": sorted(
                    canonicalize_name(extra) for extra in requirement.extras
                ),
            }
        )
        if len(dependencies) > 1000:
            raise ValueError("CANDIDATE_DEPENDENCY_LIMIT")
    return dependencies
