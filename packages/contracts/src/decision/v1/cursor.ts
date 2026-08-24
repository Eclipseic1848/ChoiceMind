const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function isPersistedRunEventCursorV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d*$/.test(value) &&
    BigInt(value) <= POSTGRES_BIGINT_MAX
  );
}
