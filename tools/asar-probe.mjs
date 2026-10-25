/** Experimental reversible HTML-only probe. No game code or auth logic is executed/changed. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, writeFile, copyFile, rename, unlink, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseAsar(bytes) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error('Not an ASAR archive');
  const headerSize = bytes.readUInt32LE(4), length = bytes.readUInt32LE(12);
  const start = 8 + headerSize;
  if (length > 32 * 1024 * 1024 || length + 16 > start || start > bytes.length)
    throw new Error('Invalid ASAR header');
  const header = JSON.parse(bytes.subarray(16, 16 + length).toString('utf8'));
  function entry(path) {
    let item = header;
    for (const name of path.split('/')) {
      if (!item.files || !Object.hasOwn(item.files, name)) throw new Error(`Missing ${path}`);
      item = item.files[name];
    }
    return item;
  }
  function read(path) {
    const item = entry(path), offset = Number(item.offset);
    if (item.unpacked || item.link || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(item.size) || item.size < 0 || start + offset + item.size > bytes.length)
      throw new Error(`Unsupported entry ${path}`);
    return bytes.subarray(start + offset, start + offset + item.size);
  }
  return { header, start, entry, read };
}
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = (4 + json.length + 3) & ~3;
  const buf = Buffer.alloc(8 + 4 + payloadSize);
  buf.writeUInt32LE(4, 0); buf.writeUInt32LE(4 + payloadSize, 4);
  buf.writeUInt32LE(payloadSize, 8); buf.writeUInt32LE(json.length, 12);
  json.copy(buf, 16);
  return buf;
}
export function patchArchive(bytes, panel, expectedHtmlHash) {
  const archive = parseAsar(bytes);
  const original = archive.read('dist/index.html');
  if (expectedHtmlHash && hash(original) !== expectedHtmlHash) throw new Error('Unknown index.html; refusing to patch');
  const html = original.toString('utf8');
  if (html.includes('sandustry-bot-probe')) throw new Error('Probe already installed');
  if (!html.includes('</body>') || /<\/script/i.test(panel)) throw new Error('Unsupported HTML or panel script');
  const patched = Buffer.from(html.replace('</body>', `<script data-sandustry-bot-probe="1">\n${panel}\n</script>\n</body>`));
  const item = archive.entry('dist/index.html');
  // Append changed HTML; retain every original packed byte and every other entry offset.
  item.offset = String(bytes.length - archive.start);
  item.size = patched.length;
  const blockSize = item.integrity?.blockSize ?? 4194304;
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error('Invalid integrity block size');
  const blocks = [];
  for (let i = 0; i < patched.length; i += blockSize) blocks.push(hash(patched.subarray(i, i + blockSize)));
  item.integrity = { algorithm: 'SHA256', hash: hash(patched), blockSize, blocks };
  return Buffer.concat([encodeHeader(archive.header), bytes.subarray(archive.start), patched]);
}
const here = dirname(fileURLToPath(import.meta.url));
export async function run(mode, archivePath, confirm) {
  if (!['install', 'restore'].includes(mode) || confirm !== '--game-closed')
    throw new Error('Usage: node tools/asar-probe.mjs install|restore <app.asar> --game-closed');
  const path = resolve(archivePath), backup = path + '.bot-probe-original', receipt = path + '.bot-probe.json';
  const lockPath = path + '.bot-probe.lock';
  const lock = await open(lockPath, 'wx');
  const temp = path + '.bot-probe.tmp';
  let tempCreated = false;
  async function stage(bytes) {
    const handle = await open(temp, 'wx');
    tempCreated = true;
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }
  try {
    const current = await readFile(path);
    if (mode === 'install') {
      const archive = parseAsar(current);
      const pkg = JSON.parse(archive.read('package.json'));
      const fingerprint = JSON.parse(await readFile(join(here, '../diagnostic/fingerprint.json'), 'utf8'));
      if (pkg.version !== '0.6.0' || hash(archive.read('main.js')) !== fingerprint.main ||
          hash(archive.read('preload.js')) !== fingerprint.preload)
        throw new Error('This build is not the inspected 0.6.0. No changes made.');
      const panel = await readFile(join(here, '../diagnostic/panel.js'), 'utf8');
      const patched = patchArchive(current, panel, fingerprint.html);
      // Exclusive backup: never overwrite an earlier original, even after an interrupted install.
      await copyFile(path, backup, constants.COPYFILE_EXCL);
      if (hash(await readFile(backup)) !== hash(current)) throw new Error('Backup verification failed');
      await writeFile(receipt, JSON.stringify({version:1, original:hash(current), patched:hash(patched)}, null, 2), {flag:'wx'});
      await stage(patched);
      if (hash(await readFile(path)) !== hash(current)) throw new Error('Game archive changed during installation');
      await rename(temp, path);
      console.log('Test panel installed. Launch normally through Xbox. If launch fails, close the game and restore.');
    } else {
      const saved = await readFile(backup);
      const info = JSON.parse(await readFile(receipt, 'utf8'));
      if (info.version !== 1 || hash(saved) !== info.original) throw new Error('Backup verification failed');
      if (![info.original, info.patched].includes(hash(current))) throw new Error('Archive changed (possibly updated). Refusing to overwrite it.');
      if (hash(current) === info.original) { console.log('Already restored.'); return; }
      await stage(saved);
      if (hash(await readFile(path)) !== hash(current)) throw new Error('Game archive changed during restore');
      await rename(temp, path);
      console.log('Original archive restored. Backup retained.');
    }
  } finally {
    if (tempCreated) await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
