#!/usr/bin/env node
// Сборка автономного исполняемого файла Лории.
//
//   npm run build:exe                 # release/Loria.exe для Windows x64
//   npm run build:exe -- --target linux
//
// У игрока не должно быть установлено ничего: Node, npm и статика уже внутри.
// Как это работает: esbuild собирает лаунчер и сервер в один CommonJS-файл,
// Node SEA превращает его в blob, postject вшивает blob в официальный node.exe,
// resedit ставит иконку и свойства файла.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
// Не dist: папки dist/build не попадают в снимки рабочего пространства.
const DIST = path.join(ROOT, 'release');
const CACHE = path.join(BUILD, 'cache');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const WEBVIEW_PKG = '@webviewjs/webview-win32-x64-msvc';
const WEBVIEW_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@webviewjs', 'webview', 'package.json'), 'utf8')).version;
  } catch {
    return '0.4.9';
  }
})();

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const exact = args.indexOf(`--${name}`);
  if (exact !== -1) {
    const next = args[exact + 1];
    return next && !next.startsWith('--') ? next : true;
  }
  const withValue = args.find((a) => a.startsWith(`--${name}=`));
  return withValue ? withValue.slice(withValue.indexOf('=') + 1) : fallback;
};

const target = String(flag('target', 'win'));
const noIcon = Boolean(flag('no-icon', false));
const builderNode = process.env.SEA_NODE || process.execPath;
const builderVersion = execFileSync(builderNode, ['-v']).toString().trim();

const log = (...parts) => console.log(...parts);

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// ---------- статика ----------

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function buildPublicManifest() {
  const publicDir = path.join(ROOT, 'public');
  const files = {};
  const hash = crypto.createHash('sha256');
  for (const file of walk(publicDir).sort()) {
    const rel = '/' + path.relative(publicDir, file).split(path.sep).join('/');
    const data = fs.readFileSync(file);
    files[rel] = data.toString('base64');
    hash.update(rel);
    hash.update(data);
  }
  const manifest = { build: hash.digest('hex').slice(0, 10), files };
  const out = path.join(BUILD, 'public.json');
  fs.writeFileSync(out, JSON.stringify(manifest));
  log(`  статика: ${Object.keys(files).length} файлов, сборка ${manifest.build}`);
  return { out, manifest };
}

// ---------- бандл ----------

async function bundle() {
  const outfile = path.join(BUILD, 'loria.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'scripts', 'launcher.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    external: ['@webviewjs/webview-*', '*.node'],
    legalComments: 'none',
    logLevel: 'error',
    banner: { js: `// Лория ${APP_VERSION} — автономная сборка` }
  });
  log(`  код: ${human(fs.statSync(outfile).size)}`);
  return outfile;
}

// ---------- blob ----------

