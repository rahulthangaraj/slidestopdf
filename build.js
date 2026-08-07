const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const isWatch = process.argv.includes('--watch');

// dist/ is committed so the plugin can be imported straight from a source ZIP
// without a build step. --outdir lets the staleness check build somewhere else
// and diff the result against what's committed.
const outDirArg = process.argv.indexOf('--outdir');
const outDir = outDirArg !== -1 && process.argv[outDirArg + 1]
  ? path.resolve(process.argv[outDirArg + 1])
  : path.join(root, 'dist');

fs.mkdirSync(outDir, { recursive: true });

// Plugin that injects bundled UI JS into ui.html
const uiHtmlPlugin = {
  name: 'ui-html',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return;
      const outputFile = result.outputFiles && result.outputFiles[0];
      if (!outputFile) return;

      const uiJS = outputFile.text;
      let html = fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8');
      html = html.replace('<!-- INJECT_SCRIPT -->', `<script>${uiJS}</script>`);
      fs.writeFileSync(path.join(outDir, 'ui.html'), html);
      console.log('[ui] ' + path.relative(root, path.join(outDir, 'ui.html')) + ' built');
    });
  },
};

async function main() {
  const uiCtx = await esbuild.context({
    entryPoints: [path.join(root, 'src/ui.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['chrome91'],
    minify: !isWatch,
    plugins: [uiHtmlPlugin],
  });

  const codeCtx = await esbuild.context({
    entryPoints: [path.join(root, 'src/code.ts')],
    bundle: true,
    outfile: path.join(outDir, 'code.js'),
    format: 'iife',
    target: ['es2017'],  // Figma sandbox doesn't support ES2020+ (no ??, ?.)
    minify: !isWatch,
  });

  if (isWatch) {
    await uiCtx.watch();
    await codeCtx.watch();
    console.log('Watching for changes in src/...');
  } else {
    await uiCtx.rebuild();
    await codeCtx.rebuild();
    await uiCtx.dispose();
    await codeCtx.dispose();
    console.log('Build complete!');
  }
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
