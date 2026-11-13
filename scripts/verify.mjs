// Dry-run every transaction Incognito builds against Solana mainnet, without spending anything.
//
//   npm run verify                       # against the live site
//   npm run verify -- http://localhost:4981
//
// The pad's own API builds each transaction exactly as it does for a visitor. Each is then run
// through simulateTransaction with signature checks off and a fresh blockhash: the chain executes
// it against current mainnet state and reports success or the exact error. Nothing is signed,
// nothing is sent, no key is needed. Accounts with SOL stand in as the payer, found among a live
// coin's holders. Program logs are printed for anything that fails.
import { freshSigner, readTransaction, fromB64, toB64, base58, transferMessage, unsignedTransaction } from '../public/sol.js';

const BASE = (process.argv[2] || 'https://www.useincognito.fun').replace(/\/+$/, '');
const RPC = process.env.VERIFY_RPC || 'https://api.mainnet-beta.solana.com'; // for finding stand-in accounts only
const SYSTEM = '11111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const postJson = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const pad = (path, body) => postJson(BASE + path, body);
// public RPC rate-limits now and then: retry with a short backoff
const chain = async (method, params) => {
  for (let i = 0; ; i += 1) {
    const j = await postJson(RPC, { jsonrpc: '2.0', id: 1, method, params }).catch((e) => ({ error: { message: e.message } }));
    if (!j.error || i === 4) return j.result;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
};

const results = [];
async function simulate(label, tx, expectSigners) {
  const t = readTransaction(fromB64(tx));
  const r = await pad('/api/rpc', { method: 'simulateTransaction', params: [tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] });
  const v = r.result?.value;
  const err = v ? v.err : r.error || 'no answer';
  const signersOk = !expectSigners || (t.signers.length === expectSigners.length && expectSigners.every((s) => t.signers.includes(s)));
  const ok = !err && signersOk;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${v?.unitsConsumed ?? '?'} compute units, ${t.signers.length} signer${t.signers.length === 1 ? '' : 's'})`);
  if (!signersOk) console.log(`      unexpected signers: ${t.signers.join(', ')}`);
  if (err) console.log(`      ${JSON.stringify(err)}\n      ${(v?.logs || []).filter((l) => /Error|failed|Instruction/.test(l)).slice(-4).join('\n      ')}`);
}
const skip = (label, why) => console.log(`SKIP  ${label}: ${why}`);

/**
 * A holder of the coin that can stand in as payer: an ordinary wallet (system account) with
 * between `min` lamports and 10,000 SOL, that PumpPortal will build trades for (it refuses some
 * large exchange and bot wallets outright).
 */
async function holderWithSol(mint, curve, min) {
  const mintAcc = await chain('getAccountInfo', [mint, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  if (!mintAcc?.value) return null;
  const all = await chain('getProgramAccounts', [mintAcc.value.owner, { encoding: 'base64', dataSlice: { offset: 32, length: 40 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }]) || [];
  const owners = all.map((a) => Buffer.from(a.account.data[0], 'base64')).filter((b) => b.readBigUInt64LE(32) > 0n)
    .map((b) => base58(b.subarray(0, 32))).filter((o) => o !== curve);
  for (const owner of owners.slice(0, 25)) {
    const acc = await chain('getAccountInfo', [owner, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    if (acc?.value?.owner !== SYSTEM || acc.value.lamports < min || acc.value.lamports > 10_000e9) continue;
    const probe = await pad('/api/trade', { publicKey: owner, action: 'buy', mint, amount: 0.01 });
    if (probe.tx) return owner;
  }
  return null;
}

console.log(`Incognito transaction check against ${BASE}\n`);
const lists = await (await fetch(`${BASE}/api/pulse/lists`)).json();
const onCurve = [...(lists.fin || []), ...(lists.new || [])].filter((c) => c.dex === 'pump-fun' && c.pool);
// deepest pools first: a thin, just-dumped pool is where a quote is most likely stale
const graduated = (lists.mig || []).filter((c) => c.dex !== 'pump-fun').sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
console.log(`Live lists: ${lists.new?.length ?? 0} new, ${lists.fin?.length ?? 0} final stretch, ${lists.mig?.length ?? 0} migrated\n`);

// a coin on its bonding curve, with a holder who has SOL to stand in as payer and seller
let coin = null;
let payer = null;
for (const c of onCurve.slice(0, 10)) {
  // the lists can lag a graduation: read the curve itself (byte 48 is "complete")
  const curve = await chain('getAccountInfo', [c.pool, { encoding: 'base64' }]);
  if (curve?.value?.owner !== PUMP || fromB64(curve.value.data[0])[48] !== 0) continue;
  payer = await holderWithSol(c.mint, c.pool, 60_000_000);
  if (payer) { coin = c; break; }
}
if (!payer) {
  console.log('No stand-in account with SOL was found among live holders; try again in a minute.');
  process.exit(1);
}
console.log(`Bonding-curve coin: $${coin.symbol} (${coin.mint})\nStand-in payer:     ${payer}\n`);

// 1. buy on the bonding curve
{
  const j = await pad('/api/trade', { publicKey: payer, action: 'buy', mint: coin.mint, amount: 0.01 });
  j.tx ? await simulate(`Buy 0.01 SOL of $${coin.symbol} on the bonding curve`, j.tx, [payer]) : skip('Buy on the curve', JSON.stringify(j));
}
// 2. sell half of what the stand-in holds
{
  const j = await pad('/api/trade', { publicKey: payer, action: 'sell', mint: coin.mint, amount: '50%' });
  j.tx ? await simulate(`Sell 50% of $${coin.symbol} back to the curve`, j.tx, [payer]) : skip('Sell', JSON.stringify(j));
}
// 3. buy a graduated coin (PumpSwap)
{
  // the first graduated coin the pad will build a buy for (it refuses, with a reason, any whose
  // pool price is too far from PumpPortal's quote)
  let done = false;
  for (const g of graduated.slice(0, 6)) {
    const j = await pad('/api/trade', { publicKey: payer, action: 'buy', mint: g.mint, amount: 0.01 });
    if (!j.tx) { console.log(`      ($${g.symbol}: ${j.error})`); continue; }
    await simulate(`Buy 0.01 SOL of $${g.symbol} on PumpSwap (graduated)`, j.tx, [payer]);
    done = true;
    break;
  }
  if (!done) skip('Buy on PumpSwap', 'no migrated coin in the live list could be built');
}
// 4. launch a coin, without and with a first buy, from a brand-new mint key made here
for (const buySol of [0, 0.01]) {
  const mint = await freshSigner();
  const j = await pad('/api/create', { publicKey: payer, mint: mint.address, name: 'Verify', symbol: 'VERIFY', uri: 'https://ardrive.net/mUyL01sf8onWVxUi9LUU58B1iqb_NGzuEQTzcPrAnOc', buySol });
  if (!j.tx) { skip('Launch', JSON.stringify(j)); continue; }
  const t = readTransaction(fromB64(j.tx));
  if (!t.accounts.includes(PUMP)) console.log('      the launch does not call pump.fun');
  await simulate(`Launch a coin${buySol ? ` with a ${buySol} SOL first buy in the same transaction` : ' (no first buy)'}`, j.tx, [payer, mint.address]);
}
// 5. claim creator fees, as the creator recorded on a bonding curve who has SOL for the fee
{
  let done = false;
  for (const c of onCurve) {
    const acc = await chain('getAccountInfo', [c.pool, { encoding: 'base64' }]);
    if (!acc?.value || acc.value.owner !== PUMP) continue;
    const creator = base58(fromB64(acc.value.data[0]).subarray(49, 81));
    const bal = await chain('getBalance', [creator]);
    if ((bal?.value ?? 0) < 10_000_000) continue;
    const j = await pad('/api/claim', { publicKey: creator });
    j.tx ? await simulate(`Claim creator fees as the creator of $${c.symbol}`, j.tx, [creator]) : skip('Claim', JSON.stringify(j));
    done = true;
    break;
  }
  if (!done) skip('Claim creator fees', 'no creator with SOL in the live list');
}
// 6. withdraw: the SOL transfer is built in the browser by public/sol.js, with no library
{
  const to = (await freshSigner()).address;
  const { value } = await chain('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = transferMessage({ from: payer, to, lamports: 5_000_000, blockhash: value.blockhash });
  await simulate('Withdraw 0.005 SOL (transfer built by public/sol.js)', toB64(unsignedTransaction(message)), [payer]);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed} of ${results.length} passed. Simulated only: nothing was signed or sent.`);
process.exit(passed === results.length ? 0 : 1);
