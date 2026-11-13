// The Arweave uploads a launch makes are ANS-104 data items built by hand in public/host.js.
// Turbo only stores them free if they verify, so they must match @dha-team/arbundles (the library
// Turbo uses) byte for byte. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataItem, createData, SolanaSigner } from '@dha-team/arbundles';
import { signerFromSeed, base58 } from '../public/sol.js';
import { signedDataItem, arweaveUrl } from '../public/host.js';

const cases = [
  ['metadata json', new TextEncoder().encode(JSON.stringify({ name: 'Test', symbol: 'TEST', image: 'https://ardrive.net/x' })), [{ name: 'Content-Type', value: 'application/json' }, { name: 'App-Name', value: 'Incognito' }]],
  ['90 KB image', Uint8Array.from({ length: 90 * 1024 }, (_, i) => (i * 131 + 7) % 256), [{ name: 'Content-Type', value: 'image/webp' }, { name: 'App-Name', value: 'Incognito' }]],
  ['tag over 63 bytes (multi-byte length)', new Uint8Array([1, 2, 3]), [{ name: 'Content-Type', value: 'x'.repeat(300) }]],
];

for (const [label, data, tags] of cases) {
  test(`data item matches arbundles: ${label}`, async () => {
    const signer = await signerFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    const anchor = 'abcdefghijklmnopqrstuvwxyz012345';
    const mine = await signedDataItem(data, tags, signer, new TextEncoder().encode(anchor));
    const raw = Buffer.from(mine.bytes);

    assert.equal(await DataItem.verify(raw), true, 'the signature verifies');
    const item = new DataItem(raw);
    assert.equal(item.id, mine.id);
    assert.equal(item.signatureType, 2);
    assert.equal(base58(item.rawOwner), signer.address);
    assert.deepEqual(item.tags, tags);
    assert.deepEqual(Buffer.from(item.rawData), Buffer.from(data));

    const ss = new SolanaSigner(base58(signer.secret));
    const ref = createData(data, ss, { tags, anchor });
    await ref.sign(ss);
    assert.deepEqual(raw, ref.getRaw(), 'byte-identical to the reference');
  });
}

test('links point at a gateway that serves new uploads at once', () => {
  assert.equal(arweaveUrl('abc'), 'https://ardrive.net/abc');
});
