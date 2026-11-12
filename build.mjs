// Bundles lib/app.mjs (and @vercel/blob) into api/index.mjs, the one Vercel function.
import { build } from 'esbuild';

await build({
  entryPoints: ['lib/app.mjs'],
  outfile: 'api/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('built api/index.mjs');
