import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
  "test-results"
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);
const textFileNames = new Set([".dockerignore", ".gitignore", ".node-version", ".python-version"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

let checkedFiles = 0;

for await (const filePath of walk(process.cwd())) {
  if (!textExtensions.has(path.extname(filePath)) && !textFileNames.has(path.basename(filePath))) {
    continue;
  }

  const content = decoder.decode(await readFile(filePath));
  if (content.includes("\uFFFD")) {
    throw new Error(`发现 Unicode 替换字符：${path.relative(process.cwd(), filePath)}`);
  }

  checkedFiles += 1;
}

console.log(`UTF-8 检查通过：${checkedFiles} 个文本文件`);
