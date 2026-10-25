/** Read-only audit of files extracted from app.asar. Never executes game code. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function auditGame(directory) {
  const files = ['package.json', 'main.js', 'preload.js', 'dist/js/bundle.js',
    'dist/js/simulation-worker.js', 'dist/js/external-mod-worker-runtime.js'];
  const text = {};
  const fingerprints = {};
  for (const file of files) {
    const data = await readFile(resolve(directory, file));
    text[file] = data.toString('utf8');
    fingerprints[file] = createHash('sha256').update(data).digest('hex');
  }
  const packageInfo = JSON.parse(text['package.json']);
  const main = text['main.js'];
  const worker = text['dist/js/simulation-worker.js'];
  const guardedLocalMods = /function\s+getLocalModsPath\s*\(\)\s*\{\s*if\s*\(PLATFORM_NAME\s*!==\s*['"]steam['"]\)\s*return\s+null/.test(main);
  const guardedDiscovery = /function\s+discoverNativeWorkshopMods\s*\(\)[\s\S]{0,200}?if\s*\(PLATFORM_NAME\s*!==\s*['"]steam['"]\)/.test(main);
  // These are source signatures, NOT proof that a live API can be invoked safely.
  return {
    schemaVersion: 1,
    gameVersion: packageInfo.version,
    method: 'static-read-only',
    fingerprints,
    signatures: {
      steamOnlyLocalMods: guardedLocalMods,
      steamOnlyDiscovery: guardedDiscovery,
      localModsPreloadBridge: /localMods\s*:/.test(text['preload.js']),
      workerSandkitEntry: /new Function\("__sandkit"/.test(text['dist/js/external-mod-worker-runtime.js']),
      mainSandkitFacade: /apiVersion:1/.test(text['dist/js/bundle.js']),
      elementTeleport: worker.includes('teleportBetweenCells:'),
      elementDataFields: worker.includes('getDataFieldAtCell:'),
      elementVelocity: worker.includes('getVelocityAtCell:'),
      elementDuration: worker.includes('getDurationAtCell:'),
    },
    gamePassModReady: false,
    limitations: [
      'Static source signatures do not verify runtime compatibility.',
      'No game code executed; no files or saves modified.',
      'No verified Game Pass entry point or complete cargo serialization adapter.',
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) {
    console.error('Usage: node tools/audit-game.mjs <extracted-app-directory>');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await auditGame(process.argv[2]), null, 2)); }
    catch (error) { console.error(`Audit failed: ${error.message}`); process.exitCode = 1; }
  }
}
