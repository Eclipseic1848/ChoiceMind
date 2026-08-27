import { describe, expect, it } from "vitest";

import {
  createCategoryPackageRegistry,
  syntheticFoldingTableCategory
} from "./index.js";

describe("CategoryPackageRegistry", () => {
  it("只通过版本化 Category Package 注册并按 ID 返回合成类别", () => {
    const registry = createCategoryPackageRegistry();

    registry.register(syntheticFoldingTableCategory);

    expect(registry.get("synthetic-folding-table")).toEqual(
      syntheticFoldingTableCategory
    );
    expect(registry.list().map((entry) => entry.categoryId)).toEqual([
      "synthetic-folding-table"
    ]);
  });

  it("拒绝用重复 category ID 静默覆盖已注册包", () => {
    const registry = createCategoryPackageRegistry();
    registry.register(syntheticFoldingTableCategory);

    expect(() => registry.register(syntheticFoldingTableCategory)).toThrowError(
      "CATEGORY_PACKAGE_DUPLICATE: synthetic-folding-table"
    );
  });
});
