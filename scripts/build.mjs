/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds what a page loads Cellar from, into dist/:
 *
 *   cellar.js       one ES module, readable
 *   cellar.min.js   the same, minified
 *   types/          the declarations of src/, from its JSDoc
 *   checksums.json  each file's sha256
 *
 * The sources in src/ are the package's code as they are; dist/ is for a page
 * that loads one file, and what a release carries.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

const BANNER = `/*
 * Cellar ${manifest.version}: shared-memory primitives for multithreaded JavaScript.
 * https://github.com/bottlify/cellar
 * Copyright (c) 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 */`;

await rm(DIST, { recursive: true, force: true });
for (const minify of [false, true])
{
    await build({
        entryPoints: [join(ROOT, 'src', 'index.js')],
        outfile: join(DIST, minify ? 'cellar.min.js' : 'cellar.js'),
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        minify,
        legalComments: 'none',
        banner: { js: BANNER },
    });
}
// The declarations of the package's own files, tests and fixtures left out.
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', join(ROOT, 'jsconfig.types.json')], { stdio: 'inherit' });
// Read as a consumer reads them, their own declarations checked: a name one of
// them uses without importing it would be \`any\` to a consumer that skips them.
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'es2022', '--module', 'nodenext',
    '--lib', 'es2024,dom', join(DIST, 'types', 'index.d.ts')], { stdio: 'inherit' });

/** @param {string} dir @returns {Promise<string[]>} */
const filesUnder = async dir=>(await Promise.all((await readdir(dir, { withFileTypes: true }))
    .map(entry=>(entry.isDirectory() ? filesUnder(join(dir, entry.name))
        : [join(dir, entry.name)])))).flat();
/** @type {Record<string, string>} */
const sums = {};
for (const file of (await filesUnder(DIST)).sort())
{
    sums[relative(DIST, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
}
await writeFile(join(DIST, 'checksums.json'), `${JSON.stringify({ version: manifest.version,
    files: sums }, null, 2)}\n`);
console.log(`cellar ${manifest.version}: ${Object.keys(sums).length} files in dist/`);
