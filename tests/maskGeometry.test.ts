import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferMaskSize,
  isValidMask,
  rescaleAlphaMap,
  resolveScaledMaskSize,
} from '../src/engine/maskGeometry.ts';

test('isValidMask rejects 48x48 data mislabeled as 72x72', () => {
  const alphaMap = new Float32Array(48 * 48);
  assert.equal(isValidMask({ alphaMap, size: 72 }), false);
  assert.equal(isValidMask({ alphaMap, size: 48 }), true);
});

test('isValidMask rejects null, zero and fractional sizes', () => {
  assert.equal(isValidMask(null), false);
  assert.equal(isValidMask(undefined), false);
  assert.equal(isValidMask({ alphaMap: new Float32Array(0), size: 0 }), false);
  assert.equal(isValidMask({ alphaMap: new Float32Array(16), size: 3.5 }), false);
});

test('inferMaskSize derives a square size and rejects non-square buffers', () => {
  assert.equal(inferMaskSize(new Float32Array(48 * 48)), 48);
  assert.equal(inferMaskSize(new Float32Array(96 * 96)), 96);
  assert.equal(inferMaskSize(new Float32Array(84 * 84)), 84);
  assert.equal(inferMaskSize(new Float32Array(101)), null);
  assert.equal(inferMaskSize(new Float32Array(0)), null);
});

test('rescaleAlphaMap returns the original array when sizes match', () => {
  const source = new Float32Array([1, 0, 0, 1]);
  assert.equal(rescaleAlphaMap(source, 2, 2), source);
});

test('rescaleAlphaMap preserves corners and produces a valid square', () => {
  const source = new Float32Array([
    1, 0,
    0, 1,
  ]);
  const scaled = rescaleAlphaMap(source, 2, 4);

  assert.equal(scaled.length, 16);
  assert.ok(Math.abs(scaled[0] - 1) < 1e-6, 'top-left corner');
  assert.ok(Math.abs(scaled[3] - 0) < 1e-6, 'top-right corner');
  assert.ok(Math.abs(scaled[12] - 0) < 1e-6, 'bottom-left corner');
  assert.ok(Math.abs(scaled[15] - 1) < 1e-6, 'bottom-right corner');

  for (const value of scaled) {
    assert.ok(value >= 0 && value <= 1, `alpha ${value} stayed in range`);
  }
});

test('rescaleAlphaMap rejects data whose length does not match its size', () => {
  assert.throws(() => rescaleAlphaMap(new Float32Array(48), 12, 24), /Invalid source mask/);
  assert.throws(() => rescaleAlphaMap(new Float32Array(4), 2, 0), /Invalid destination/);
});

test('resolveScaledMaskSize clamps to the supported range', () => {
  assert.equal(resolveScaledMaskSize(48, 1), 48);
  assert.equal(resolveScaledMaskSize(48, 1.5), 72);
  assert.equal(resolveScaledMaskSize(48, 0), 48);
  assert.equal(resolveScaledMaskSize(48, Number.NaN), 48);
  assert.equal(resolveScaledMaskSize(48, 1000), 4096);
  assert.equal(resolveScaledMaskSize(1, 0.1), 4);
});
