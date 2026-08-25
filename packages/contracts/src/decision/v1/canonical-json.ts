export function canonicalizeJsonV1(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonV1).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJsonV1(item)}`)
      .join(",")}}`;
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("值不能表示为 JSON");
  }
  return serialized;
}
