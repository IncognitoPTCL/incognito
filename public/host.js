// Hosting a new coin's image and metadata with no key: Arweave through ArDrive Turbo, uploaded
// straight from this browser. Turbo stores SIGNED data items under 105 KiB free (its free tier is
// counted per signer and per connection, so each visitor spends their own). Each upload is an
// ANS-104 data item signed here with a throwaway ed25519 key that holds nothing; Turbo's unsigned
// endpoint is the paid x402 one, so it is not used. The image is shrunk under the limit first.
// Data on Arweave is permanent.
import { freshSigner } from './sol.js';

const TURBO = 'https://upload.ardrive.io/v1/tx';
const FREE_MAX = 100 * 1024; // a margin under Turbo's 105 KiB free item limit
const IMAGE_MAX = 92 * 1024;
// ardrive.net is the gateway Turbo caches new uploads on, so a link works the moment the upload
// returns (pump.fun reads the metadata right after launch). arweave.net only serves an item once
// it is bundled on chain, which can take hours.
export const arweaveUrl = (id) => `https://ardrive.net/${id}`;

const fromDataUrl = (dataUrl) => {
  const comma = dataUrl.indexOf(',');
  return { type: dataUrl.slice(5, dataUrl.indexOf(';')), bytes: Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0)) };
};

/** The image as it will be stored: unchanged if it already fits, else redrawn smaller as WebP (or JPEG). */
export async function shrinkImage(dataUrl) {
  const original = fromDataUrl(dataUrl);
  if (original.bytes.length <= IMAGE_MAX) return original;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That image could not be read.'));
    i.src = dataUrl;
  });
  const encode = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  for (const size of [512, 420, 340, 256]) {
    const scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.86, 0.72, 0.58]) {
      let blob = await encode(canvas, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', q); // browsers without WebP encoding
      if (blob && blob.size <= IMAGE_MAX) return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
  }
  throw new Error('Could not get that image under 92 KB. Try a smaller one.');
}

/* ------------------------------------------------ ANS-104 data items (the Arweave bundle format) */
const enc = new TextEncoder();
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha = async (algo, bytes) => new Uint8Array(await crypto.subtle.digest(algo, bytes));
const sha384 = (bytes) => sha('SHA-384', bytes);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** Arweave's deep hash: what a data item's signature covers. */
async function deepHash(data) {
  if (Array.isArray(data)) {
    let acc = await sha384(concat(enc.encode('list'), enc.encode(String(data.length))));
    for (const chunk of data) acc = await sha384(concat(acc, await deepHash(chunk)));
    return acc;
  }
  const tag = concat(enc.encode('blob'), enc.encode(String(data.length)));
  return sha384(concat(await sha384(tag), await sha384(data)));
}

/** Avro long: zigzag, then base-128 varint. */
function avroLong(n) {
  let z = n >= 0 ? n * 2 : -n * 2 - 1;
  const out = [];
  do {
    let byte = z % 128;
    z = Math.floor(z / 128);
    if (z > 0) byte |= 0x80;
    out.push(byte);
  } while (z > 0);
  return Uint8Array.from(out);
}
/** Tags as an Avro array of { name: bytes, value: bytes }. */
function serializeTags(tags) {
  if (!tags.length) return new Uint8Array(0);
  const parts = [avroLong(tags.length)];
  for (const t of tags) {
    const name = enc.encode(t.name);
    const value = enc.encode(t.value);
    parts.push(avroLong(name.length), name, avroLong(value.length), value);
  }
  parts.push(avroLong(0));
  return concat(...parts);
}
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

// ANS-104 type 2: ed25519 over the deep hash itself, 64-byte signature, 32-byte owner. This is what
// a raw Solana key signs with (arbundles' SolanaSigner). Type 4 is for wallet extensions and signs
// the hex text of the hash instead, so it would not verify here.
const SIG_SOLANA = 2;

/** A signed ANS-104 data item: { id, bytes }. The id is the base64url SHA-256 of the signature. */
export async function signedDataItem(data, tags, signer, anchor = crypto.getRandomValues(new Uint8Array(32))) {
  const owner = signer.publicKey;
  const tagBytes = serializeTags(tags);
  const message = await deepHash([
    enc.encode('dataitem'), enc.encode('1'), enc.encode(String(SIG_SOLANA)),
    owner, new Uint8Array(0), anchor, tagBytes, data,
  ]);
  const signature = await signer.sign(message);
  if (signature.length !== 64 || owner.length !== 32) throw new Error('signing failed');
  const sigType = new Uint8Array([SIG_SOLANA, 0]);
  const bytes = concat(sigType, signature, owner, new Uint8Array([0]), new Uint8Array([1]), anchor, u64(tags.length), u64(tagBytes.length), tagBytes, data);
  return { id: b64url(await sha('SHA-256', signature)), bytes };
}

/** Store bytes on Arweave through Turbo's free tier. Returns the Arweave id. */
export async function turboUpload(bytes, contentType, signer) {
  if (bytes.length > FREE_MAX) throw new Error('That file is over the free upload size.');
  const item = await signedDataItem(bytes, [{ name: 'Content-Type', value: contentType }, { name: 'App-Name', value: 'Incognito' }], signer);
  let r;
  try {
    r = await fetch(TURBO, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: item.bytes });
  } catch (e) {
    throw new Error(`Arweave could not be reached (${e.message}). Nothing was signed.`);
  }
  const text = await r.text();
  if (r.status === 402) throw new Error('Arweave asked for payment: the free upload allowance for this connection is used up. Nothing was signed.');
  if (!r.ok) throw new Error(`Arweave refused the upload (${r.status}): ${text.slice(0, 140)}. Nothing was signed.`);
  let j = null;
  try { j = JSON.parse(text); } catch { /* checked below */ }
  const id = j?.id || item.id;
  if (id !== item.id) throw new Error('Arweave stored something other than what was sent. Nothing was signed.');
  return id;
}

const link = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
};

/** Upload the image, then the pump.fun-style metadata pointing at it. Returns { uri, image, via }. */
export async function hostOnArweave({ name, symbol, description, twitter, telegram, website, image }) {
  const { bytes, type } = await shrinkImage(image);
  // a throwaway key signs both uploads; it never holds anything and is dropped afterwards
  const signer = await freshSigner();
  const imageUrl = arweaveUrl(await turboUpload(bytes, type, signer));
  const doc = {
    name, symbol, description, image: imageUrl, showName: true, createdOn: 'https://pump.fun',
    twitter: link(twitter), telegram: link(telegram), website: link(website),
  };
  const uri = arweaveUrl(await turboUpload(enc.encode(JSON.stringify(doc)), 'application/json', signer));
  return { uri, image: imageUrl, via: 'Arweave' };
}
