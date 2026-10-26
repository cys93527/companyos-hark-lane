'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reorderPlan } = require('../src/inventory.js');

test('reorderPlan follows the DOMAIN.md example (规则 R4)', () => {
  const items = [
    { sku: 'C-300', qty: 2, reorderPoint: 10, targetStock: 40, minOrder: 10, packSize: 6 },
    { sku: 'A-100', qty: 4, reorderPoint: 5, targetStock: 12, minOrder: 10, packSize: 5 },
    { sku: 'B-200', qty: 20, reorderPoint: 20, targetStock: 100, minOrder: 50, packSize: 12 },
    { sku: 'D-400', qty: 0, reorderPoint: 3, targetStock: 9, minOrder: 1, packSize: 1, discontinued: true },
  ];
  assert.deepEqual(reorderPlan(items), [
    { sku: 'A-100', orderQty: 10 },
    { sku: 'C-300', orderQty: 42 },
  ]);
});

test('reorderPlan does not reorder when qty equals reorderPoint (规则 R4.1)', () => {
  const items = [
    { sku: 'B-200', qty: 20, reorderPoint: 20, targetStock: 100, minOrder: 50, packSize: 12 },
  ];
  assert.deepEqual(reorderPlan(items), []);
});

test('reorderPlan does not reorder discontinued items (规则 R4.1)', () => {
  const items = [
    { sku: 'D-400', qty: 0, reorderPoint: 3, targetStock: 9, minOrder: 1, packSize: 1, discontinued: true },
  ];
  assert.deepEqual(reorderPlan(items), []);
});

test('reorderPlan returns an empty array for empty input and does not mutate it (规则 R4.4/R4.5)', () => {
  const items = [
    { sku: 'C-300', qty: 2, reorderPoint: 10, targetStock: 40, minOrder: 10, packSize: 6 },
  ];
  const snapshot = JSON.stringify(items);
  reorderPlan(items);
  assert.equal(JSON.stringify(items), snapshot);
  assert.deepEqual(reorderPlan([]), []);
});
