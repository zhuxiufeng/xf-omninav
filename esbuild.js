const esbuild = require('esbuild');
const path = require('path');

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const isProduction = args.includes('--production');

async function main() {
  const commonOptions = {
    bundle: true,
    format: 'cjs',
    minify: isProduction,
    sourcemap: !isProduction,
    sourcesContent: false,
    platform: 'node',
    logLevel: 'info',
  };

  const extensionCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: {
      extension: 'src/extension.ts',
    },
    outdir: 'dist',
    external: ['vscode'],
  });

  const workerCtx = await esbuild.context({
    ...commonOptions,
    entryPoints: {
      parseWorker: 'src/indexer/parseWorker.ts',
    },
    outdir: 'dist',
    alias: {
      vscode: path.resolve(__dirname, 'src/indexer/workerVscodeShim.ts'),
    },
  });

  if (isWatch) {
    console.log('[esbuild] Watching for changes...');
    await Promise.all([extensionCtx.watch(), workerCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), workerCtx.dispose()]);
    console.log('[esbuild] Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
