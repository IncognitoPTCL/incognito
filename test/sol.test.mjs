// Parity: the hand-rolled key derivation and transfer message must match
// @solana/web3.js byte for byte (a dev dependency);
// the test skips when it is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { base58, unbase58, isAddress, freshSigner, signerFromSeed, signerFromBackup, transferMessage, signedTransaction, readTransaction, placeSignature } from '../public/sol.js';

let web3 = null;
try { web3 = createRequire(import.meta.url)('@solana/web3.js'); } catch { /* not installed: the parity tests skip */ }

test('base58 round trips, including leading zeros', () => {
  for (let n = 0; n < 500; n += 1) {
    const len = 1 + (n % 64);
    const b = new Uint8Array(len).map(() => Math.random() * 256);
    if (n % 7 === 0) b[0] = 0;
    if (n % 11 === 0) { b[0] = 0; if (len > 1) b[1] = 0; }
    assert.deepEqual(unbase58(base58(b)), b);
  }
  assert.equal(base58(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.deepEqual(unbase58('11111111111111111111111111111111'), new Uint8Array(32));
  assert.ok(isAddress('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
  assert.ok(!isAddress('not-an-address'));
});

test('fresh keys derive the same address as web3.js', { skip: !web3 }, async () => {
  for (let i = 0; i < 25; i += 1) {
    const s = await freshSigner();
    const kp = web3.Keypair.fromSeed(s.seed);
    assert.equal(s.address, kp.publicKey.toBase58());
    assert.deepEqual([...s.secret], [...kp.secretKey]);
    const back = await signerFromBackup(base58(s.secret));
    assert.equal(back.address, s.address);
    const back2 = await signerFromBackup(JSON.stringify([...s.secret]));
    assert.equal(back2.address, s.address);
  }
});

test('transfer message and signature match web3.js', { skip: !web3 }, async () => {
  const from = await freshSigner();
  const to = (await freshSigner()).address;
  const bh = base58(new Uint8Array(32).map(() => Math.random() * 256));
  for (const lamports of [1, 5000, 123456789, 2 ** 40 + 7]) {
    const msg = transferMessage({ from: from.address, to, lamports, blockhash: bh });
    const tx = new web3.Transaction({ feePayer: new web3.PublicKey(from.address), recentBlockhash: bh })
      .add(web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(from.address), toPubkey: new web3.PublicKey(to), lamports }));
    assert.deepEqual([...msg], [...tx.serializeMessage()]);
    const sig = await from.sign(msg);
    const raw = signedTransaction(msg, sig);
    tx.sign(web3.Keypair.fromSecretKey(from.secret));
    assert.deepEqual([...raw], [...tx.serialize()]);
    // and the reader/placer agree
    const r = readTransaction(raw);
    assert.deepEqual(r.signers, [from.address]);
    assert.deepEqual([...placeSignature(raw, from.address, sig)], [...raw]);
  }
});

test('a stored seed reloads to the same signer', async () => {
  const s = await freshSigner();
  const again = await signerFromSeed(unbase58(base58(s.seed)));
  assert.equal(again.address, s.address);
  const m = new Uint8Array([1, 2, 3]);
  assert.deepEqual(await again.sign(m), await s.sign(m));
});
