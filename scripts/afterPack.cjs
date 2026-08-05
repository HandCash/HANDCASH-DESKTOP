'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Without a Developer ID the bundle keeps only the linker's default signature
// (Identifier=Electron, no sealed resources), which Gatekeeper rejects as
// "damaged" on Apple Silicon even after the quarantine flag is cleared.
// Re-signing ad hoc produces a valid signature that launches unnotarized.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  const run = (cmd, args) =>
    execFileSync(cmd, args, { stdio: 'inherit', maxBuffer: 1024 * 1024 * 32 });

  run('xattr', ['-cr', appPath]);
  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  run('codesign', ['--verify', '--deep', '--strict', appPath]);

  console.log(`  • ad-hoc signed ${appPath}`);
};
