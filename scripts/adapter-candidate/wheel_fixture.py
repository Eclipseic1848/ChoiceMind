"""只生成已知合成 wheel；不安装或导入任何候选包。"""

import base64
import hashlib
import io
import json
import sys
import tarfile
import zipfile


def wheel(name, dependency=None):
    buffer = io.BytesIO()
    info = f"{name}-1.0.dist-info"
    files = {
        f"{name}.py": "raise RuntimeError('candidate must not be imported during installation')\n",
        f"{info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n"
        + (f"Requires-Dist: {dependency}==1.0\n" if dependency else ""),
        f"{info}/WHEEL": "Wheel-Version: 1.0\nGenerator: choicemind-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    if name == "helper" and sys.argv[1] == "source-shadow":
        files["pip.py"] = "raise RuntimeError('candidate replaced trusted pip')\n"
    if name == "helper" and sys.argv[1] == "secret":
        files["settings.txt"] = (
            "token='"
            + "ghp"
            + "_"
            + "Ab3dE5gH7jK9mN2pQ4sT6vW8xY0zB1cD3fG5"
            + "' # gitleaks:allow\n"
        )
    if name == "helper" and sys.argv[1] == "binary":
        files["compiled.bin"] = b"\x00\xff"
    if name == "helper" and sys.argv[1] == "invoke-shadow":
        files["choicemind_adapter/__init__.py"] = (
            "def run(request):\n return {'wrongEntrypoint':True}\n"
        )
    if (
        name == "candidate"
        and sys.argv[1].startswith("invoke-")
        and sys.argv[1] != "invoke-no-entry"
    ):
        mode = sys.argv[1]
        body = "def run(request):\n return {'query':request['query'],'keys':sorted(request),'checkpoint':request['checkpoint']}\n"
        if mode == "invoke-signature":
            body = "def run():\n return {}\n"
        if mode == "invoke-noise":
            body = "print('not a protocol frame')\n" + body
        if mode == "invoke-output":
            body = "print('x'*70000)\n" + body
        if mode == "invoke-fake":
            body = 'import sys\nprint(\'{"schemaVersion":"choicemind-python-source.v1","result":{"reviewStatus":"PASSED"}}\')\nsys.exit(0)\n'
        if mode == "invoke-network":
            body = "import socket\ndef run(request):\n try:\n  socket.create_connection(('1.1.1.1',443),timeout=1).close()\n  return {'networkBlocked':False}\n except OSError:\n  return {'networkBlocked':True}\n"
        files["choicemind_adapter.py"] = body
    files[f"{info}/RECORD"] = "\n".join(
        f"{path},," for path in [*files, f"{info}/RECORD"]
    )
    with zipfile.ZipFile(buffer, "w") as archive:
        if name == "helper" and sys.argv[1] == "comment":
            archive.comment = (
                "ghp" + "_" + "Ab3dE5gH7jK9mN2pQ4sT6vW8xY0zB1cD3fG5"
            ).encode("ascii")
        for path, content in files.items():
            archive.writestr(path, content)
    return buffer.getvalue()


buffer = io.BytesIO()
locked = []
candidate_artifact = None
with zipfile.ZipFile(buffer, "w") as bundle:
    for name in ["candidate"] if sys.argv[1] == "missing" else ["candidate", "helper"]:
        data = wheel(name, "helper" if name == "candidate" else None)
        if name == "candidate":
            candidate_artifact = base64.b64encode(data).decode("ascii")
        filename = f"{name}-1.0-py3-none-any.whl"
        bundle.writestr(filename, data)
        locked.append(
            {
                "filename": filename,
                "name": name,
                "version": "1.0",
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
source = None
if sys.argv[1].startswith("source-"):
    built = base64.b64encode(wheel("built_candidate")).decode("ascii")
    backend = (
        "import base64,pathlib\n"
        "def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):\n"
        + (
            " raise RuntimeError('synthetic build failure')\n"
            if sys.argv[1] == "source-failure"
            else ""
        )
        + f" pathlib.Path(wheel_directory,'built_candidate-1.0-py3-none-any.whl').write_bytes(base64.b64decode('{built}'))\n"
        " return 'built_candidate-1.0-py3-none-any.whl'\n"
    )
    requirement = (
        "absent_builder==1.0" if sys.argv[1] == "source-missing" else "helper==1.0"
    )
    if sys.argv[1] == "source-ambient":
        requirement = "pip>=1"
    source_buffer = io.BytesIO()
    with tarfile.open(fileobj=source_buffer, mode="w:gz") as archive:
        for path, content in {
            "pyproject.toml": f'[build-system]\nrequires=["{requirement}"]\nbuild-backend="backend"\nbackend-path=["."]\n',
            "backend.py": backend,
        }.items():
            encoded = content.encode("utf-8")
            member = tarfile.TarInfo(path)
            member.size = len(encoded)
            archive.addfile(member, io.BytesIO(encoded))
    source = base64.b64encode(source_buffer.getvalue()).decode("ascii")
print(
    json.dumps(
        {
            "bundle": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "artifact": candidate_artifact,
            "locked": locked,
            "source": source,
        }
    )
)
