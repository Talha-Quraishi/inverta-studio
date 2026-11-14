import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSeekablePlaybackBuffer,
  getRotationDegrees,
} from '../src/engine/mp4Utils.ts';

test('getRotationDegrees handles identity and rotated matrices from arrays and TypedArrays', () => {
  // Identity: 0 degrees
  const identityArr = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  const identityTyped = new Int32Array(identityArr);
  assert.equal(getRotationDegrees({ matrix: identityArr }), 0);
  assert.equal(getRotationDegrees({ matrix: identityTyped }), 0);

  // 90 degrees clockwise: a=0, b=1 => [0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]
  const rot90 = new Int32Array([0, 65536, 0, -65536, 0, 0, 0, 0, 1073741824]);
  assert.equal(getRotationDegrees({ matrix: rot90 }), 90);

  // 180 degrees: a=-1, b=0 => [-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824]
  const rot180 = new Int32Array([-65536, 0, 0, 0, -65536, 0, 0, 0, 1073741824]);
  assert.equal(getRotationDegrees({ matrix: rot180 }), 180);

  // 270 degrees clockwise: a=0, b=-1 => [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824]
  const rot270 = new Int32Array([0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824]);
  assert.equal(getRotationDegrees({ matrix: rot270 }), 270);

  // Edge cases
  assert.equal(getRotationDegrees(null), 0);
  assert.equal(getRotationDegrees({}), 0);
  assert.equal(getRotationDegrees({ matrix: [] }), 0);
});

function buildMinimalMp4WithStss(entryCount: number, capacityCount: number): ArrayBuffer {
  // Build a minimal MP4 structure containing:
  // moov
  //   trak
  //     mdia
  //       hdlr ('vide')
  //       minf
  //         stbl
  //           stss (FullBox: version(1) + flags(3) + entry_count(4) + sample_numbers(4 * capacityCount))
  const stssSize = 8 + 4 + 4 + capacityCount * 4;
  const hdlrSize = 8 + 4 + 4 + 4; // size + 'hdlr' + ver/flags + pre_defined + handler_type
  const stblSize = 8 + stssSize;
  const minfSize = 8 + stblSize;
  const mdiaSize = 8 + hdlrSize + minfSize;
  const trakSize = 8 + mdiaSize;
  const moovSize = 8 + trakSize;

  const buffer = new ArrayBuffer(moovSize);
  const view = new DataView(buffer);
  let offset = 0;

  // moov
  view.setUint32(offset, moovSize);
  offset += 4;
  view.setUint8(offset++, 0x6d); // 'm'
  view.setUint8(offset++, 0x6f); // 'o'
  view.setUint8(offset++, 0x6f); // 'o'
  view.setUint8(offset++, 0x76); // 'v'

  // trak
  view.setUint32(offset, trakSize);
  offset += 4;
  view.setUint8(offset++, 0x74); // 't'
  view.setUint8(offset++, 0x72); // 'r'
  view.setUint8(offset++, 0x61); // 'a'
  view.setUint8(offset++, 0x6b); // 'k'

  // mdia
  view.setUint32(offset, mdiaSize);
  offset += 4;
  view.setUint8(offset++, 0x6d); // 'm'
  view.setUint8(offset++, 0x64); // 'd'
  view.setUint8(offset++, 0x69); // 'i'
  view.setUint8(offset++, 0x61); // 'a'

  // hdlr
  view.setUint32(offset, hdlrSize);
  offset += 4;
  view.setUint8(offset++, 0x68); // 'h'
  view.setUint8(offset++, 0x64); // 'd'
  view.setUint8(offset++, 0x6c); // 'l'
  view.setUint8(offset++, 0x72); // 'r'
  view.setUint32(offset, 0); // version + flags
  offset += 4;
  view.setUint32(offset, 0); // pre_defined
  offset += 4;
  view.setUint8(offset++, 0x76); // 'v'
  view.setUint8(offset++, 0x69); // 'i'
  view.setUint8(offset++, 0x64); // 'd'
  view.setUint8(offset++, 0x65); // 'e'

  // minf
  view.setUint32(offset, minfSize);
  offset += 4;
  view.setUint8(offset++, 0x6d); // 'm'
  view.setUint8(offset++, 0x69); // 'i'
  view.setUint8(offset++, 0x6e); // 'n'
  view.setUint8(offset++, 0x66); // 'f'

  // stbl
  view.setUint32(offset, stblSize);
  offset += 4;
  view.setUint8(offset++, 0x73); // 's'
  view.setUint8(offset++, 0x74); // 't'
  view.setUint8(offset++, 0x62); // 'b'
  view.setUint8(offset++, 0x6c); // 'l'

  // stss (FullBox)
  const stssOffset = offset;
  view.setUint32(stssOffset, stssSize);
  offset += 4;
  view.setUint8(offset++, 0x73); // 's'
  view.setUint8(offset++, 0x74); // 't'
  view.setUint8(offset++, 0x73); // 's'
  view.setUint8(offset++, 0x73); // 's'
  view.setUint32(offset, 0); // version (1 byte) + flags (3 bytes) = 0
  offset += 4;
  view.setUint32(offset, entryCount); // entry_count
  offset += 4;
  for (let i = 0; i < capacityCount; i++) {
    view.setUint32(offset, i < entryCount ? i + 1 : 0);
    offset += 4;
  }

  return buffer;
}

