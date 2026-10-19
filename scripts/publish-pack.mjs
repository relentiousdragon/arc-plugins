import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relativePath = process.argv[2]?.replaceAll('\\', '/');
if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split('/').some((part) => part === '..')) {
  throw new Error('Usage: node scripts/publish-pack.mjs packs/<plugin-id>/<version>.json');
}

const normalizedPath = path.posix.normalize(relativePath);
const match = normalizedPath.match(/^packs\/([a-z0-9][a-z0-9.-]{1,62})\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.json$/);
if (!match) throw new Error('Pack path must be packs/<plugin-id>/<semver-version>.json.');

const [, pluginId, version] = match;
const packPath = path.join(repoRoot, normalizedPath);
const packBytes = fs.readFileSync(packPath);
if (packBytes.length > 1024 * 1024) throw new Error('Function graph packs cannot exceed 1 MiB.');
const committedPack = execFileSync('git', ['show', `HEAD:${normalizedPath}`], { cwd: repoRoot, encoding: 'buffer' });
if (!committedPack.equals(packBytes)) throw new Error('Commit the pack file before publishing its registry entry.');

let pack;
try { pack = JSON.parse(packBytes.toString('utf8')); }
catch { throw new Error('Pack file must contain valid JSON.'); }
if (pack.schemaVersion !== 1 || pack.id !== pluginId || pack.version !== version || pack.arcApiVersion !== 1
  || !String(pack.name || '').trim() || !String(pack.minArcStudioVersion || '').trim()
  || !Array.isArray(pack.functions) || !pack.functions.length || pack.functions.length > 50) {
  throw new Error('Pack metadata must match its path and include a name, ARC version floor, and 1–50 functions.');
}
if ((Array.isArray(pack.permissions) && pack.permissions.length) || (Array.isArray(pack.capabilities) && pack.capabilities.length)) {
  throw new Error('Function graph packs cannot request host permissions or capabilities.');
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Could not read the plugin repository commit.');
const sha256 = crypto.createHash('sha256').update(packBytes).digest('hex');
const registryPath = path.join(repoRoot, 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (registry.schemaVersion !== 1 || !Array.isArray(registry.plugins)) throw new Error('registry.json must use schema version 1.');

const previous = registry.plugins.find((plugin) => plugin.id === pluginId);
if (previous?.version === version && (previous.sha256 !== sha256 || previous.path !== normalizedPath)) {
  throw new Error(`Refusing to publish different content for ${pluginId} ${version}, release a new version instead.`);
}

const entry = {
  kind: 'graph-pack',
  id: pluginId,
  name: String(pack.name).trim(),
  version,
  minArcStudioVersion: pack.minArcStudioVersion,
  description: String(pack.description || ''),
  author: String(pack.author || ''),
  license: String(pack.license || ''),
  tags: Array.isArray(pack.tags) ? pack.tags : [],
  arcApiVersion: 1,
  commit,
  path: normalizedPath,
  sha256
};
registry.plugins = [...registry.plugins.filter((plugin) => plugin.id !== pluginId), entry]
  .sort((left, right) => left.name.localeCompare(right.name));
fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Published ${pluginId} ${version} in registry.json, pinned to ${commit}. Review and commit the registry update.`);
