'use strict';

/**
 * In-memory inventory for a small shop. Items: { sku, name, qty, price, reorderPoint,
 * targetStock, minOrder, packSize, discontinued }.
 */
class Inventory {
  constructor(items = []) {
    this.items = new Map();
    for (const item of items) this.addItem(item);
  }

  addItem(item) {
    if (!item || typeof item.sku !== 'string' || item.sku === '') throw new TypeError('sku required');
    if (!Number.isInteger(item.qty) || item.qty < 0) throw new RangeError('qty must be a non-negative integer');
    const existing = this.items.get(item.sku);
    if (existing) existing.qty += item.qty;
    else this.items.set(item.sku, { ...item });
    return this.items.get(item.sku);
  }

  removeItem(sku, qty) {
    const item = this.items.get(sku);
    if (!item) throw new RangeError(`unknown sku ${sku}`);
    if (!Number.isInteger(qty) || qty < 0) throw new RangeError('qty must be a non-negative integer');
    // 规则 R2：不允许负库存，也不允许部分扣减。
    if (qty > item.qty) throw new RangeError(`not enough stock for sku ${sku}`);
    item.qty -= qty;
    return item;
  }

  get(sku) {
    return this.items.get(sku);
  }

  totalValue() {
    let total = 0;
    // 规则 R3：库存价值 = Σ qty × price，四舍五入到分。
    for (const item of this.items.values()) total += item.qty * item.price;
    return Math.round(total * 100) / 100;
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  }
}

/**
 * 规则 R4/R5：计算补货计划。输入为商品数组，返回 [{ sku, orderQty }]，
 * 按 sku 字典序升序排列；不修改输入数组及其中的对象。
 */
function reorderPlan(items) {
  const plan = [];
  for (const item of items) {
    // 规则 R4.1：只有库存严格低于补货点、且未下架的商品才需要补货。
    if (item.discontinued === true || !(item.qty < item.reorderPoint)) continue;
    // 规则 R4.2：基础下单量 = max(minOrder, targetStock - qty)。
    const baseQty = Math.max(item.minOrder, item.targetStock - item.qty);
    // 规则 R4.3：向上取整到 packSize 的整数倍。
    const orderQty = Math.ceil(baseQty / item.pa