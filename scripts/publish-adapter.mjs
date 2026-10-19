import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginId = process.argv[2];
if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(pluginId || '')) throw new Error('Usage: node scripts/publish-adapter.mjs <plugin-id>');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Could not read the plugin repository commit.');
const adapterDirectory = pluginId.startsWith('arc.') ? pluginId.slice(4) : pluginId;
const manifestRelative = `adapters/${adapterDirectory}/arc-plugin.json`;
const manifestPath = path.join(repoRoot, manifestRelative);
const manifestBytes = fs.readFileSync(manifestPath);
const committedManifest = execFileSync('git', ['show', `HEAD:${manifestRelative}`], { cwd: repoRoot, encoding: 'buffer' });
if (!committedManifest.equals(manifestBytes)) throw new Error('Commit the adapter manifest and runtime before publishing its catalog entry.');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.kind !== 'host-adapter' || manifest.id !== pluginId || !manifest.runtime?.module || !manifest.runtime?.sha256) throw new Error('The adapter manifest is missing its host runtime metadata.');
const runtimeRelative = `adapters/${adapterDirectory}/${manifest.runtime.module}`;
const runtimeBytes = fs.readFileSync(path.join(repoRoot, runtimeRelative));
const committedRuntime = execFileSync('git', ['show', `HEAD:${runtimeRelative}`], { cwd: repoRoot, encoding: 'buffer' });
if (!committedRuntime.equals(runtimeBytes)) throw new Error('Commit the adapter runtime before publishing its catalog entry.');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimeSha256 = digest(runtimeBytes);
if (runtimeSha256 !== manifest.runtime.sha256.toLowerCase()) throw new Error('Update runtime.sha256 in arc-plugin.json to match the committed runtime.');
const registryPath = path.join(repoRoot, 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) throw new Error('registry.json must use schema version 1.');
const entry = {
  kind: 'host-adapter',
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
  sha256: digest(manifestBytes),
  runtimeSha256,
  nodeTypes: manifest.nodes.map((node) => node.type),
  permissions: manifest.permissions,
  settingsSchema: manifest.settingsSchema || [],
  thirdPartyNotices: manifest.thirdPartyNotices || []
};
registry.plugins = [...registry.plugins.filter((plugin) => plugin.id !== pluginId), entry].sort((left, right) => left.name.localeCompare(right.name));
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Published ${pluginId} ${manifest.version} in registry.json, pinned to ${commit}. Commit and push the registry update.`);
