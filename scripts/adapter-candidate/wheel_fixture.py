"""只生成已知合成 wheel；不安装或导入任何候选包。"""

import base64
import hashlib
import io
import json
import sys
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
    files[f"{info}/RECORD"] = "\n".join(
        f"{path},," for path in [*files, f"{info}/RECORD"]
    )
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return buffer.getvalue()


buffer = io.BytesIO()
locked = []
with zipfile.ZipFile(buffer, "w") as bundle:
    for name in ["candidate"] if sys.argv[1] == "missing" else ["candidate", "helper"]:
        data = wheel(name, "helper" if name == "candidate" else None)
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
print(
    json.dumps(
        {
            "bundle": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "locked": locked,
        }
    )
)
