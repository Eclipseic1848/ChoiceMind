export function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined
): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
}

export function isPermissionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return false;
    if ("code" in current && (current.code === "EACCES" || current.code === "EPERM")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
