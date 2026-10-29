// Optional developer check, NOT an app or a web build. Run with NODE_PATH pointing
// at an installation of @gdscript-analyzer/core (see README / CI).
const { AnalysisHandle } = require('@gdscript-analyzer/core');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../godot');
const analyzer = new AnalysisHandle();
analyzer.setProjectConfig(fs.readFileSync(path.join(root, 'project.godot'), 'utf8'));
function scripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('.') ? [] : scripts(full);
    return entry.name.endsWith('.gd') ? [full] : [];
  });
}
const files = scripts(root);
for (const file of files) {
  analyzer.openDocument('file://' + file, fs.readFileSync(file, 'utf8'),
    'res://' + path.relative(root, file).split(path.sep).join('/'));
}
let errors = 0;
for (const file of files) {
  const source = fs.readFileSync(file);
  for (const diagnostic of analyzer.diagnostics('file://' + file)) {
    if (diagnostic.severity !== 'error') continue;
    const line = source.subarray(0, diagnostic.range.start).toString().split('\n').length;
    console.error(`${path.relative(root, file)}:${line} ${diagnostic.code}: ${diagnostic.message}`);
    errors++;
  }
}
console.log(`${files.length} GDScript files checked; ${errors} static errors.`);
process.exitCode = errors ? 1 : 0;
