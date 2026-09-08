import hashlib
import io
import stat
import tarfile
import unittest
import zipfile
from unittest.mock import patch

from inspect_archive import inspect_archive


def tar_bytes(name="package/index.js", link=False):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        member = tarfile.TarInfo(name)
        if link:
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            archive.addfile(member)
        else:
            member.size = 4
            archive.addfile(member, io.BytesIO(b"code"))
    return buffer.getvalue()


def inspect(data, kind="TAR"):
    return inspect_archive(data, hashlib.sha256(data).hexdigest(), kind)


class ArchiveTests(unittest.TestCase):
    def test_tar_content_digest(self):
        result = inspect(tar_bytes())
        self.assertEqual(result["expandedBytes"], 4)
        self.assertEqual(
            result["entries"][0]["sha256"], hashlib.sha256(b"code").hexdigest()
        )

    def test_wheel_and_duplicate_paths(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("module.py", "pass")
        self.assertEqual(inspect(buffer.getvalue(), "WHEEL")["expandedBytes"], 4)
        with zipfile.ZipFile(buffer, "a") as archive:
            archive.writestr("MODULE.py", "pass")
        with self.assertRaisesRegex(ValueError, "DUPLICATE"):
            inspect(buffer.getvalue(), "WHEEL")

    def test_path_and_link_rejection(self):
        for path in ["../escape", "/absolute", "C:/drive", "a/../b", "a\\b", "a//b"]:
            with (
                self.subTest(path=path),
                self.assertRaisesRegex(ValueError, "PATH_INVALID"),
            ):
                inspect(tar_bytes(path))
        with self.assertRaisesRegex(ValueError, "ENTRY_FORBIDDEN"):
            inspect(tar_bytes(link=True))
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            member = zipfile.ZipInfo("link")
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(member, "/etc/passwd")
        with self.assertRaisesRegex(ValueError, "ENTRY_FORBIDDEN"):
            inspect(buffer.getvalue(), "WHEEL")

    def test_limits_hash_and_corruption(self):
        data = tar_bytes()
        with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
            inspect_archive(data, "0" * 64, "TAR")
        with (
            patch("inspect_archive.MAX_EXPANDED_BYTES", 3),
            self.assertRaisesRegex(ValueError, "LIMIT"),
        ):
            inspect(data)
        for kind in ["TAR", "WHEEL"]:
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "CORRUPT"):
                inspect(b"invalid", kind)

    def test_file_directory_conflict(self):
        for names in [("a", "a/b"), ("a/b", "a")]:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                for name in names:
                    archive.writestr(name, "x")
            with self.assertRaisesRegex(ValueError, "PATH_CONFLICT"):
                inspect(buffer.getvalue(), "WHEEL")

    def test_tar_metadata_expansion_budget(self):
        buffer = io.BytesIO()
        with tarfile.open(
            fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT
        ) as archive:
            member = tarfile.TarInfo("a")
            member.pax_headers = {"comment": "x" * 10_000}
            archive.addfile(member)
        with (
            patch("inspect_archive.MAX_ENTRIES", 1),
            patch("inspect_archive.MAX_EXPANDED_BYTES", 1),
            self.assertRaisesRegex(ValueError, "LIMIT"),
        ):
            inspect(buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
