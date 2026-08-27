import { describe, expect, it } from "vitest";

import { parseP0GoldArguments } from "./p0-gold-cli.js";

describe("parseP0GoldArguments", () => {
  it("要求显式提供六服务报告，并固定安全默认基线与输出目录", () => {
    expect(
      parseP0GoldArguments([
        "--local-service-report",
        ".artifacts/p0-12-local-services-smoke.json"
      ])
    ).toEqual({
      baselineRef: "origin/main",
      localServiceReportPath: ".artifacts/p0-12-local-services-smoke.json",
      outputDirectory: ".artifacts/p0-gold"
    });
    expect(() => parseP0GoldArguments([])).toThrowError(
      "P0_GOLD_ARGUMENT_INVALID: 缺少 --local-service-report"
    );
  });
});
