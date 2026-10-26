'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Inventory } = require('../src/inventory.js');

const sample = () => new Inventory([
  { sku: 'A-100', name: '笔记本', qty: 10, price: 12.5, reorderPoint: 5, targetStock: 30, minOrder: 10, packSize: 5 },
  { sku: 'B-200', name: '中性笔', qty: 3, price: 2.2, reorderPoint: 20, targetStock: 100, minOrder: 50, packSize: 12 },
]);

test('addItem merges quantities of the same sku', () => {
  const inv = sample();
  inv.addItem({ sku: 'A-100', qty: 5, price: 12.5 });
  assert.equal(inv.get('A-100').qty, 15);
});

test('removeItem refuses to go below zero (规则 R2)', () => {
  const inv = sample();
  assert.throws(() => inv.removeItem('B-200', 4), RangeError);
  assert.equal(inv.get('B-200').qty, 3);
});

test('removeItem reduces stock', () => {
  const inv = sample();
  inv.removeItem('A-100', 4);
  assert.equal(inv.get('A-100').qty, 6);
});

test('totalValue is the sum of qty x price (规则 R3)', () => {
  const inv = sample();
  assert.equal(inv.totalValue(), 131.6);
});
