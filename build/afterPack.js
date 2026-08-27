// VLC ships as an already-signed bundle whose plugin cache is keyed on file
// timestamps. electron-builder's copier rewrites those, which makes VLC rescan
// every plugin on each launch and invalidates VideoLAN's signature, so VLC is
// copied here with ditto instead, which keeps metadata intact.

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const project = context.packager.projectDir;
  const source = path.join(project, 'vendor', 'VLC.app');
  const target = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents', 'Resources', 'vendor', 'VLC.app'
  );

  execFileSync('/bin/rm', ['-rf', target]);
  execFileSync('/usr/bin/ditto', [source, target]);
  console.log(`  • copied VLC bundle  to=${path.relative(project, target)}`);
};
