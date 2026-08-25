import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
const response = await fetch(url);

let unpublished = false;
if (response.status === 404) {
  console.log(`${manifest.name}@${manifest.version}: available`);
  unpublished = true;
} else if (response.ok) {
  console.log(`${manifest.name}@${manifest.version}: already published; skipping`);
} else {
  console.error(`${manifest.name}@${manifest.version}: registry returned HTTP ${response.status}`);
  process.exit(1);
}

if (process.argv.includes('--select-unpublished')) {
  const output = `has_package=${unpublished}`;
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`);
  } else {
    console.log(output);
  }
}
