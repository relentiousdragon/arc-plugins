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
const adapterPath = `adapters/${adapterDirectory}`;
const manifestRelative = `${adapterPath}/arc-plugin.json`;
const manifestBytes = fs.readFileSync(path.join(repoRoot, manifestRelative));
const committedFile = (relativePath, workingBytes) => {
  const committed = execFileSync('git', ['show', `HEAD:${relativePath}`], { cwd: repoRoot, encoding: 'buffer' });
  if (!committed.equals(workingBytes)) throw new Error(`Commit ${relativePath} before publishing the adapter.`);
};
committedFile(manifestRelative, manifestBytes);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.kind !== 'host-adapter' || manifest.id !== pluginId || !manifest.runtime?.module || !manifest.runtime?.sha256) throw new Error('The adapter manifest is missing its host runtime metadata.');
const runtimeRelative = `${adapterPath}/${manifest.runtime.module}`;
const runtimeBytes = fs.readFileSync(path.join(repoRoot, runtimeRelative));
committedFile(runtimeRelative, runtimeBytes);
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimeSha256 = digest(runtimeBytes);
if (runtimeSha256 !== manifest.runtime.sha256.toLowerCase()) throw new Error('Update runtime.sha256 in arc-plugin.json to match the committed runtime.');

const runtimeDependencies = manifest.runtimeDependencies;
if (!Array.isArray(runtimeDependencies) || runtimeDependencies.length > 16 || runtimeDependencies.some((name) => typeof name !== 'string' || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) || new Set(runtimeDependencies).size !== runtimeDependencies.length) {
  throw new Error('runtimeDependencies must list at most 16 unique package names supplied by ARC Studio.');
}
const npmDependencies = manifest.npmDependencies || [];
if (!Array.isArray(npmDependencies) || npmDependencies.length > 16) throw new Error('npmDependencies must be a list of at most 16 exact npm packages.');
const seen = new Set();
for (const item of npmDependencies) {
  if (!item || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(item.name || '') || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(item.version || '') || seen.has(item.name) || runtimeDependencies.includes(item.name)) {
    throw new Error('npmDependencies must use unique package names and exact versions, separate from ARC-provided dependencies.');
  }
  seen.add(item.name);
}
const sortedNpmDependencies = npmDependencies.map(({ name, version }) => ({ name, version })).sort((a, b) => a.name.localeCompare(b.name));
let dependencyLockSha256 = '';
let dependencyPackageCount = 0;
if (sortedNpmDependencies.length) {
  const lockRelative = `${adapterPath}/package-lock.json`;
  const lockBytes = fs.readFileSync(path.join(repoRoot, lockRelative));
  committedFile(lockRelative, lockBytes);
  if (lockBytes.length > 2 * 1024 * 1024) throw new Error('package-lock.json must be no larger than 2 MiB.');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const root = lock?.packages?.[''];
  const expected = Object.fromEntries(sortedNpmDependencies.map(({ name, version }) => [name, version]));
  if (!root || ![2, 3].includes(lock.lockfileVersion) || !root.name || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(root.version || '')
    || JSON.stringify(Object.entries(root.dependencies || {}).sort(([a], [b]) => a.localeCompare(b))) !== JSON.stringify(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)))
    || Object.keys(root.devDependencies || {}).length) throw new Error('package-lock.json direct dependencies must exactly match npmDependencies, use lockfile version 2 or 3 and no dev dependencies.');
  const packages = Object.entries(lock.packages).filter(([key]) => key !== '');
  if (!packages.length || packages.length > 256) throw new Error('package-lock.json must contain 1–256 packages.');
  for (const [key, item] of packages) {
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(key) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item?.version || '') || typeof item.resolved !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity || '') || item.link || item.hasInstallScript) throw new Error(`Unsafe or unpinned dependency in package-lock.json: ${key}`);
    const resolved = new URL(item.resolved);
    if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org' || resolved.username || resolved.password) throw new Error(`Dependencies must come from registry.npmjs.org: ${key}`);
  }
  dependencyLockSha256 = digest(lockBytes);
  dependencyPackageCount = packages.length;
}

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
  thirdPartyNotices: manifest.thirdPartyNotices || [],
  runtimeDependencies,
  npmDependencies: sortedNpmDependencies,
  dependencyLockSha256,
  dependencyPackageCount
};
registry.plugins = [...registry.plugins.filter((plugin) => plugin.id !== pluginId), entry].sort((left, right) => left.name.localeCompare(right.name));
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Published ${pluginId} ${manifest.version} in registry.json, pinned to ${commit}. Review and commit the registry update.`);
