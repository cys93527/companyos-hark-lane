# 变更记录

## 修复的缺陷

### R2 出库（`Inventory.removeItem`）
- 原实现直接执行 `item.qty -= qty`，没有校验出库数量，库存可能变成负数。
- 现在当出库数量大于当前库存时抛出 `RangeError`，并且先校验再扣减，保证抛错时库存保持不变（不做部分扣减）。
- 同时对非整数或负数出库数量抛出 `RangeError`，与入库校验保持一致。

### R3 库存价值（`Inventory.totalValue`）
- 原实现只累加了 `price`，漏乘了 `qty`，导致库存价值错误。
- 现在按 `totalValue() = Σ qty × price` 计算，并用 `Math.round(total * 100) / 100` 四舍五入到分（两位小数）。

## 新增 `reorderPlan(items)`（R4/R5）

在 `src/inventory.js` 中新增函数 `reorderPlan(items)`，并通过原有导出语句一并对外暴露：

```js
module.exports = { Inventory, reorderPlan };
```

因此既可 `const { reorderPlan } = require('./src/inventory.js')`，也不影响原有的 `Inventory` 用法；保持无第三方依赖。规则如下：

- R4.1 只有 `qty < reorderPoint` 且 `discontinued` 不为 `true` 的商品进入计划；库存等于补货点不补。
- R4.2 基础下单量 = `max(minOrder, targetStock - qty)`。
- R4.3 下单量向上取整到 `packSize` 的整数倍。
- R4.4 纯函数：不修改输入数组及其中的对象，输出元素只包含 `{ sku, orderQty }`。
- R4.5 输入为空数组时返回空数组，结果按 `sku` 字典序升序排列。

## 测试

新建 `test/reorder.test.js`，包含 4 个测试，覆盖：

1. `reorderPlan follows the DOMAIN.md example (规则 R4)`：`docs/DOMAIN.md` 中的 R4 完整示例，结果为 `[{ sku: 'A-100', orderQty: 10 }, { sku: 'C-300', orderQty: 42 }]`；
2. `reorderPlan does not reorder when qty equals reorderPoint (规则 R4.1)`：库存等于补货点不补货；
3. `reorderPlan does not reorder discontinued items (规则 R4.1)`：已下架商品不补货；
4. `reorderPlan returns an empty array for empty input and does not mutate it (规则 R4.4/R4.5)`：空输入返回空数组，且不修改输入。

原有 `test/inventory.test.js` 的 4 个测试继续覆盖 R1 入库合并、R2 出库不可低于零、出库扣减、R3 库存价值求和。

## 最终测试结果

- 测试文件：`test/inventory.test.js`（原有 4 个）+ `test/reorder.test.js`（新增 4 个）。
- 结果：**`npm test` 退出码 0，8 个测试全部通过，0 失败**。
- 实测 TAP 汇总：`1..8`、`# tests 8`、`# pass 8`、`# fail 0`、`# cancelled 0`、`# skipped 0`、`# todo 0`。没有 skip/todo 用例，也没有被注释掉以掩盖失败的用例。
- 验证命令：`npm test`。当前运行沙箱禁止 `node --test` 派生子进程（裸跑 `node --test` 会得到 `spawn EPERM`，2 个子测试全部 `not ok`），因此 `package.json` 的测试脚本使用 `node --experimental-test-isolation=none --test` 关闭测试隔离，让测试在当前进程内执行；这只是 Node.js 内置测试运行器参数，模块与测试代码本身无环境依赖。
- 未修改 `docs/DOMAIN.md`，`package.json` 依赖清单未新增任何第三方依赖，源码仅使用 Node.js 内置能力。
