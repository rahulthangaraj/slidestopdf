#!/usr/bin/env node
// Checks whether THIS folder is in a state Figma can actually load.
// Run it inside the folder you're importing the manifest from:
//
//   node doctor.js
//
// Needs nothing installed — no npm install required.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
let failed = 0;

function ok(msg)   { console.log('  \x1b[32mOK\x1b[0m    ' + msg); }
function bad(msg, fix) {
  failed++;
  console.log('  \x1b[31mFAIL\x1b[0m  ' + msg);
  if (fix) console.log('        → ' + fix);
}

console.log('\nSlides to PDF — setup check');
console.log('Folder: ' + root + '\n');

// 1. manifest
const manifestPath = path.join(root, 'manifest.json');
let manifest = null;
if (!fs.existsSync(manifestPath)) {
  bad('manifest.json is missing', 'You are not in the plugin folder. cd into the extracted folder and rerun.');
} else {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    ok('manifest.json parses  (name: "' + manifest.name + '", editorType: ' + JSON.stringify(manifest.editorType) + ')');
  } catch (e) {
    bad('manifest.json is not valid JSON: ' + e.message, 'Re-extract the ZIP — the file is corrupt.');
  }
}

// 2. the two files the manifest points at — this is the usual failure
if (manifest) {
  for (const key of ['main', 'ui']) {
    const rel = manifest[key];
    if (!rel) { bad('manifest has no "' + key + '" field'); continue; }

    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      bad('manifest.' + key + ' → ' + rel + '  DOES NOT EXIST',
          'This is the ENOENT Figma reports. This copy has no build in it. ' +
          'Either download a ZIP of a branch where dist/ is committed, or run: npm install && npm run build');
      continue;
    }
    const size = fs.statSync(abs).size;
    if (size === 0) {
      bad('manifest.' + key + ' → ' + rel + ' is empty (0 bytes)', 'Rebuild: npm run build');
    } else {
      ok('manifest.' + key + ' → ' + rel + '  (' + size.toLocaleString() + ' bytes)');
    }
  }
}

// 3. the sandbox bundle must parse, and must not use syntax the Figma sandbox rejects
const codePath = manifest && manifest.main ? path.join(root, manifest.main) : null;
if (codePath && fs.existsSync(codePath) && fs.statSync(codePath).size > 0) {
  const src = fs.readFileSync(codePath, 'utf8');
  try {
    new vm.Script(src, { filename: 'code.js' });
    ok('sandbox bundle parses as valid JavaScript');
  } catch (e) {
    bad('sandbox bundle has a syntax error: ' + e.message, 'Rebuild: npm run build');
  }

  const banned = [
    ['nullish coalescing (??)', /\?\?/],
    ['optional chaining (?.)', /\?\.[a-zA-Z_$[(]/],
  ];
  const hits = banned.filter(([, re]) => re.test(src)).map(([n]) => n);
  if (hits.length > 0) {
    bad('uses syntax the Figma sandbox rejects: ' + hits.join(', '), 'build.js must target es2017.');
  } else {
    ok('no ES2020+ syntax (sandbox-safe)');
  }
}

// 4. the UI must be self-contained — networkAccess is "none"
const uiPath = manifest && manifest.ui ? path.join(root, manifest.ui) : null;
if (uiPath && fs.existsSync(uiPath) && fs.statSync(uiPath).size > 0) {
  const html = fs.readFileSync(uiPath, 'utf8');
  if (html.indexOf('<!-- INJECT_SCRIPT -->') !== -1) {
    bad('ui.html still has the INJECT_SCRIPT placeholder — the bundle was never injected', 'Rebuild: npm run build');
  } else if (!/<script>/.test(html)) {
    bad('ui.html contains no inline script', 'Rebuild: npm run build');
  } else {
    ok('ui.html has its bundle inlined');
  }

  const external = html.match(/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\/[^"']+/gi);
  if (external) {
    bad('ui.html references external URLs, but networkAccess is "none": ' + external[0].slice(0, 60));
  } else {
    ok('ui.html has no external requests');
  }
}

// 5. verdict
console.log('');
if (failed === 0) {
  console.log('\x1b[32mThis folder is loadable.\x1b[0m Import this exact path in Figma:');
  console.log('  ' + manifestPath + '\n');
  console.log('If Figma still errors, the plugin entry it is using points somewhere else.');
  console.log('Remove every "Slides to PDF" entry under Plugins → Development, then re-import\n' +
              'from the path above.\n');
} else {
  console.log('\x1b[31m' + failed + ' problem(s) found.\x1b[0m See the → lines above.\n');
  process.exitCode = 1;
}