test('buildSeekablePlaybackBuffer does not touch files that already have sync samples', () => {
  // A file with entry_count = 1 (like 884748845_1794032309338142.mp4)
  const buf = buildMinimalMp4WithStss(1, 2);
  const videoTrack = { codec: 'avc1.64001f' };
  const videoSamples = [
    { data: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]) }, // NAL unit type 5 (IDR)
  ];

  const result = buildSeekablePlaybackBuffer(buf, videoSamples, videoTrack);
  assert.equal(result, null, 'Must return null so original valid video is never corrupted');
});

test('buildSeekablePlaybackBuffer patches empty stss tables without corrupting FullBox headers', () => {
  // A file with empty stss (entry_count = 0) but preallocated capacity for 2 entries
  const buf = buildMinimalMp4WithStss(0, 2);
  const videoTrack = { codec: 'avc1.640028' };
  // Sample 1: IDR (NAL unit type 5), Sample 2: non-IDR (type 1)
  const videoSamples = [
    { data: new Uint8Array([0, 0, 0, 2, 0x65, 0x88]) }, // IDR
    { data: new Uint8Array([0, 0, 0, 2, 0x61, 0x88]) }, // non-IDR
  ];

  const patched = buildSeekablePlaybackBuffer(buf, videoSamples, videoTrack);
  assert.ok(patched !== null, 'Should return patched buffer for empty sync table');

  // Verify FullBox structure in patched buffer:
  // Locate 'stss' box
  const view = new DataView(patched);
  let stssPayload = -1;
  for (let i = 0; i < patched.byteLength - 8; i++) {
    if (
      view.getUint8(i) === 0x73 &&
      view.getUint8(i + 1) === 0x74 &&
      view.getUint8(i + 2) === 0x73 &&
      view.getUint8(i + 3) === 0x73
    ) {
      stssPayload = i + 4;
      break;
    }
  }
  assert.ok(stssPayload >= 0, 'stss payload found');

  // 1. Version (1 byte) + flags (3 bytes) MUST remain 0
  const verFlags = view.getUint32(stssPayload);
  assert.equal(verFlags, 0, 'Version and flags must be 0, not overwritten with count');

  // 2. entry_count MUST be at stssPayload + 4
  const entryCount = view.getUint32(stssPayload + 4);
  assert.equal(entryCount, 1, 'entry_count must be 1 (one IDR sample)');

  // 3. sample_numbers MUST start at stssPayload + 8
  const sampleNum = view.getUint32(stssPayload + 8);
  assert.equal(sampleNum, 1, 'First sync sample must be 1');
});
