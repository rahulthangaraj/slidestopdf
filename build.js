const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Load .env so POSTHOG_* vars are available for esbuild define
if (fs.existsSync('.env')) {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) process.env[key] = val;
    }
  });
}

const isWatch = process.argv.includes('--watch');

if (!fs.existsSync('dist')) {
  fs.mkdirSync('dist');
}

// Plugin that injects bundled UI JS into ui.html
const uiHtmlPlugin = {
  name: 'ui-html',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length > 0) return;
      const outputFile = result.outputFiles && result.outputFiles[0];
      if (!outputFile) return;

      const uiJS = outputFile.text;
      let html = fs.readFileSync('src/ui.html', 'utf8');
      html = html.replace('<!-- INJECT_SCRIPT -->', `<script>${uiJS}</script>`);
      fs.writeFileSync('dist/ui.html', html);
      console.log('[ui] dist/ui.html built');
    });
  },
};

async function main() {
  const uiCtx = await esbuild.context({
    entryPoints: ['src/ui.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['chrome91'],
    minify: !isWatch,
    plugins: [uiHtmlPlugin],
    define: {
      'process.env.POSTHOG_API_KEY': JSON.stringify(process.env.POSTHOG_API_KEY || ''),
      'process.env.POSTHOG_HOST': JSON.stringify(process.env.POSTHOG_HOST || ''),
    },
  });

  const codeCtx = await esbuild.context({
    entryPoints: ['src/code.ts'],
    bundle: true,
    outfile: 'dist/code.js',
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
