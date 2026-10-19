// Only the carved surface and shape travel to the gallery. No camera images.
export const ART_SIZE = 512;
// A one-pixel run is the worst case: three bytes, or four base64 characters.
// Local backups must preserve every possible surface, including fine detail.
export const MAX_MASK_LENGTH = ART_SIZE * ART_SIZE * 4;
export const MAX_GALLERY_MASK_LENGTH = 180000;
export function encodeMask(rgba) {
  if (rgba.length !== ART_SIZE * ART_SIZE * 4) throw new Error('Invalid surface size');
  const bytes = [];
  let value = rgba[3], run = 0;
  const flush = () => { bytes.push(run >> 8, run & 255, value); };
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== value || run === 65535) { flush(); run = 0; value = rgba[i]; }
    run++;
  }
  flush();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.slice(i, i + 8192));
  const encoded = btoa(binary);
  if (encoded.length > MAX_MASK_LENGTH) throw new Error('Invalid surface size');
  return encoded;
}
export function decodeMask(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > MAX_MASK_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4) throw new Error('Invalid surface data');
  const binary = atob(encoded);
  if (binary.length % 3) throw new Error('Invalid surface runs');
  const rgba = new Uint8ClampedArray(ART_SIZE * ART_SIZE * 4);
  let pixel = 0;
  for (let i = 0; i < binary.length; i += 3) {
    const count = binary.charCodeAt(i) * 256 + binary.charCodeAt(i + 1), value = binary.charCodeAt(i + 2);
    if (!count || pixel + count > ART_SIZE * ART_SIZE) throw new Error('Invalid surface length');
    for (let end = pixel + count; pixel < end; pixel++) { rgba[pixel * 4] = rgba[pixel * 4 + 1] = rgba[pixel * 4 + 2] = 255; rgba[pixel * 4 + 3] = value; }
  }
  if (pixel !== ART_SIZE * ART_SIZE) throw new Error('Incomplete surface');
  return rgba;
}
export function validateArtwork(value) {
  if (!value || value.version !== 1 || !['round', 'tall', 'wide'].includes(value.shape)) throw new Error('Invalid artwork');
  decodeMask(value.mask);
  return { version: 1, shape: value.shape, mask: value.mask };
}
