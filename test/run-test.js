const esbuild = require('esbuild');
const path = require('path');
const { spawnSync } = require('child_process');

async function run() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'all.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(__dirname, '../dist/test-bundle.js'),
    alias: {
      vscode: path.join(__dirname, 'vscode-mock.ts'),
    },
    logLevel: 'info',
  });

  const res = spawnSync(process.execPath, ['--test', path.join(__dirname, '../dist/test-bundle.js')], {
    stdio: 'inherit',
  });

  if (res.status !== 0) {
    process.exit(res.status || 1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
