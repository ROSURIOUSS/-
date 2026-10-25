import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditGame} from '../tools/audit-game.mjs';

test('read-only audit recognizes platform guards without executing source', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bot-audit-'));
  try {
    await mkdir(join(dir,'dist/js'),{recursive:true});
    const files={
      'package.json':'{"version":"0.6.0"}',
      'main.js':`function getLocalModsPath() { if (PLATFORM_NAME !== 'steam') return null; }
        function discoverNativeWorkshopMods() { const emptyData = {}; if (PLATFORM_NAME !== 'steam') return emptyData; }
        throw new Error('must not execute');`,
      'preload.js':'localMods: {}',
      'dist/js/bundle.js':'apiVersion:1',
      'dist/js/simulation-worker.js':'teleportBetweenCells: getDataFieldAtCell: getVelocityAtCell: getDurationAtCell:',
      'dist/js/external-mod-worker-runtime.js':'new Function("__sandkit", source)',
    };
    for (const [path,text] of Object.entries(files)) await writeFile(join(dir,path),text);
    const report=await auditGame(dir);
    assert.equal(report.gameVersion,'0.6.0');
    assert.equal(report.gamePassModReady,false);
    assert.ok(Object.values(report.signatures).every(Boolean));
    assert.equal(report.fingerprints['main.js'].length,64);
    await writeFile(join(dir,'main.js'),'/* different release */');
    const other=await auditGame(dir);
    assert.equal(other.signatures.steamOnlyLocalMods,false);
    assert.notEqual(other.fingerprints['main.js'],report.fingerprints['main.js']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
