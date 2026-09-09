"""只在隔离容器内调用固定入口；候选输出不是可信测试报告。"""

import hashlib
import io
import json
import pathlib
import subprocess
import sys
import zipfile


def invoke_python_candidate(bundle, locked, target_sha256, request):
    targets = [item for item in locked if item["sha256"] == target_sha256]
    if len(targets) != 1:
        raise ValueError("CANDIDATE_ENTRYPOINT_TARGET_INVALID")
    # 上一阶段已完整检查 bundle 和每个 wheel；入口必须来自选中的目标制品。
    with (
        zipfile.ZipFile(io.BytesIO(bundle)) as archive,
        zipfile.ZipFile(io.BytesIO(archive.read(targets[0]["filename"]))) as wheel,
    ):
        expected = hashlib.sha256(wheel.read("choicemind_adapter.py")).hexdigest()
    installed = pathlib.Path("/work/site/choicemind_adapter.py")
    if hashlib.sha256(installed.read_bytes()).hexdigest() != expected:
        raise ValueError("CANDIDATE_ENTRYPOINT_CONTENT_MISMATCH")
    program = """
import json,sys,types
request=json.load(sys.stdin)
# 只执行核验过的源码，不走同名包搜索或字节码缓存。
path='/work/site/choicemind_adapter.py'
with open(path,'rb') as source:
 code=compile(source.read(),path,'exec')
choicemind_adapter=types.ModuleType('choicemind_adapter')
choicemind_adapter.__file__=path
sys.modules['choicemind_adapter']=choicemind_adapter
sys.path.insert(0,'/work/site')
exec(code,choicemind_adapter.__dict__)
result=choicemind_adapter.run(request)
print(json.dumps({'schemaVersion':'choicemind-python-source.v1','result':result}))
"""
    # 子进程 stdout 直接交给外部有界收集器；候选不能写权威检查结果。
    completed = subprocess.run(
        [sys.executable, "-I", "-c", program],
        input=json.dumps(request).encode("utf-8"),
        stdout=sys.stdout.buffer,
        stderr=subprocess.DEVNULL,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        cwd="/work",
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError("CANDIDATE_ENTRYPOINT_FAILED")
