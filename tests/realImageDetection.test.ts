import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AlphaMaskManager } from '../src/engine/alphaMasks.ts';
import { WatermarkEngine } from '../src/engine/watermarkEngine.ts';

if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = new Uint8ClampedArray(data);
      this.width = width;
      this.height = height;
    }
  };
}

test('detects and removes real watermark on high-res textured Diwali image in bottom-right corner', () => {
  const masksPath = 'C:/Users/Hp/.gemini/antigravity/brain/7b80f8a3-5024-4bea-8f6c-be796210c85a/scratch/masks.json';
  const imgPath = 'C:/Users/Hp/.gemini/antigravity/brain/7b80f8a3-5024-4bea-8f6c-be796210c85a/scratch/diwali_rgba.bin';

  if (!fs.existsSync(masksPath) || !fs.existsSync(imgPath)) {
    return;
  }

  const masksData = JSON.parse(fs.readFileSync(masksPath, 'utf-8'));
  const maskMgr = new AlphaMaskManager();
  (maskMgr as any).alphaMap48 = new Float32Array(masksData['bg_48.png']);
  (maskMgr as any).alphaMap96 = new Float32Array(masksData['bg_96.png']);
  (maskMgr as any).alphaMap84Star = new Float32Array(masksData['gemini-star_paired_star_mask.png']);
  (maskMgr as any).alphaMap48New = new Float32Array(masksData['sparkle-2026-48.png']);
  (maskMgr as any).alphaMap96New = new Float32Array(masksData['sparkle-2026-96.png']);
  (maskMgr as any).alphaMap48White = new Float32Array(masksData['sparkle-hw-48.png']);
  (maskMgr as any).alphaMap96White = new Float32Array(masksData['sparkle-hw-96.png']);
  (maskMgr as any).initialized = true;

  const engine = new WatermarkEngine(maskMgr);
  const rawBytes = fs.readFileSync(imgPath);
  const uint8Data = new Uint8ClampedArray(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

  const imgData = {
    width: 2752,
    height: 1536,
    data: uint8Data,
  } as ImageData;

  const result = engine.detect(imgData);

  assert.equal(result.detected, true);
  assert.equal(result.detectedCorner, 'bottom-right');
  assert.equal(result.size, 96);
  assert.equal(result.x, 2592);
  assert.equal(result.y, 1376);
  assert.ok(result.ncc >= 0.50, `ncc was ${result.ncc}, expected >= 0.50`);

  const removal = engine.removeWatermark(imgData);
  assert.equal(removal.result.success, true);
  assert.equal(removal.result.position.x, 2592);
  assert.equal(removal.result.position.y, 1376);
  assert.ok(removal.result.pixelsModified > 5000);
});
