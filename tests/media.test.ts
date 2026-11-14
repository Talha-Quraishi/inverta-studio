import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  downloadFileName,
  getFileExtension,
  imageExtensionForMime,
  isSupportedImageFile,
  isSupportedMediaFile,
  isVideoFile,
  normalizeImageMime,
  sanitizeBaseName,
  validateFile,
} from '../src/utils/media.ts';

function fakeFile(name: string, type: string, size = 128): File {
  return { name, type, size } as File;
}

test('getFileExtension lowercases the trailing extension', () => {
  assert.equal(getFileExtension('Photo.PNG'), 'png');
  assert.equal(getFileExtension('archive.tar.gz'), 'gz');
  assert.equal(getFileExtension('no-extension'), '');
});

test('video detection accepts mp4 MIME and extension fallbacks', () => {
  assert.equal(isVideoFile(fakeFile('clip.mp4', 'video/mp4')), true);
  assert.equal(isVideoFile(fakeFile('clip.mp4', '')), true);
  assert.equal(isVideoFile(fakeFile('clip.mov', 'video/quicktime')), false);
});

test('image detection accepts known MIME types and uppercase extensions', () => {
  assert.equal(isSupportedImageFile(fakeFile('a.png', 'image/png')), true);
  assert.equal(isSupportedImageFile(fakeFile('a.JPG', '')), true);
  assert.equal(isSupportedImageFile(fakeFile('a.webp', 'application/octet-stream')), true);
  assert.equal(isSupportedImageFile(fakeFile('a.gif', 'image/gif')), false);
  assert.equal(isSupportedImageFile(fakeFile('a.svg', 'image/svg+xml')), false);
});

test('isSupportedMediaFile covers both media classes', () => {
  assert.equal(isSupportedMediaFile(fakeFile('a.png', 'image/png')), true);
  assert.equal(isSupportedMediaFile(fakeFile('a.mp4', 'video/mp4')), true);
  assert.equal(isSupportedMediaFile(fakeFile('a.txt', 'text/plain')), false);
});

test('validateFile enforces type and size limits', () => {
  assert.equal(validateFile(fakeFile('a.png', 'image/png')), null);
  assert.equal(validateFile(fakeFile('a.mp4', 'video/mp4')), null);

  assert.match(
    validateFile(fakeFile('a.gif', 'image/gif')) ?? '',
    /unsupported file type/
  );
  assert.match(
    validateFile(fakeFile('huge.png', 'image/png', MAX_IMAGE_BYTES + 1)) ?? '',
    /image exceeds/
  );
  assert.match(
    validateFile(fakeFile('huge.mp4', 'video/mp4', MAX_VIDEO_BYTES + 1)) ?? '',
    /video exceeds/
  );
});

test('image MIME normalization maps aliases and falls back to PNG', () => {
  assert.equal(normalizeImageMime('image/jpg'), 'image/jpeg');
  assert.equal(normalizeImageMime('IMAGE/WEBP'), 'image/webp');
  assert.equal(normalizeImageMime('image/gif'), 'image/png');
  assert.equal(normalizeImageMime(''), 'image/png');

  assert.equal(imageExtensionForMime('image/jpeg'), 'jpg');
  assert.equal(imageExtensionForMime('image/jpg'), 'jpg');
  assert.equal(imageExtensionForMime('image/webp'), 'webp');
  assert.equal(imageExtensionForMime('image/bmp'), 'bmp');
});

test('sanitizeBaseName removes paths, reserved characters and extensions', () => {
  assert.equal(sanitizeBaseName('holiday.photo.png'), 'holiday.photo');
  assert.equal(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j.png'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeBaseName('   '), 'media');
  assert.equal(sanitizeBaseName(''), 'media');
});

test('downloadFileName produces safe names with a controlled extension', () => {
  assert.equal(downloadFileName('My Photo.PNG', 'png'), 'cleaned_My Photo.png');
  assert.equal(downloadFileName('video.mp4', 'mp4', 'original'), 'original_video.mp4');
  assert.equal(downloadFileName('bad<name>.png', '../../weird ext'), 'cleaned_bad_name_.weirdext');
});
