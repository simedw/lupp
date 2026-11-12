import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

test("shipped icon has canonical Dock geometry, opaque artwork and clean alpha margins", async () => {
  const png = await readFile(new URL("../../desktop/assets/lupp-icon.png", import.meta.url));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[24], 8, "8-bit PNG");
  assert.equal(png[25], 6, "RGBA PNG");
  assert.equal(png[28], 0, "Non-interlaced PNG");
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  // Decode PNG row filters directly: no image-processing dependency in npm.
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = 1024 * 4;
  const pixels = Buffer.alloc(stride * 1024);
  for (let y = 0; y < 1024; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const pos = y * stride + x;
      const left = x >= 4 ? pixels[pos - 4] : 0;
      const above = y ? pixels[pos - stride] : 0;
      const corner = y && x >= 4 ? pixels[pos - stride - 4] : 0;
      const p = left + above - corner;
      const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - corner);
      const predictor = [0, left, above, Math.floor((left + above) / 2), pa <= pb && pa <= pc ? left : pb <= pc ? above : corner][filter];
      assert.notEqual(predictor, undefined);
      pixels[pos] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  let opaque = 0, partial = 0, minX = 1024, minY = 1024, maxX = -1, maxY = -1;
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const alpha = pixels[(y * 1024 + x) * 4 + 3];
    if (x < 100 || x >= 924 || y < 100 || y >= 924) assert.equal(alpha, 0, `Stray alpha at ${x},${y}`);
    if (x >= 350 && x < 674 && y >= 350 && y < 674) assert.equal(alpha, 255, "Artwork must be fully opaque");
    if (alpha === 255) opaque++;
    else if (alpha > 0) partial++;
    if (alpha >= 128) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  assert.deepEqual([minX, minY, maxX, maxY], [100, 100, 923, 923]);
  assert.ok(opaque > 600_000, "Solid tile, not a translucent generated background");
  assert.ok(partial < 6_000, "Antialiasing confined to the tile edge");
});
