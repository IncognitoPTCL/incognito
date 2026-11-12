// Just enough Solana for this pad, with no library, in the browser.
//
// - A fresh deployer keypair, made with WebCrypto Ed25519. The secret never
//   leaves this browser: it is kept in localStorage and in the backup the
//   user downloads, and the server never sees it.
// - Signing a transaction somebody else built (PumpPortal's create tx) by
//   writing a signature into the right slot.
// - Building a plain SOL transfer (withdraw, and fund-from-your-wallet).
//
// readTransaction/placeSignature and base58 come from an earlier pad's
// soltx.js, checked against @solana/web3.js on real PumpPortal
// transactions.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function base58(bytes) {
  const input = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;
  let out = '1'.repeat(zeros);
  if (zeros === input.length) return out;
  const digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

export function unbase58(str) {
  const s = String(str);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros += 1;
  const bytes = []; // little-endian while accumulating
  for (let k = zeros; k < s.length; k += 1) {
    let carry = B58_MAP[s[k]];
    if (carry === undefined) throw new Error('not base58');
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function isAddress(s) {
  try {
    return typeof s === 'string' && s.length >= 32 && s.length <= 44 && unbase58(s).length === 32;
  } catch {
    return false;
  }
}

export const toB64 = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

/* ------------------------------------------------------------ wire format */
function shortVec(bytes, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error('transaction ended inside a length');
    i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error('compact-u16 is too long');
  }
  return { value, next: i };
}

function encodeShortVec(n) {
  const out = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) return out;
  }
}

export function readTransaction(raw) {
  const bytes = Uint8Array.from(raw);
  const sigs = shortVec(bytes, 0);
  const sigCount = sigs.value;
  const messageStart = sigs.next + sigCount * 64;
  if (messageStart > bytes.length) throw new Error('transaction is shorter than its own signature list');
  let i = messageStart;
  const first = bytes[i];
  const versioned = (first & 0x80) !== 0;
  if (versioned) i += 1;
  const required = bytes[i];
  i += 3;
  const keys = shortVec(bytes, i);
  i = keys.next;
  const accounts = [];
  for (let k = 0; k < keys.value; k += 1) {
    accounts.push(base58(bytes.slice(i, i + 32)));
    i += 32;
  }
  return { bytes, sigCount, sigStart: sigs.next, messageStart, message: bytes.slice(messageStart), required, accounts, signers: accounts.slice(0, required) };
}

export function placeSignature(raw, address, signature) {
  const tx = readTransaction(raw);
  const index = tx.signers.indexOf(address);
  if (index === -1) throw new Error(`${address.slice(0, 8)}... is not a signer of this transaction`);
  if (signature.length !== 64) throw new Error('a signature is 64 bytes');
  const out = Uint8Array.from(tx.bytes);
  out.set(signature, tx.sigStart + index * 64);
  return out;
}

/* ------------------------------------------------------------- keypairs */
// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export async function canSign() {
  try {
    await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

/** Load a signer from its 32-byte seed. The address is derived, never trusted from storage. */
export async function signerFromSeed(seed) {
  if (seed.length !== 32) throw new Error('a seed is 32 bytes');
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = b64url(jwk.x);
  return {
    address: base58(pub),
    publicKey: pub,
    seed: Uint8Array.from(seed),
    /** The 64-byte secret wallets import (seed then public key). */
    secret: Uint8Array.from([...seed, ...pub]),
    sign: async (message) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, message)),
  };
}

/** A brand-new keypair. */
export async function freshSigner() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const s = await signerFromSeed(seed);
  // Belt and braces: the derived address must match the generated public key.
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  if (base58(raw) !== s.address) throw new Error('key derivation mismatch');
  return s;
}

/** Accept a backup as base58 (Phantom export) or a JSON byte array (solana-keygen file). */
export async function signerFromBackup(text) {
  const t = String(text || '').trim();
  let bytes;
  if (t.startsWith('[')) bytes = Uint8Array.from(JSON.parse(t));
  else bytes = unbase58(t);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('That is not a Solana private key.');
  const s = await signerFromSeed(bytes.slice(0, 32));
  if (bytes.length === 64 && base58(bytes.slice(32)) !== s.address) throw new Error('That key does not match its own public half.');
  return s;
}

/* -------------------------------------------------------------- transfer */
const SYSTEM_PROGRAM = new Uint8Array(32);

/** The message bytes of a legacy SOL transfer. `from` pays the fee and signs. */
export function transferMessage({ from, to, lamports, blockhash }) {
  if (from === to) throw new Error('That is the same wallet.');
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // SystemInstruction::Transfer
  dv.setBigUint64(4, BigInt(lamports), true);
  return Uint8Array.from([
    1, 0, 1, // 1 signer, 0 readonly signed, 1 readonly unsigned (the program)
    ...encodeShortVec(3),
    ...unbase58(from),
    ...unbase58(to),
    ...SYSTEM_PROGRAM,
    ...unbase58(blockhash),
    ...encodeShortVec(1),
    2, // program id index
    ...encodeShortVec(2), 0, 1,
    ...encodeShortVec(data.length), ...data,
  ]);
}

/** Wrap a single-signer message as an unsigned (zeroed) transaction. */
export function unsignedTransaction(message) {
  return Uint8Array.from([...encodeShortVec(1), ...new Uint8Array(64), ...message]);
}

export function signedTransaction(message, signature) {
  return Uint8Array.from([...encodeShortVec(1), ...signature, ...message]);
}
