"""仅生成依赖求解的合成 wheel，不执行包代码。"""

import base64
import hashlib
import io
import json
import sys
import zipfile


def wheel(name, version, requires):
    output = io.BytesIO()
    info = f"{name}-{version}.dist-info"
    files = {
        f"{name}.py": "raise RuntimeError('synthetic candidate must not run')\n",
        f"{info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nProvides-Extra: speed\n"
        + "".join(f"Requires-Dist: {value}\n" for value in requires),
        f"{info}/WHEEL": "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    files[f"{info}/RECORD"] = "\n".join(
        f"{path},," for path in [*files, f"{info}/RECORD"]
    )
    with zipfile.ZipFile(output, "w") as archive:
        for path, value in files.items():
            archive.writestr(path, value)
    return output.getvalue()


mode = sys.argv[1]
requires = [
    "helper>=1,<3",
    'absent==1; sys_platform=="win32"',
    'fast==1.0; extra=="speed"',
]
if mode == "conflict":
    requires[0] = "helper>=2"
if mode == "direct":
    requires[0] = "helper @ https://example.invalid/helper.whl"
output = io.BytesIO()
wheels = []
with zipfile.ZipFile(output, "w") as archive:
    for name, version, dependencies in [
        ("candidate", "1.0", requires),
        ("helper", "1.0", ["candidate==1.0"]),
        ("helper", "2.0", ["missing==1"] if mode == "missing" else []),
        ("other", "1.0", ["helper<2"]),
        ("fast", "1.0", []),
    ]:
        data = wheel(name, version, dependencies)
        filename = f"{name}-{version}-py3-none-any.whl"
        archive.writestr(filename, data)
        wheels.append(
            {
                "name": name,
                "version": version,
                "filename": filename,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": base64.b64encode(data).decode("ascii"),
            }
        )
print(
    json.dumps(wheels)
    if "--catalogue" in sys.argv
    else base64.b64encode(output.getvalue()).decode("ascii")
)
