"""仅生成依赖求解的合成 wheel，不执行包代码。"""

import base64
import io
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
with zipfile.ZipFile(output, "w") as archive:
    for name, version, dependencies in [
        ("candidate", "1.0", requires),
        ("helper", "1.0", ["candidate==1.0"]),
        ("helper", "2.0", []),
        ("other", "1.0", ["helper<2"]),
        ("fast", "1.0", []),
    ]:
        archive.writestr(
            f"{name}-{version}-py3-none-any.whl", wheel(name, version, dependencies)
        )
print(base64.b64encode(output.getvalue()).decode("ascii"))
