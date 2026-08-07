// dist/ is committed to the repo so the plugin can be imported straight from a
// source ZIP. That only works if the committed build actually matches src/ —
// otherwise a ZIP download silently ships stale code.
//
// This rebuilds into a temp directory and diffs the result against what's
// committed. Runs first in `npm test`, before anything regenerates dist/.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const committed = path.join(root, 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slidestopdf-dist-'));

const FILES = ['code.js', 'ui.html'];

function fail(lines) {
  console.log('\ndist/ is out of date\n');
  for (const line of lines) console.log('  ' + line);
  console.log('\n  Fix: npm run build, then commit dist/ along with your src/ change.');
  console.log('  (A `npm run watch` build is unminified and will also trip this —');
  console.log('   run `npm run build` before committing.)\n');
  process.exit(1);
}

try {
  if (!fs.existsSync(committed)) {
    fail(['dist/ is missing entirely — it is committed to this repo, not generated on demand.']);
  }

  execFileSync(process.execPath, [path.join(root, 'build.js'), '--outdir', tmp], { stdio: 'pipe' });

  const problems = [];
  for (const name of FILES) {
    const a = path.join(committed, name);
    const b = path.join(tmp, name);

    if (!fs.existsSync(a)) {
      problems.push('dist/' + name + ' is missing');
      continue;
    }

    const have = fs.readFileSync(a);
    const want = fs.readFileSync(b);
    if (!have.equals(want)) {
      problems.push(
        'dist/' + name + ' does not match a fresh build of src/ ' +
        '(committed ' + have.length + ' bytes, rebuilt ' + want.length + ' bytes)'
      );
    }
  }

  // Guard against `$`-substitution corruption during script injection. If
  // build.js injects the bundle with a string replacement instead of a function,
  // a literal `$&` anywhere in the bundled JS is rewritten to the placeholder
  // text. pdf-lib's escapeRegExp contains one, and was silently mangled this way.
  // A byte-diff against a fresh build cannot catch it — both sides corrupt
  // identically — so assert the placeholder is absent from the output.
  const built = fs.readFileSync(path.join(committed, 'ui.html'), 'utf8');
  if (built.indexOf('<!-- INJECT_SCRIPT -->') !== -1) {
    fail(['dist/ui.html contains the INJECT_SCRIPT placeholder — the bundle was corrupted ' +
          'by $-substitution during injection. build.js must pass a function to .replace(), not a string.']);
  }

  if (problems.length > 0) fail(problems);

  console.log('dist/ matches src/');
  console.log('  PASS — no $-substitution corruption in the injected bundle');
  for (const name of FILES) {
    console.log('  PASS — dist/' + name + ' (' + fs.statSync(path.join(committed, name)).size + ' bytes)');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
