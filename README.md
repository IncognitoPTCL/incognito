# Incognito

Private trading and launching on Solana. Your wallet never touches the chart.

Every launch and every trade on Incognito runs from a fresh wallet made in your browser. Your main wallet never appears in a coin's trades or holders. Keys are made and kept in your browser; the server never sees them and signs nothing.

Live: https://incognito-pad.vercel.app · X: [@IncognitoPTCL](https://x.com/IncognitoPTCL)

## What it does

- **Terminal**
  - **Discover**: a sortable table of trending pump.fun coins (market cap, liquidity, volume and transactions for 5m, 1h, 6h or 24h), with one-click buys.
  - **Pulse**: three live columns: New pairs, Final stretch (bonding curve progress read from the chain) and Migrated.
  - **Filters** on every list: market cap, liquidity, volume, age, transactions, bonding %, socials, DEX paid, keywords.
  - **X previews**: hover a coin's X link to see the profile or tweet.
  - **Coin page**: chart and live trades (DexScreener embed) next to a buy and sell panel.
- **Launch**: create a pump.fun coin from a brand-new deployer wallet, with an optional first buy in the same transaction.
- **Wallets**: every fresh wallet made in this browser. Back up a key (Phantom-compatible base58, or a `solana-keygen` JSON file), import one, withdraw all SOL, or claim creator fees.

## What stays public

Incognito breaks the link between your main wallet and the chart, not every link on chain:

- The fresh wallet's own trades are public, like any wallet's.
- The transfer that funds a fresh wallet is visible, so the wallet it came from is on record.
- Withdrawals back to a normal wallet are visible.

## How it works

```
browser                                         server (holds no key)
-------                                         ---------------------
fresh keypair (WebCrypto Ed25519)
   |  public address only
   +-------------------------------------------> /api/create, /api/trade, /api/claim
                                                    ask PumpPortal for an UNSIGNED transaction
   <--------------------------------------------- unsigned transaction
check the signers and the program, sign locally
   +-------------------------------------------> /api/rpc  (sendTransaction, relayed as-is)
```

- `public/sol.js`: keypairs, signing, base58 and a hand-built SOL transfer, with no library. `test/sol.test.mjs` checks every byte against `@solana/web3.js`.
- `public/app.js`: launch, trade, wallets and routing. `public/terminal.js`: Pulse. `public/discover.js`: Discover. `public/filters.js`, `public/xcard.js`, `public/pixels.js`, `public/logo.js`.
- `lib/app.mjs`: every API route as one handler. Locally `server.mjs` runs it; on Vercel `build.mjs` bundles it into `api/index.mjs`.

### Data sources (all keyless)

| What | From |
| --- | --- |
| Build launch, trade and claim transactions | [PumpPortal](https://pumpportal.fun) `trade-local` |
| New coins and graduations, live | PumpPortal websocket (`subscribeNewToken`, `subscribeMigration`) |
| Column lists, trending | [GeckoTerminal](https://www.geckoterminal.com) |
| Market data, chart | [DexScreener](https://dexscreener.com) |
| Bonding curve progress | the curve account itself, over Solana RPC |
| X previews | [FxTwitter](https://github.com/FixTweet/FxTwitter) |

## Run it

Needs Node 20+.

```bash
npm install
cp .env.example .env.local   # optional, see below
npm start                    # http://localhost:4981
npm test                     # byte parity with @solana/web3.js
```

### Settings (`.env.local`, or the Vercel project's environment variables)

| Variable | Why |
| --- | --- |
| `SOLANA_RPC` | Your own RPC (Helius, Triton...). Without it the server falls back to two public endpoints, which rate-limit under load. |
| `PINATA_JWT` | Optional. Hosts a new coin's image and metadata on IPFS through Pinata instead. With no key, the browser uploads them to Arweave through [ArDrive Turbo](https://ardrive.io/turbo) (free under 105 KiB, the image is shrunk to fit). `BLOB_READ_WRITE_TOKEN` (Vercel Blob) also works. |
| `PAD_PASSWORD` | Optional: the pad asks for this before anything works. |
| `LAUNCH_PRIORITY_FEE_SOL`, `LAUNCH_MAX_BUY_SOL` | Launch fee and first-buy cap. |

## Deploy

`bash deploy.sh` builds `api/index.mjs` and deploys a git-free copy to Vercel production.

## Safety

- Back up a fresh wallet's key before you fund it. It lives only in your browser's storage; clearing site data without a backup loses whatever is in it.
- The pad checks every transaction PumpPortal builds (who signs it, which program it calls) before signing.
- Trading memecoins can lose everything you put in. Nothing here is advice.

## License

MIT. See [LICENSE](LICENSE).
