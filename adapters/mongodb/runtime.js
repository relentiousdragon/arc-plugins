let mongoDriverPromise;
let mongoDriver;
const MAX_JSON_BYTES = 1_048_576;
const MAX_RESULTS = 500;
const clientsByProject = new Map();
//
function parseJson(value, label, fallback = {}) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 1 MiB limit.`);
  let parsed;
  try { parsed = mongoDriver?.BSON?.EJSON?.parse(text) ?? JSON.parse(text); } catch { throw new Error(`${label} must be valid JSON or MongoDB Extended JSON.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  assertSafeQueryObject(parsed, label);
  return parsed;
}

function assertSafeQueryObject(value, label, depth = 0) {
  if (depth > 64) throw new Error(`${label} is nested too deeply.`);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['$where', '$function', '$accumulator'].includes(key)) throw new Error(`${label} cannot use server-side JavaScript operators.`);
    assertSafeQueryObject(child, label, depth + 1);
  }
}

function serializeResult(value, label) {
  const result = mongoDriver?.BSON?.EJSON?.stringify(value, { relaxed: true }) ?? JSON.stringify(value);
  if (Buffer.byteLength(result, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 1 MiB output limit. Add a projection or lower the result limit.`);
  return result;
}

function parseJsonArray(value, label, maxItems = 100) {
  const text = String(value ?? '').trim() || '[]';
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 1 MiB limit.`);
  let parsed;
  try { parsed = EJSON.parse(text); } catch { throw new Error(`${label} must be a JSON array.`); }
  if (!Array.isArray(parsed) || parsed.length > maxItems) throw new Error(`${label} must be an array of at most ${maxItems} items.`);
  assertSafeQueryObject(parsed, label);
  return parsed;
}

function validateAgainstSchema(value, schema, path = '$', errors = [], depth = 0) {
  if (depth > 64) throw new Error('JSON Schema is nested too deeply.');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('JSON Schema must be an object.');
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const allowed = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowed.length && !allowed.some((type) => type === actualType || (type === 'number' && actualType === 'integer'))) {
    errors.push({ path, message: `Expected ${allowed.join(' or ')}, got ${actualType}.` });
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push({ path, message: 'Value is not in the allowed list.' });
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `Must contain at least ${schema.minLength} characters.` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `Must contain at most ${schema.maxLength} characters.` });
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test(value)) errors.push({ path, message: `Must match ${schema.pattern}.` }); }
      catch { throw new Error(`Invalid JSON Schema pattern at ${path}.`); }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `Must be at least ${schema.minimum}.` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `Must be at most ${schema.maximum}.` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `Must contain at least ${schema.minItems} items.` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `Must contain at most ${schema.maxItems} items.` });
    if (schema.items) value.slice(0, MAX_RESULTS).forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`, errors, depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: 'Required property is missing.' });
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateAgainstSchema(child, schema.properties[key], `${path}.${key}`, errors, depth + 1);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'Additional property is not allowed.' });
    }
  }
  return errors;
}

function validateConnection(config) {
  if (config?.connectionString) {
    let parsed;
    try { parsed = new URL(String(config.connectionString)); } catch { throw new Error('Set a valid MONGODB_URI in the exported bot environment.'); }
    if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || parsed.searchParams.get('tlsInsecure') === 'true' || parsed.searchParams.get('tlsAllowInvalidCertificates') === 'true' || parsed.searchParams.get('tlsAllowInvalidHostnames') === 'true') throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv:// with certificate verification enabled.');
    const database = String(config.database || decodeURIComponent(parsed.pathname.slice(1).split('/')[0] || '')).trim();
    if (!database || /[\s/\\."$]/.test(database)) throw new Error('Set a valid MongoDB database in the exported bot environment.');
    return { uri: parsed.href, database, options: { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 10, retryWrites: true } };
  }
  const host = String(config?.host || '').trim();
  const database = String(config?.database || '').trim();
  if (!host || /[\s/@?#]/.test(host) || (host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) && !/^[\da-f:]+$/i.test(host))) throw new Error('Set a valid MongoDB host in Plugin Store settings.');
  if (!database || database.length > 63 || /[\s/\\."$]/.test(database)) throw new Error('Set a valid default MongoDB database in Plugin Store settings.');
  const port = Math.trunc(Number(config.port) || 27017);
  if (port < 1 || port > 65535) throw new Error('MongoDB port must be between 1 and 65535.');
  const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password || '')}@` : '';
  const params = new URLSearchParams();
  if (config.username) params.set('authSource', String(config.authSource || 'admin'));
  if (config.tls) params.set('tls', 'true');
  if (config.replicaSet) params.set('replicaSet', String(config.replicaSet));
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const uri = `${config.srv ? 'mongodb+srv' : 'mongodb'}://${auth}${normalizedHost}${config.srv ? '' : `:${port}`}/${encodeURIComponent(database)}${params.size ? `?${params}` : ''}`;
  return { uri, database, options: {
    serverSelectionTimeoutMS: Math.max(1000, Math.min(30000, Number(config.serverSelectionTimeoutMS) || 5000)),
    connectTimeoutMS: Math.max(1000, Math.min(30000, Number(config.serverSelectionTimeoutMS) || 5000)),
    maxPoolSize: Math.max(1, Math.min(50, Number(config.maxPoolSize) || 10)),
    retryWrites: true
  } };
}

