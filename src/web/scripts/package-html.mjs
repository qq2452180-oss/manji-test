import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = join(root, 'dist-html');
const release = fileURLToPath(new URL('../../outputs/html-2026-11-04/', import.meta.url));
const archive = 'manji-html-2026-11-04.tar.gz';
if (!existsSync(join(build, 'index.html'))) throw new Error('先执行 npm run build:html');
if (existsSync(release)) throw new Error(`发布目录已存在，避免覆盖：${release}`);
mkdirSync(release, { recursive: true });
cpSync(build, join(release, 'html'), { recursive: true });
let total = 0, count = 0;
function verify(path) {
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) verify(join(path, name));
  } else {
    if (!/\.(html|js|css|webp)$/.test(path)) throw new Error(`不应上传的文件：${path}`);
    chmodSync(path, 0o644);
    total += statSync(path).size; count++;
    if (path.endsWith('.html')) {
      const html = readFileSync(path, 'utf8');
      if (!html.includes('/html/assets/') || html.includes('/web2/')) throw new Error(`入口路径错误：${path}`);
    }
  }
}
verify(join(release, 'html'));
// COPYFILE_DISABLE suppresses AppleDouble files but not libarchive PAX xattrs.
// Strip macOS metadata so GNU tar extracts only the portable website files.
const portableTarOptions = process.platform === 'darwin'
  ? ['--no-xattrs', '--no-acls', '--no-mac-metadata'] : [];
execFileSync('tar', ['-czf', join(release, archive), ...portableTarOptions, '-C', release, 'html'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const digest = createHash('sha256').update(readFileSync(join(release, archive))).digest('hex');
writeFileSync(join(release, archive.replace('.tar.gz', '.sha256')), `${digest}  ${archive}\n`);
for (const name of ['部署步骤.txt', 'nginx-html.location.conf']) {
  cpSync(join(root, 'deployment/html', name), join(release, name));
}
console.log(JSON.stringify({ release, archive, files: count, unpackedBytes: total, archiveBytes: statSync(join(release, archive)).size, sha256: digest }, null, 2));
