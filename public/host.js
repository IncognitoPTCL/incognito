// Hosting a new coin's image and metadata with no key: Arweave through ArDrive Turbo, uploaded
// straight from this browser. Turbo stores files under 105 KiB free, and the free allowance is
// counted per uploader, so each visitor spends their own rather than sharing the server's.
// The image is shrunk under the limit first. Data on Arweave is permanent.
const TURBO = 'https://upload.ardrive.io/v1/x402/data-item/unsigned';
const FREE_MAX = 100 * 1024; // a margin under Turbo's 105 KiB free item limit
const IMAGE_MAX = 92 * 1024;
export const arweaveUrl = (id) => `https://arweave.net/${id}`;

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

/** Store bytes on Arweave through Turbo's free tier. Returns the Arweave id. */
export async function turboUpload(bytes, contentType) {
  if (bytes.length > FREE_MAX) throw new Error('That file is over the free upload size.');
  let r;
  try {
    r = await fetch(TURBO, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-data-item-tags': JSON.stringify([{ name: 'Content-Type', value: contentType }, { name: 'App-Name', value: 'Incognito' }]),
      },
      body: bytes,
    });
  } catch (e) {
    throw new Error(`Arweave could not be reached (${e.message}). Nothing was signed.`);
  }
  const text = await r.text();
  if (r.status === 402) throw new Error('Arweave asked for payment: the free upload allowance for this connection is used up. Nothing was signed.');
  if (!r.ok) throw new Error(`Arweave refused the upload (${r.status}): ${text.slice(0, 140)}. Nothing was signed.`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('Arweave answered something unexpected. Nothing was signed.');
  }
  const id = j.id || j.dataItemId || j.txId;
  if (!/^[A-Za-z0-9_-]{43}$/.test(id || '')) throw new Error('Arweave returned no id. Nothing was signed.');
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
  const imageUrl = arweaveUrl(await turboUpload(bytes, type));
  const doc = {
    name, symbol, description, image: imageUrl, showName: true, createdOn: 'https://pump.fun',
    twitter: link(twitter), telegram: link(telegram), website: link(website),
  };
  const uri = arweaveUrl(await turboUpload(new TextEncoder().encode(JSON.stringify(doc)), 'application/json'));
  return { uri, image: imageUrl, via: 'Arweave' };
}
