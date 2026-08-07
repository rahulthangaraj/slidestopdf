// Regenerates src/icons.ts from the canonical lucide icon set.
//
//   npm install --no-save lucide-static && npm run icons
//
// lucide-static is not a project dependency: the icons are committed as
// source because networkAccess is "none" and nothing can be fetched at
// runtime. Rerun this only when the icon set changes.
const fs = require('fs'), path = require('path');
const NAMES = ['mouse-pointer-click', 'refresh-ccw', 'x', 'grip-vertical', 'frame', 'check', 'minus', 'arrow-left'];
const dir = 'node_modules/lucide-static/icons';
const out = [];
out.push('// Lucide icons (ISC), inlined verbatim from the lucide-static package.');
out.push('// They must be inlined rather than fetched: the plugin declares');
out.push('// networkAccess "none", so no remote asset can load at runtime.');
out.push('//');
out.push('// Generated — do not hand-edit. Inner path data only; the wrapper <svg>');
out.push('// is built by icon() so size and colour come from CSS.');
out.push('');
out.push('const PATHS: { [name: string]: string } = {');
for (const n of NAMES) {
  const svg = fs.readFileSync(path.join(dir, n + '.svg'), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s+/g, ' ').trim();
  out.push("  '" + n + "': '" + inner.replace(/'/g, "\\'") + "',");
}
out.push('};');
out.push('');
out.push('export type IconName = keyof typeof PATHS;');
out.push('');
out.push('export function icon(name: string, size: number): string {');
out.push('  return \'<svg class="icon" width="\' + size + \'" height="\' + size + \'" viewBox="0 0 24 24" \' +');
out.push('    \'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" \' +');
out.push('    \'stroke-linejoin="round" aria-hidden="true">\' + PATHS[name] + \'</svg>\';');
out.push('}');
out.push('');
fs.writeFileSync('src/icons.ts', out.join('\n'));
console.log('wrote src/icons.ts');
