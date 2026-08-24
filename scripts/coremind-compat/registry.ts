export const DEFAULT_DEPENDENCY_REGISTRY = "https://registry.npmjs.org/";
export const CANDIDATE_DEPENDENCY_FETCH_POLICY = Object.freeze({
  fetchRetries: 5,
  fetchRetryFactor: 10,
  fetchRetryMaxTimeoutMs: 60_000,
  fetchRetryMinTimeoutMs: 10_000,
  fetchTimeoutMs: 60_000,
  installConcurrency: 1,
  networkConcurrency: 1
});
const ALLOWED_DEPENDENCY_REGISTRIES = new Set([
  DEFAULT_DEPENDENCY_REGISTRY,
  "https://registry.npmmirror.com/"
]);

export function normalizeDependencyRegistry(value: string): string {
  let registry: URL;
  try {
    registry = new URL(value);
  } catch {
    throw new Error("registry URL 必须是绝对 HTTPS URL");
  }
  if (registry.protocol !== "https:") {
    throw new Error("registry URL 必须使用 HTTPS");
  }
  if (registry.username || registry.password) {
    throw new Error("registry URL 不得包含凭据");
  }
  if (registry.search) {
    throw new Error("registry URL 不得包含查询参数");
  }
  if (registry.hash) {
    throw new Error("registry URL 不得包含片段");
  }
  const normalized = registry.toString();
  if (!ALLOWED_DEPENDENCY_REGISTRIES.has(normalized)) {
    throw new Error("registry URL 不在允许列表中");
  }
  return normalized;
}
