/**
 * Pure MP4 box parsing and patching utilities with zero DOM/WebCodecs dependencies.
 */

interface Box {
  type: string;
  start: number;
  end: number;
  payload: number;
}

/**
 * Reads the display rotation from the MP4 track matrix. Phone recordings often
 * store landscape frames with a 90/270 degree matrix; re-encoding must apply it.
 */
export function getRotationDegrees(track: any): 0 | 90 | 180 | 270 {
  const matrix: ArrayLike<number> | undefined = track?.matrix;
  if (!matrix || typeof matrix.length !== 'number' || matrix.length < 5) return 0;

  const a = Number(matrix[0]) / 65536;
  const b = Number(matrix[1]) / 65536;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;

  const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  return 0;
}

/**
 * Some generated MP4s ship with an stss sync table whose entry_count is 0,
 * even though keyframes exist throughout the bitstream. Chromium refuses every
 * seek on such videos with PIPELINE_ERROR_DECODE.
 *
 * This function detects an explicitly empty sync table (entry_count === 0),
 * scans AVC NAL units for real IDR samples, and patches the stss box in-place
 * on a COPY of the source buffer.
 *
 * FullBox stss layout:
 * - Bytes 0..3: Box size
 * - Bytes 4..7: Box type ('stss')
 * - Bytes 8..11: Version (1 byte) + Flags (3 bytes)
 * - Bytes 12..15: entry_count (32-bit unsigned int)
 * - Bytes 16+: Array of 32-bit sample numbers
 *
 * If entry_count > 0, the table already contains sync samples and is left untouched.
 */
export function buildSeekablePlaybackBuffer(
  buffer: ArrayBuffer,
  videoSamples: any[],
  videoTrack: any
): ArrayBuffer | null {
  const codec = String(videoTrack?.codec || '').toLowerCase();
  if (!codec.startsWith('avc1') && !codec.startsWith('avc3')) return null;

  const view = new DataView(buffer);
  const fourCC = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );

  const readBox = (offset: number, end: number): Box | null => {
    if (offset + 8 > end) return null;
    let size = view.getUint32(offset);
    const type = fourCC(offset + 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return null;
    return { type, start: offset, end: offset + size, payload: offset + header };
  };

  const findChild = (start: number, end: number, type: string): Box | null => {
    let offset = start;
    while (offset + 8 <= end) {
      const box = readBox(offset, end);
      if (!box) return null;
      if (box.type === type) return box;
      offset = box.end;
    }
    return null;
  };

  const moov = findChild(0, buffer.byteLength, 'moov');
  if (!moov) return null;

  let stss: Box | null = null;
  let lengthSize = 4;

  let trakOffset = moov.payload;
  while (trakOffset + 8 <= moov.end) {
    const trak = readBox(trakOffset, moov.end);
    if (!trak) break;
    trakOffset = trak.end;
    if (trak.type !== 'trak') continue;

    const mdia = findChild(trak.payload, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = findChild(mdia.payload, mdia.end, 'hdlr');
    if (!hdlr || hdlr.payload + 12 > hdlr.end) continue;
    if (fourCC(hdlr.payload + 8) !== 'vide') continue;

    const minf = findChild(mdia.payload, mdia.end, 'minf');
    if (!minf) continue;
    const stbl = findChild(minf.payload, minf.end, 'stbl');
    if (!stbl) continue;
    const stsd = findChild(stbl.payload, stbl.end, 'stsd');
    const avcC = stsd ? findChild(stsd.payload + 8, stsd.end, 'avcC') : null;
    if (avcC && avcC.payload + 5 <= avcC.end) {
      lengthSize = (view.getUint8(avcC.payload + 4) & 0x03) + 1;
    }
    stss = findChild(stbl.payload, stbl.end, 'stss');
    break;
  }

  // FullBox: version & flags are at stss.payload (4 bytes)
  // entry_count is at stss.payload + 4 (4 bytes)
  // sample numbers start at stss.payload + 8
  if (!stss || stss.payload + 8 > stss.end) return null;
  const entryCount = view.getUint32(stss.payload + 4);
  if (entryCount !== 0) return null;

  const capacity = Math.floor((stss.end - (stss.payload + 8)) / 4);
  if (capacity < 1) return null;

  const sampleHasIdr = (data: Uint8Array): boolean => {
    let offset = 0;
    while (offset + lengthSize <= data.length) {
      let length = 0;
      for (let i = 0; i < lengthSize; i++) {
        length = length * 256 + data[offset + i];
      }
      offset += lengthSize;
      if (length <= 0 || offset + length > data.length) return false;
      if ((data[offset] & 0x1f) === 5) return true;
      offset += length;
    }
    return false;
  };

  const idrSamples: number[] = [];
  for (let i = 0; i < videoSamples.length; i++) {
    const data = videoSamples[i]?.data;
    if (data && sampleHasIdr(data)) idrSamples.push(i + 1);
  }
  if (idrSamples.length === 0) return null;

  // Keep up to the box's existing capacity, spread across the whole clip.
  const count = Math.min(capacity, idrSamples.length);
  const chosen: number[] = [];
  for (let i = 0; i < count; i++) {
    chosen.push(idrSamples[Math.floor((i * idrSamples.length) / count)]);
  }

  const patched = buffer.slice(0);
  const patchedView = new DataView(patched);
  // Preserve version (1 byte) + flags (3 bytes) at stss.payload
  patchedView.setUint32(stss.payload + 4, count);
  let writeAt = stss.payload + 8;
  for (const sampleNumber of chosen) {
    patchedView.setUint32(writeAt, sampleNumber);
    writeAt += 4;
  }
  while (writeAt < stss.end) {
    patchedView.setUint8(writeAt, 0);
    writeAt++;
  }
  return patched;
}
