# MongoDB

`arc.mongodb` adds MongoDB query, write, and validation nodes to ARC Studio.

## Install and configure

Install **MongoDB** from **Plugin Store → Store**. This is a host adapter: its JavaScript runs in the ARC server process. Review the source and requested permissions before installing; ARC checks permissions when nodes run, but does not sandbox adapter code. Installation and each update require owner/admin approval.

Open **Plugin Store → Installed → Settings** for the active project to set the host or Atlas SRV connection, database, optional credentials, TLS, replica set, timeout, and connection pool size. The password is encrypted at rest. Connections are pooled per project.

The MongoDB Node.js driver must be present in the ARC server runtime. ARC does not install packages from the plugin repository.

## Nodes

- **Find One**, **Find Many**, **Count Documents**, **Distinct Values**, **Aggregate**, **List Collections**
- **Insert One**, **Insert Many**, **Update One**, **Update Many**, **Delete One**, **Delete Many**, **Create Index**
- **Validate Document** checks JSON against the supported JSON Schema subset locally; it does not connect to MongoDB.

The database nodes accept JSON for filters, documents, updates, projections, pipelines, index options, and schemas. Results are limited to 500 documents, insert-many accepts up to 100 documents. Operations have a 10-second limit, and JSON input and output are limited to 1 MiB. Aggregations cannot use `$out` or `$merge`; server-side JavaScript operators such as `$where`, `$function`, and `$accumulator` are rejected.

## Permissions

Grant capabilities per project in Plugin Store:

- `mongodb.read` - read documents, counts, distinct values, aggregation results, and collection names.
- `mongodb.write` - insert, update, and delete documents.
- `mongodb.schema` - create indexes.

Use a MongoDB account with only the database roles the bot needs. ARC Studio permissions do not replace MongoDB's own access controls.

## Exported bots

Exports that use MongoDB nodes include the adapter and MongoDB driver dependency. Set `MONGODB_URI` and, optionally, `MONGODB_DATABASE` in the exported bot's environment. Exports do not use ARC Studio's project permissions or encrypted settings, protect the environment file and use a least-privilege database account.

## License

The adapter source is MIT licensed; see [`LICENSE`](./LICENSE). The MongoDB Node.js driver is Apache-2.0 and has a separate notice in [`arc-plugin.json`](./arc-plugin.json).
