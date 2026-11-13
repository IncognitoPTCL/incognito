# Security

## Model

- **Keys never leave the browser.** Fresh wallets are Ed25519 keypairs made with WebCrypto and stored in the browser's local storage. The server never receives a private key and never signs anything.
- **The server only builds unsigned transactions.** `/api/create`, `/api/trade` and `/api/claim` ask PumpPortal for a transaction for a public address and pass it back unsigned.
- **The browser checks before it signs.** Before signing, `public/app.js` reads the transaction and refuses it unless the expected wallet is the only signer (plus the new mint key for a launch) and it calls pump.fun or PumpSwap.
- **Trades are dry-run first.** The server simulates each trade on mainnet before returning it, so a trade the chain would refuse on price is never handed to a wallet to pay fees on.
- **Launch uploads are signed with a throwaway key.** The image and metadata go to Arweave as data items signed by a one-off key that never holds funds.
- **No secrets in responses.** The RPC URL (which carries its API key) is redacted from every error before it reaches a response or a log.
- **Content Security Policy.** Scripts load only from the site itself; connections are limited to the APIs listed in `vercel.json`.

## What it does not protect

- A fresh wallet hides your main wallet from a coin's chart, trades and holders, not from the blockchain. The transfer that funds it is public, and anyone who follows it can link the two.
- Keys in browser storage are only as safe as the browser and device. Back each one up before you fund it, and do not leave large balances in a fresh wallet.

## Reporting a vulnerability

Please report security issues privately, by direct message to [@IncognitoPTCL](https://x.com/IncognitoPTCL) on X. Do not open a public issue for a vulnerability.
