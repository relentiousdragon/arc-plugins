import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = process.argv[2];
if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(pluginId || '')) throw new Error('Usage: node scripts/publish-wasm-adapter.mjs <plugin-id>');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Could not read the plugin repository commit.');

const adapterDirectory = pluginId.startsWith('arc.') ? pluginId.slice(4) : pluginId;
const manifestRelative = `adapters/${adapterDirectory}/arc-plugin.json`;
const wasmRelative = `adapters/${adapterDirectory}/adapter.wasm`;
const manifestBytes = fs.readFileSync(path.join(repoRoot, manifestRelative));
const wasmBytes = fs.readFileSync(path.join(repoRoot, wasmRelative));
const committedFile = (relativePath) => {
  const committedHash = execFileSync('git', ['rev-parse', `HEAD:${relativePath}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const workingHash = execFileSync('git', ['hash-object', '--path', relativePath, path.join(repoRoot, relativePath)], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!committedHash || committedHash !== workingHash) throw new Error(`Commit ${relativePath} before publishing the adapter.`);
};
committedFile(manifestRelative);
committedFile(wasmRelative);

const manifest = JSON.parse(manifestBytes.toString('utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const wasmSha256 = sha256(wasmBytes);
if (manifest.kind !== 'wasm-adapter' || manifest.id !== pluginId || manifest.wasmArtifact !== 'adapter.wasm' || manifest.wasmSha256?.toLowerCase() !== wasmSha256) {
  throw new Error('The manifest must identify this WebAssembly adapter and contain the matching adapter.wasm digest.');
}
if (!Array.isArray(manifest.nodes) || !manifest.nodes.length || !manifest.minArcStudioVersion || !manifest.version) throw new Error('The adapter manifest is missing its nodes, version, or ARC Studio compatibility floor.');
if ((manifest.permissions?.length || 0) || (manifest.capabilities?.length || 0)) throw new Error('WebAssembly adapters cannot declare host permissions or capabilities.');

const registryPath = path.join(repoRoot, 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) throw new Error('registry.json must use schema version 1.');
const entry = {
  kind: 'wasm-adapter',
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description || '',
  author: manifest.author || '',
  license: manifest.license || '',
  tags: manifest.tags || [],
  arcApiVersion: 1,
  minArcStudioVersion: manifest.minArcStudioVersion,
  commit,
  path: manifestRelative,
  sha256: sha256(manifestBytes),
  wasmSha256,
  nodeTypes: manifest.nodes.map((node) => node.type),
  settingsSchema: manifest.settingsSchema || [],
  thirdPartyNotices: manifest.thirdPartyNotices || []
};
registry.plugins = [...registry.plugins.filter((plugin) => plugin.id !== pluginId), entry].sort((left, right) => left.name.localeCompare(right.name));
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Published ${pluginId} ${manifest.version} in registry.json, pinned to ${commit}. Commit and push the registry update.`);
