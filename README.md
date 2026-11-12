# Incognito

Private trading and launching on Solana. Buy and sell any pump.fun coin, or launch your own, from fresh wallets made in your browser, so your main wallet never touches the chart. Non-custodial and open source.

Live: [incognito-pad.vercel.app](https://incognito-pad.vercel.app) · X: [@IncognitoPTCL](https://x.com/IncognitoPTCL)

## The idea

Your wallet is public: every buy, every sell, every size, forever. Trackers label it, copy bots follow it in seconds, and the moment you launch a coin, everyone can see who the creator is and what else that wallet holds.

Incognito takes your main wallet out of the picture. **Every launch and every trade runs from a brand-new wallet made in your browser.** That wallet has no history, no label and no other holdings. On the chart you see a fresh wallet trading, never your main one.

There is no account and no deposit into anyone else's wallet. The keys are made and kept in your browser; the server never sees them and never signs anything. You back each key up (it imports straight into Phantom) and you can withdraw everything at any time.

## What the chain sees

| Step | Public | Kept off the chart |
| --- | --- | --- |
| Make a fresh wallet | nothing (the key is made in your browser) | - |
| Fund it | the transfer: which wallet sent it, which received it, how much | - |
| Buy or sell a coin | the fresh wallet's trades, sizes and holdings | your main wallet: it never appears in the coin's trades or holders |
| Launch a coin | the fresh wallet as the creator, the coin, its first buy | your main wallet as the creator, and everything else it holds |
| Claim creator fees | the claim, paid to the fresh wallet | your main wallet |
| Withdraw | the transfer back: where it went and how much | - |

**Honestly:** a fresh wallet hides your main wallet from the chart, not from the blockchain. Anyone who follows the funding transfer can link the two. What disappears is your main wallet from the coin's chart, trades and holder list.

## What you can do

- **Terminal**
  - **Discover**: trending pump.fun coins with market cap, liquidity, volume and transactions for 5m, 1h, 6h or 24h, sortable, with one-click buys.
  - **Pulse**: New pairs, Final stretch (bonding-curve progress read from the chain) and Migrated, live.
  - **Filters** on every list: market cap, liquidity, volume, age, transactions, bonding %, socials, DEX paid, keywords.
  - **X previews**: hover a coin's X link to see the profile or the tweet.
  - **Coin page**: chart and live trades next to a buy and sell panel.
  - **Quick buy**: one click from any list. With no wallet yet, a panel walks you through making one, saving its key and funding it.
- **Launch**: create a pump.fun coin from a fresh deployer with an optional first buy in the same transaction. The image and details go to Arweave with no key needed.
- **Wallets**: every fresh wallet made in this browser. Back up a key, import one, withdraw all SOL, or claim creator fees.

SOL pairs only: coins priced in another token (pump.fun now allows some) are left out, because SOL trades cannot fill them.

## How it works

```
browser                                         server (holds no key)
-------                                         ---------------------
fresh keypair (WebCrypto Ed25519)
   |  public address only
   +-------------------------------------------> /api/create, /api/trade, /api/claim
                                                    ask PumpPortal for an UNSIGNED transaction
   <--------------------------------------------- unsigned transaction
check who signs it and which program it calls, sign locally
   +-------------------------------------------> /api/rpc  (sendTransaction, relayed as-is)
```

- `public/sol.js`: keypairs, signing, base58 and a hand-built SOL transfer, with no library. `test/sol.test.mjs` checks every byte against `@solana/web3.js`.
- `public/app.js`: launch, trade, wallets and routing. `public/terminal.js`: Pulse. `public/discover.js`: Discover. `public/host.js`: Arweave hosting for launches.
- `lib/app.mjs`: every API route as one handler, with per-visitor rate limits. Locally `server.mjs` runs it; on Vercel `build.mjs` bundles it into `api/index.mjs`.

### Data sources (all keyless)

| What | From |
| --- | --- |
| Launch, trade and claim transactions | [PumpPortal](https://pumpportal.fun) `trade-local` |
| New coins and graduations, live | PumpPortal websocket |
| Column lists, trending | [GeckoTerminal](https://www.geckoterminal.com) |
| Market data, chart | [DexScreener](https://dexscreener.com) |
| Bonding-curve progress | the curve account itself, over Solana RPC |
| Coin images for launches | Arweave through [ArDrive Turbo](https://ardrive.io/turbo) |
| X previews | [FxTwitter](https://github.com/FixTweet/FxTwitter) |

## Fees

Incognito charges nothing. pump.fun's own trading fee applies, PumpPortal takes 0.5% of each trade it builds, and Solana network fees apply to every transaction.

## Run it

Needs Node 20+.

```bash
npm install
cp .env.example .env.local   # optional
npm start                    # http://localhost:4981
npm test                     # byte parity with @solana/web3.js
```

| Variable | Why |
| --- | --- |
| `SOLANA_RPC` | Your own RPC (Helius, Triton...). Without it the server falls back to two public endpoints, which rate-limit under load. |
| `PINATA_JWT` | Optional: host launch images on IPFS through Pinata instead of Arweave. |
| `PAD_PASSWORD` | Optional: ask for a password before anything works. |
| `LAUNCH_PRIORITY_FEE_SOL`, `LAUNCH_MAX_BUY_SOL` | Priority fee and first-buy cap. |

Deploy with `bash deploy.sh` (Vercel).

## Safety

- Back up a fresh wallet's key before you fund it. It lives only in your browser; clearing site data without a backup loses whatever is in it.
- Every transaction PumpPortal builds is checked (who signs it, which program it calls) before your browser signs it.
- Memecoins can go to zero. Nothing here is advice. See the site's [terms, privacy and risks](https://incognito-pad.vercel.app/legal.html).

## License

MIT. See [LICENSE](LICENSE).
