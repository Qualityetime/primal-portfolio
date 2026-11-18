import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let promise;
export function loadActualBoarGLTF() {
  promise ??= (async () => {
    const previousSelf = globalThis.self, previousBitmap = globalThis.createImageBitmap;
    globalThis.self = globalThis;
    // Exercise the real GLTFLoader and embedded PNG path without a browser/GPU.
    globalThis.createImageBitmap = async blob => {
      const bytes = Buffer.from(await blob.arrayBuffer());
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      assert.equal(bytes[24], 8); assert.equal(bytes[28], 0);
      const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[bytes[25]];
      assert.ok(channels);
      const data = [];
      for (let offset = 8; offset < bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
      }
      assert.equal(inflateSync(Buffer.concat(data)).length, (width * channels + 1) * height);
      return { width, height, close() {} };
    };
    try {
      const bytes = await readFile(new URL('../../../public/game/ironhide-boar.glb', import.meta.url));
      return await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    } finally {
      if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
      if (previousBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previousBitmap;
    }
  })();
  return promise;
}