export async function executeMongoNode(nodeType, input, config) {
  if (nodeType.endsWith('validate-document')) {
    const document = parseJson(input.document, 'Document');
    const schema = parseJson(input.schema, 'JSON Schema');
    const errors = validateAgainstSchema(document, schema).slice(0, 100);
    return { valid: errors.length === 0, errors: JSON.stringify(errors) };
  }
  mongoDriverPromise ||= import('mongodb').then((module) => (mongoDriver = module.default || module)).catch((error) => {
    mongoDriverPromise = null;
    throw new Error(`MongoDB runtime is unavailable: ${error.message || 'install the MongoDB driver to use database nodes.'}`);
  });
  await mongoDriverPromise;
  const { MongoClient, MongoError } = mongoDriver;
  const { uri, database: defaultDatabase, options } = validateConnection(config);
  const requestedDatabase = String(input.database || '').trim();
  if (requestedDatabase && requestedDatabase !== defaultDatabase) throw new Error('MongoDB nodes are limited to the database configured for this project.');
  const database = defaultDatabase;
  const collectionName = String(input.collection || '').trim();
  if (!database || /[\s/\\."$]/.test(database)) throw new Error('Enter a valid database name.');
  const listCollections = nodeType.endsWith('list-collections');
  if (!listCollections && (!collectionName || collectionName.length > 120 || /[\0$]/.test(collectionName))) throw new Error('Enter a valid collection name.');
  const filter = ['find-one', 'find-many', 'update-one', 'update-many', 'delete-one', 'delete-many', 'count', 'distinct'].some((operation) => nodeType.endsWith(operation)) ? parseJson(input.filter, 'Filter') : {};
  const projectDir = String(config.__projectDir || '');
  if (!projectDir) throw new Error('MongoDB project scope is unavailable.');
  const signature = `${uri}:${JSON.stringify(options)}`;
  let pooled = clientsByProject.get(projectDir);
  if (pooled?.signature !== signature) {
    if (pooled) await pooled.client.close().catch(() => {});
    pooled = { signature, client: new MongoClient(uri, options), connected: false };
    clientsByProject.set(projectDir, pooled);
  }
  const client = pooled.client;
  try {
    if (!pooled.connected) {
      pooled.connecting ||= client.connect().then(() => { pooled.connected = true; }).catch((error) => { clientsByProject.delete(projectDir); throw error; }).finally(() => { pooled.connecting = null; });
      await pooled.connecting;
    }
    const db = client.db(database);
    if (listCollections) {
      const collections = (await db.listCollections({}, { nameOnly: true, maxTimeMS: 10000 }).toArray()).map((item) => item.name);
      return { collections: serializeResult(collections, 'Collections'), count: collections.length };
    }
    const collection = db.collection(collectionName);
    if (nodeType.endsWith('find-one')) {
      const document = await collection.findOne(filter, { maxTimeMS: 10000 });
      return { found: Boolean(document), document: document ? serializeResult(document, 'Document') : '' };
    }
    if (nodeType.endsWith('find-many')) {
      const projection = parseJson(input.projection, 'Projection');
      const limit = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(Number(input.limit) || 100)));
      const documents = await collection.find(filter, { projection, maxTimeMS: 10000 }).limit(limit).toArray();
      return { documents: serializeResult(documents, 'Documents'), count: documents.length };
    }
    if (nodeType.endsWith('insert-one')) {
      const document = parseJson(input.document, 'Document', null);
      if (!document) throw new Error('Document must be a JSON object.');
      const result = await collection.insertOne(document, { maxTimeMS: 10000 });
      return { inserted_id: String(result.insertedId) };
    }
    if (nodeType.endsWith('insert-many')) {
      const documents = parseJsonArray(input.documents, 'Documents');
      if (!documents.length || documents.some((document) => !document || typeof document !== 'object' || Array.isArray(document))) throw new Error('Documents must contain at least one JSON object.');
      const result = await collection.insertMany(documents, { ordered: true });
      return { inserted_count: result.insertedCount, inserted_ids: serializeResult(Object.values(result.insertedIds).map(String), 'Inserted IDs') };
    }
    if (nodeType.endsWith('update-one')) {
      const update = parseJson(input.update, 'Update document', null);
      if (!update || !Object.keys(update).some((key) => key.startsWith('$'))) throw new Error('Update document must use MongoDB update operators such as $set.');
      const updateOptions = { maxTimeMS: 10000, upsert: Boolean(input.upsert) };
      const result = nodeType.endsWith('update-many')
        ? await collection.updateMany(filter, update, updateOptions)
        : await collection.updateOne(filter, update, updateOptions);
      return { matched_count: result.matchedCount, modified_count: result.modifiedCount, upserted_id: result.upsertedId ? String(result.upsertedId) : '' };
    }
    if (nodeType.endsWith('delete-one')) {
      const result = await collection.deleteOne(filter, { maxTimeMS: 10000 });
      return { deleted_count: result.deletedCount };
    }
    if (nodeType.endsWith('delete-many')) {
      const result = await collection.deleteMany(filter, { maxTimeMS: 10000 });
      return { deleted_count: result.deletedCount };
    }
    if (nodeType.endsWith('count')) {
      return { count: await collection.countDocuments(filter, { maxTimeMS: 10000 }) };
    }
    if (nodeType.endsWith('distinct')) {
      const field = String(input.field || '').trim();
      if (!field || field.length > 200 || field.startsWith('$')) throw new Error('Enter a valid field path for Distinct Values.');
      const values = await collection.distinct(field, filter, { maxTimeMS: 10000 });
      return { values: serializeResult(values, 'Distinct values'), count: values.length };
    }
    if (nodeType.endsWith('aggregate')) {
      const pipeline = parseJsonArray(input.pipeline, 'Pipeline', 100);
      if (pipeline.some((stage) => !stage || typeof stage !== 'object' || Array.isArray(stage) || ['$out', '$merge'].some((key) => Object.hasOwn(stage, key)))) throw new Error('Pipeline stages must be objects and cannot use $out or $merge.');
      const limit = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(Number(input.limit) || 100)));
      const documents = await collection.aggregate(pipeline, { maxTimeMS: 10000, allowDiskUse: false }).limit(limit).toArray();
      return { documents: serializeResult(documents, 'Aggregate results'), count: documents.length };
    }
    if (nodeType.endsWith('create-index')) {
      const keys = parseJson(input.keys, 'Index keys', null);
      if (!keys || !Object.keys(keys).length) throw new Error('Index keys must define at least one field.');
      const indexOptions = parseJson(input.options, 'Index options');
      delete indexOptions.background;
      const indexName = await collection.createIndex(keys, indexOptions);
      return { index_name: indexName };
    }
    throw new Error(`Unknown MongoDB node “${nodeType}”.`);
  } catch (error) {
    if (!(error instanceof MongoError)) throw error;
    throw new Error('MongoDB operation failed. Check the project connection settings and query values.');
  }
}

export async function closeMongoProjectConnection(projectDir) {
  const pooled = clientsByProject.get(String(projectDir));
  if (!pooled) return;
  clientsByProject.delete(String(projectDir));
  await pooled.client.close().catch(() => {});
}

