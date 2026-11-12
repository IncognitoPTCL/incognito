// Local server: `node server.mjs` (PORT, default 4981). Production runs the
// same handler as a Vercel function (api/index.mjs, built by build.mjs).
import { num } from './lib/env.mjs';
import { createServer } from 'node:http';
import handle from './lib/app.mjs';

const PORT = num('PORT', 4981);
const HOST = process.env.HOST || '127.0.0.1';

createServer(handle).listen(PORT, HOST, () => {
  const blob = process.env.PINATA_JWT ? 'metadata: pump.fun IPFS, then Pinata' : process.env.BLOB_READ_WRITE_TOKEN ? 'metadata: pump.fun IPFS, then Blob' : 'metadata: pump.fun IPFS only (blocked from the UK)';
  console.log(`Incognito on http://localhost:${PORT}  ${blob}${process.env.PAD_PASSWORD ? '  password on' : ''}`);
});
