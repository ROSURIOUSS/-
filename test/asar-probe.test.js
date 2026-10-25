import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAsar, patchArchive, hash, run } from '../tools/asar-probe.mjs';

// Independent minimal ASAR writer for format tests.
function fixture(files) {
  let offset=0; const header={files:{}}; const data=[];
  for (const [path, content] of Object.entries(files)) {
    const bytes=Buffer.from(content); let node=header;
    const parts=path.split('/');
    for (const name of parts.slice(0,-1)) node=(node.files[name]??={files:{}});
    node.files[parts.at(-1)]={size:bytes.length,offset:String(offset)};
    data.push(bytes); offset+=bytes.length;
  }
  const json=Buffer.from(JSON.stringify(header));
  const padded=Math.ceil((4+json.length)/4)*4;
  const preamble=Buffer.alloc(12+padded);
  preamble.writeUInt32LE(4,0); preamble.writeUInt32LE(padded+4,4);
  preamble.writeUInt32LE(padded,8); preamble.writeUInt32LE(json.length,12);
  json.copy(preamble,16);
  return Buffer.concat([preamble,...data]);
}
test('patch preserves every existing packed entry except HTML and updates integrity', () => {
  const bytes=fixture({'package.json':'{"version":"0.6.0"}', 'dist/index.html':'<body>Привет</body>', 'main.js':'untouched', 'image.bin':'\x00\x01xyz'});
  const original=Buffer.from(bytes);
  const patched=patchArchive(bytes,'console.log("panel");',hash(parseAsar(bytes).read('dist/index.html')));
  assert.deepEqual(bytes,original);
  const a=parseAsar(patched);
  assert.match(a.read('dist/index.html').toString(),/data-sandustry-bot-probe/);
  for (const name of ['package.json','main.js','image.bin'])
    assert.deepEqual(a.read(name),parseAsar(bytes).read(name));
  assert.equal(a.entry('dist/index.html').integrity.hash,hash(a.read('dist/index.html')));
  assert.deepEqual(a.entry('dist/index.html').integrity.blocks,[hash(a.read('dist/index.html'))]);
});
test('refuses unknown HTML, double installation, malformed archive and unsafe panel', () => {
  const bytes=fixture({'dist/index.html':'<body></body>'});
  assert.throws(()=>patchArchive(bytes,'test','bad'),/Unknown index/);
  assert.throws(()=>patchArchive(bytes,'</script>'),/Unsupported/);
  const patched=patchArchive(bytes,'test');
  assert.throws(()=>patchArchive(patched,'test'),/already installed/);
  assert.throws(()=>parseAsar(Buffer.alloc(16)),/Not an ASAR/);
  const malformed=Buffer.from(bytes);malformed.writeUInt32LE(0xffffffff,12);
  assert.throws(()=>parseAsar(malformed),/Invalid ASAR/);
});
test('install refuses uninspected build without changing it', async () => {
  const dir=await mkdtemp(join(tmpdir(),'asar-probe-'));
  try {
    const path=join(dir,'app.asar');
    const bytes=fixture({'package.json':'{"version":"0.6.0"}','main.js':'unknown','preload.js':'unknown'});
    await writeFile(path,bytes);
    await assert.rejects(run('install',path,'--game-closed'),/not the inspected/);
    assert.deepEqual(await readFile(path),bytes);
    await assert.rejects(readFile(path+'.bot-probe-original'),{code:'ENOENT'});
    await assert.rejects(readFile(path+'.bot-probe.lock'),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('restore verifies backup and refuses changed archives', async () => {
  const dir=await mkdtemp(join(tmpdir(),'asar-restore-'));
  try {
    const path=join(dir,'app.asar'), original=Buffer.from('original'), patched=Buffer.from('patched');
    await writeFile(path+'.bot-probe-original',original);
    await writeFile(path+'.bot-probe.json',JSON.stringify({version:1,original:hash(original),patched:hash(patched)}));
    await writeFile(path,'updated');
    await assert.rejects(run('restore',path,'--game-closed'),/Archive changed/);
    assert.equal((await readFile(path)).toString(),'updated');
    await writeFile(path,patched);
    await run('restore',path,'--game-closed');
    assert.deepEqual(await readFile(path),original);
    await run('restore',path,'--game-closed');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('requires explicit game-closed acknowledgment', async () => {
  await assert.rejects(run('install','irrelevant'),/Usage/);
});