function makeBlob(main, publicJson, extraAssets = {}) {
  const config = {
    main,
    output: path.join(BUILD, 'loria.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: { 'public.json': publicJson, ...extraAssets }
  };
  const configFile = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  execFileSync(builderNode, ['--experimental-sea-config', configFile], { stdio: 'inherit' });
  const blob = fs.readFileSync(config.output);
  log(`  blob: ${human(blob.length)} (Node ${builderVersion})`);
  return { blobPath: config.output, size: blob.length };
}

// ---------- node.exe ----------

async function downloadNode(version, platformArch) {
  const name = `node-${version}-${platformArch}`;
  const dest = path.join(CACHE, `${name}.${platformArch.endsWith('win-x64') ? 'exe' : 'bin'}`);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(CACHE, { recursive: true });
  const file = platformArch === 'win-x64' ? 'node.exe' : `node-${version}-linux-x64.tar.xz`;
  const url = `https://nodejs.org/dist/${version}/${platformArch === 'win-x64' ? 'win-x64/node.exe' : file}`;
  log(`  скачиваю ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  log(`  готово: ${human(buf.length)}`);
  return dest;
}

async function resolveNodeBinary(platform) {
  const explicit = flag('node-exe') || flag('node-bin') || process.env.LORIA_NODE_EXE;
  if (explicit) {
    log(`  база: ${explicit}`);
    return path.resolve(explicit);
  }
  if (platform === 'win' && process.platform === 'win32') {
    return process.execPath;
  }
  if (platform === 'linux' && process.platform === 'linux') {
    return process.execPath;
  }
  if (platform === 'linux') {
    throw new Error('Linux-сборку делай на Linux или укажи --node-bin путь/к/node');
  }
  return downloadNode(builderVersion, 'win-x64');
}

// ---------- иконка и свойства файла ----------

async function decorateWindows(file) {
  if (noIcon) return file;
  let ResEdit;
  try {
    ResEdit = await import('resedit');
  } catch {
    log('  resedit не установлен — собираю без иконки');
    return file;
  }
  const ico = path.join(ROOT, 'scripts', 'assets', 'loria.ico');
  if (!fs.existsSync(ico)) return file;

  const PELibrary = await import('pe-library');
  const exe = PELibrary.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(exe);

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0]?.id ?? 1;
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    1033,
    iconFile.icons.map((item) => item.data)
  );

  const [major, minor, patch] = APP_VERSION.split('.').map(Number);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = versions[0] || ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues(
    { lang: 1033, codepage: 1200 },
    {
      FileDescription: 'Лория — текстовая RPG с ИИ-мастером',
      ProductName: 'Лория',
      OriginalFilename: 'Loria.exe',
      InternalName: 'Loria',
      CompanyName: 'Loria',
      LegalCopyright: 'MIT'
    }
  );
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
  log('  иконка и свойства файла установлены');
  return file;
}

// ---------- сборка ----------

function inject(baseFile, blobPath, outFile) {
  const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!fs.existsSync(postject)) throw new Error('Нет postject: выполни npm install');
  fs.copyFileSync(baseFile, outFile);
  execFileSync(
    builderNode,
    [postject, outFile, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE, '--overwrite'],
    { stdio: 'inherit' }
  );
  const data = fs.readFileSync(outFile);
  const blobSize = fs.statSync(blobPath).size;
  if (!data.includes(Buffer.from('public.json')) || data.length < blobSize) {
    throw new Error('Blob не попал в файл — инъекция не удалась');
  }
  log(`  файл: ${outFile} (${human(data.length)})`);
  return outFile;
}

// Нативное окно для Windows: готовый .node-модуль из npm-пакета платформы.
function untarFile(tgz, matcher) {
  const tar = zlib.gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('ascii', off + 124, off + 136).trim() || '0', 8);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (matcher(name)) return body;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function ensureWinAddon() {
  const cached = path.join(CACHE, 'webview.win32-x64-msvc.node');
  if (fs.existsSync(cached)) return cached;
  const local = path.join(ROOT, 'node_modules', '@webviewjs', 'webview-win32-x64-msvc', 'webview.win32-x64-msvc.node');
  if (fs.existsSync(local)) return local;

  fs.mkdirSync(CACHE, { recursive: true });
  const metaUrl = `https://registry.npmjs.org/${WEBVIEW_PKG.replace('/', '%2F')}/${WEBVIEW_VERSION}`;
  log(`  скачиваю нативное окно ${WEBVIEW_PKG}@${WEBVIEW_VERSION}`);
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`Не удалось получить ${metaUrl}: HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const tarRes = await fetch(meta.dist.tarball);
  if (!tarRes.ok) throw new Error(`Не удалось скачать ${meta.dist.tarball}: HTTP ${tarRes.status}`);
  const body = untarFile(Buffer.from(await tarRes.arrayBuffer()), (name) => name.endsWith('.node'));
  if (!body) throw new Error('В пакете нативного окна нет файла .node');
  fs.writeFileSync(cached, body);
  log(`  окно: ${human(body.length)}`);
  return cached;
}

async function buildOne(platform, outPath) {
  log(`\nСборка для ${platform === 'win' ? 'Windows x64' : 'Linux x64'}:`);
  const { out: publicJson } = buildPublicManifest();
  const main = await bundle();
  const extra = {};
  if (platform === 'win') {
    extra['webview.node'] = await ensureWinAddon();
    // Рантайм MSVC рядом с нативным модулем: не зависим от установленного VC++ Redistributable.
    for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll']) {
      const file = path.join(ROOT, 'scripts', 'assets', 'win', dll);
      if (fs.existsSync(file)) extra[dll] = file;
    }
  }
  const blob = makeBlob(main, publicJson, extra);
  const base = await resolveNodeBinary(platform);
  let prepared = base;
  if (platform === 'win') prepared = await decorateWindows(base);
  const out = path.resolve(outPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  inject(prepared, blob.blobPath, out);
  if (platform !== 'win') fs.chmodSync(out, 0o755);
  return out;
}

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });
  log(`Лория ${APP_VERSION}: сборка (Node ${builderVersion})`);

  const jobs = [];
  if (target === 'both') {
    jobs.push(['win', path.join(DIST, 'Loria.exe')]);
    jobs.push(['linux', path.join(DIST, 'loria-linux')]);
  } else if (target === 'win' || target === 'linux') {
    const custom = flag('out');
    jobs.push([target, custom || path.join(DIST, target === 'win' ? 'Loria.exe' : 'loria-linux')]);
  } else {
    throw new Error(`Неизвестная цель: ${target}. Доступно: win, linux, both`);
  }

  for (const [platform, out] of jobs) {
    await buildOne(platform, out);
  }
  log('\nГотово.');
}

main().catch((err) => {
  console.error('\nСборка не удалась:', err?.message || err);
  process.exit(1);
});
