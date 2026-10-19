# ARC Plugin Catalog

Build and publish plugins for ARC Studio, or host a catalog for your own team or community. This repository contains the catalog format, publishing tools, and examples of each supported plugin type.

ARC plugins use one of three formats:

| Format | Use it for | What ARC installs |
|---|---|---|
| Function graph pack (`graph-pack`) | Reusable logic built from ARC's supported pure nodes | Validated JSON graphs, no plugin code runs |
| WebAssembly adapter (`wasm-adapter`) | Bounded computation or integrations supported by the adapter API | A manifest and WASM module with no host imports |
| Host adapter (`host-adapter`) | Server-side integrations that need Node.js capabilities | JavaScript that runs with the ARC server process's OS access |

Use a Function graph pack when it fits. WASM adapters have no filesystem, network, or other host capabilities. Host adapters are executable server code, ARC's permission checks do not sandbox them. Only install host adapters from publishers you trust.

## Use a catalog

The ARC Plugin Store rreads `registry.json` from the `main` branch of a public GitHub or GitLab repository. To use another catalog, open **Plugin Store → Change source** and enter that repository's URL. The workspace administrator must confirm that they trust the source.

A catalog is an index, not the plugin itself. Each entry points to an artifact at a specific Git commit and includes a SHA-256 digest. ARC fetches the artifact from that commit and verifies the digest before installation. A digest detects changed or incomplete content, it does not verify the publisher's identity or audit the code.

## Host your own catalog

1. Create a public GitHub or GitLab repository. Put `registry.json` at the repository root and keep it on the `main` branch.
2. Add versionned Function graph packs or adapter directories, along with the publishing scripts for the formats you use. You can start from this repository or maintain a separate catalog with your own plugins.
3. Commit each plugin artifact before generating its catalog entry. The publisher scripts use the artifact commit as the immutable source revision.
4. Review and commit the generated `registry.json`, then push both commits to `main`.
5. In ARC Studio, choose **Plugin Store → Change source** and enter your repository URL.

Keep the catalog public and avoid putting credentials, private keys, passwords, tokens, or real user data in it. ARC does not install dependencies from plugin repositories or run npm lifecycle scripts.

## Repository layout

```text
registry.json
packs/<plugin-id>/<version>.json
adapters/<adapter-name>/
  arc-plugin.json
  runtime.js       # host adapter, when applicable
  adapter.wasm     # WASM adapter, when applicable
scripts/
  publish-pack.mjs
  publish-adapter.mjs
  publish-wasm-adapter.mjs
```

The adapter directories in this repository include `arc.mongodb` and `arc.resvg`. Each adapter README describes its build, configuration, and runtime requirements.

## Create and publish a Function graph pack

A Function graph pack is JSON containing one or more reusable Function graphs. It cannot introduce arbitrary JavaScript or side-effecting nodes. Each function must have a stable ID and exactly one `function_return` node. The complete pack may be at most 1 MiB, each function may have up to 128 nodes and 512 connections.

1. Add a new file at `packs/<plugin-id>/<version>.json`. Include `schemaVersion: 1`, `id`, `name`, `version`, `minArcStudioVersion`, `arcApiVersion: 1`, and a non-empty `functions` array. Use a new file and version for every release.
2. Validate the graphs against ARC Studio's [Plugin Registry and pack format](https://github.com/relentiousdragon/arc-studio/blob/main/docs/PLUGIN_REGISTRY.md). Keep function IDs and input/output types stable for compatible updates.
3. Commit the pack file:

   ```sh
   git add packs/<plugin-id>/<version>.json
   git commit -m "Add <plugin-name> <version>"
   ```

4. Generate its catalog entry:

   ```sh
   node scripts/publish-pack.mjs packs/<plugin-id>/<version>.json
   ```

   The script checks the committed file and its metadata, calculates the digest, and updates `registry.json`. It refuses to publish different bytes under a version already listed for that plugin ID.
5. Review and publish the catalog update:

   ```sh
   git diff -- registry.json
   git add registry.json
   git commit -m "Publish <plugin-name> <version>"
   git push origin main
   ```

For example, if `example.utilities` is at `1.0.0`, release `1.1.0` as `packs/example.utilities/1.1.0.json`. Do not edit the published `1.0.0.json` file. The catalog has one current entry per plugin ID, publishing the new entry makes that version the one offered to new installs and updates.

## Publish an adapter

Adapters are declared in `adapters/<name>/arc-plugin.json`. Keep the manifest, source, generated module or runtime, and applicable license and third-party notices together. Set `minArcStudioVersion` to the oldest ARC Studio version that supports the adapter.

For a WASM adapter, build the module and update `wasmSha256` in the manifest to match its exact bytes. Commit the manifest and module, then run:

```sh
node scripts/publish-wasm-adapter.mjs <plugin-id>
```

For a host adapter, update `runtime.sha256` to match the runtime file, commit both files, then run:

```sh
node scripts/publish-adapter.mjs <plugin-id>
```

For example, the IDs in this repository are `arc.resvg` and `arc.mongodb`. Each publisher checks that the adapter files are committed, writes or replaces that plugin's entry in `registry.json`, and pins the entry to the current commit. Review and commit the registry change, then push it. To release an adapter update, increment its manifest version and publish the updated files in a new commit. The old files remain available at the old pinned commit even when the current manifest path changes.

WASM adapters must have no imported host functions and must meet ARC's memory, input, output, and execution limits. Host adapter updates are always manual and require users to review the source and acknowledge installation again.

## Release and compatibility rules

- Use Semantic Versioning for plugin versions.
- Publish new content under a new version. Never replace the bytes of an already published pack version or change an existing release in place.
- Commit plugin files first, generate the registry entry only after that commit exists.
- The publisher scripts fill in immutable commit pins and content digests. Review the generated registry entry before committing it.
- Keep `minArcStudioVersion` in the artifact and catalog consistent. ARC will refuse installation or execution on older Studio versions.
- Preserve function IDs, node types, and input/output behavior for compatible updates. Document breaking changes and increment the major version when necessary.
- Automatic updates are available for opted-in Function graph packs. WASM and host adapter code always requires manual review.

The recommended workflow is to run validation in CI and publish deliberately. CI can verify registry entries, paths, manifests, and digests without automatically changing the catalog.

## Licensing

The repository's root `LICENSE` covers only work to which it applies. A plugin may have its own license, include that license in its directory and identify it in the catalog entry. Include third-party notices for bundled dependencies and generated artifacts. The catalog's `license` field is informational and does not replace license files or dependency notices. Make it clear which license covers each part of a plugin.

## More documentation

The ARC Studio documentation linked below is still in progress, so some pages may not  be available just yet.

- [Plugin registry and pack format](https://github.com/relentiousdragon/arc-studio/blob/main/docs/PLUGIN_REGISTRY.md)
- [Plugin development](https://github.com/relentiousdragon/arc-studio/blob/main/docs/PLUGIN_DEVELOPMENT.md)
- [Adapter runtime](https://github.com/relentiousdragon/arc-studio/blob/main/docs/PLUGIN_ADAPTER_RUNTIME.md)
