import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error("缺少要启动的命令");

const environment = { ...process.env };
if (
  environment.CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64 === undefined ||
  environment.CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64.length === 0
) {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error("LOCALAPPDATA 不可用，无法读取本地 Credential Vault 密钥");
  }
  environment.CHOICEMIND_CREDENTIAL_MASTER_KEY_BASE64 = (
    await readFile(
      join(localAppData, "ChoiceMind", "development", "credential-master-key.txt"),
      "ascii"
    )
  ).trim();
}

const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
const child = spawn(executable, args, {
  env: environment,
  shell: process.platform === "win32",
  stdio: "inherit"
});
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
