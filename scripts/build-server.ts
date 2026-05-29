import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts', 'server/retranscode.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist/server',
  external: ['better-sqlite3', 'sharp', 'web-push'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log('Server build complete');
