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
    item.qty -= qty;
    return item;
  }

  get(sku) {
    return this.items.get(sku);
  }

  totalValue() {
    let total = 0;
    for (const item of this.items.values()) total += item.price;
    return Math.round(total * 100) / 100;
  }

  list() {
    return [...this.items.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  }
}

module.exports = { Inventory };
