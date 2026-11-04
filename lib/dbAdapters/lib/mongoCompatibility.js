/**
 * Mia.js compatibility boundary. Native MongoDB objects and prototypes are never
 * patched; only objects returned through BaseModel are wrapped.
 */
const Q = require('q');
const {Code} = require('mongodb');
const collections = new WeakMap();

function normalizeClientOptions(settings = {}) {
    const options = Object.assign({}, settings);
    if (options.maxPoolSize === undefined && options.poolSize !== undefined) {
        options.maxPoolSize = options.poolSize;
    }
    // These switches no longer exist. Modern topology handling and TCP keepalive
    // are always enabled. bufferMaxEntries has no equivalent in modern drivers.
    ['poolSize', 'bufferMaxEntries', 'useUnifiedTopology', 'useNewUrlParser',
        'keepAlive', 'keepAliveInitialDelay'].forEach(key => delete options[key]);
    return options;
}

function splitCallback(args) {
    args = Array.from(args);
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
    return {args, callback};
}

function callAsync(operation, callback) {
    // Q.try captures synchronous driver validation errors as well as rejections.
    return Q.try(operation).nodeify(callback);
}

function normalizeOperationOptions(settings = {}) {
    const options = Object.assign({}, settings);
    delete options.ignoreShardKey;
    delete options.validate;
    if (options.returnOriginal !== undefined && options.returnDocument === undefined) {
        options.returnDocument = options.returnOriginal ? 'before' : 'after';
    }
    delete options.returnOriginal;
    return options;
}

function writeResult(method, result, args) {
    if (!result) return result;
    if (method === 'bulkWrite' || method === 'execute') {
        // Retain the driver's result instance, including its error inspection API.
        ['Inserted', 'Matched', 'Modified', 'Removed', 'Upserted'].forEach((name, index) => {
            const count = ['insertedCount', 'matchedCount', 'modifiedCount', 'deletedCount', 'upsertedCount'][index];
            if (result['n' + name] === undefined) result['n' + name] = result[count];
        });
        return result;
    }
    if (!['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'].includes(method) ||
        result.acknowledged === undefined) return result;
    const legacy = {ok: result.acknowledged ? 1 : 0};
    if (result.acknowledged) {
        if (method === 'insertOne' || method === 'insertMany') {
            result.insertedCount = method === 'insertOne' ? 1 : result.insertedCount;
            result.ops = method === 'insertOne' ? [args[0]] : args[0];
            legacy.n = result.insertedCount;
        } else if (method === 'deleteOne' || method === 'deleteMany') {
            legacy.n = result.deletedCount;
        } else {
            legacy.n = result.matchedCount + result.upsertedCount;
            legacy.nModified = result.modifiedCount;
            if (result.upsertedCount) legacy.upserted = [{index: 0, _id: result.upsertedId}];
        }
    }
    // Do not invent counts/documents for unacknowledged writes.
    result.result = legacy;
    return result;
}

function wrapBulk(bulk) {
    const cache = new WeakMap();
    function wrap(target) {
        if (cache.has(target)) return cache.get(target);
        const proxy = new Proxy(target, {
            get(object, key) {
                const value = Reflect.get(object, key, object);
                if (typeof value !== 'function') return value;
                if (key === 'execute') return function () {
                    const {args, callback} = splitCallback(arguments);
                    return callAsync(() => Q(value.apply(object, args))
                        .then(result => writeResult('execute', result))
                        .catch(error => {
                            if (error.result) writeResult('execute', error.result);
                            throw error;
                        }), callback);
                };
                return function () {
                    const result = value.apply(object, arguments);
                    if (result === object) return proxy;
                    // bulk.find() returns another fluent builder.
                    if (key === 'find') return wrap(result);
                    return result === bulk ? wrap(bulk) : result;
                };
            }
        });
        cache.set(target, proxy);
        return proxy;
    }
    return wrap(bulk);
}

function wrapCursor(cursor, countContext) {
    const asyncMethods = new Set(['toArray', 'next', 'tryNext', 'hasNext', 'close', 'explain', 'forEach']);
    const context = countContext && {
        db: countContext.db,
        collectionName: countContext.collectionName,
        filter: countContext.filter,
        options: Object.assign({}, countContext.options)
    };
    const proxy = new Proxy(cursor, {
        get(object, key) {
            if (key === 'count' && context) return function () {
                const {args, callback} = splitCallback(arguments);
                // Driver 3.x only applies the cursor's skip/limit when explicitly
                // requested (or in count(callback)); count() counts the full query.
                const applySkipLimit = args[0] === true || (args.length === 0 && !!callback);
                const options = typeof args[0] === 'object' ? args[0] : (args[1] || {});
                return callAsync(() => {
                    const command = {count: context.collectionName, query: context.filter};
                    ['hint', 'maxTimeMS', 'collation', 'readConcern'].forEach(name => {
                        const value = options[name] === undefined ? context.options[name] : options[name];
                        if (value !== undefined) command[name] = value;
                    });
                    ['skip', 'limit'].forEach(name => {
                        const value = applySkipLimit ? context.options[name] : options[name];
                        if (value) command[name] = value;
                    });
                    const commandOptions = {};
                    ['readPreference', 'session', 'timeoutMS'].forEach(name => {
                        const value = options[name] === undefined ? context.options[name] : options[name];
                        if (value !== undefined) commandOptions[name] = value;
                    });
                    return context.db.command(command, commandOptions).then(result => result.n);
                }, callback);
            };
            if (key === 'isClosed') return () => object.closed;
            const value = Reflect.get(object, key, object);
            if (typeof value !== 'function') return value;
            if (asyncMethods.has(key)) return function () {
                const {args, callback} = splitCallback(arguments);
                // forEach's first argument is an iterator, not a completion callback.
                if (key === 'forEach') {
                    const original = Array.from(arguments);
                    return callAsync(() => value.call(object, original[0]), original[1]);
                }
                return callAsync(() => value.apply(object, args), callback);
            };
            return function () {
                const args = Array.from(arguments);
                const result = value.apply(object, args);
                if (context) {
                    if (key === 'filter') context.filter = args[0];
                    if (['skip', 'limit', 'hint', 'maxTimeMS', 'collation'].includes(key)) context.options[key] = args[0];
                    if (key === 'withReadPreference') context.options.readPreference = args[0];
                }
                if (key === 'clone' || (result && result !== object && typeof result.toArray === 'function')) {
                    return wrapCursor(result, context);
                }
                return result === object ? proxy : result;
            };
        }
    });
    return proxy;
}

function wrapCollection(collection, db) {
    if (collections.has(collection)) return collections.get(collection);
    const cursorMethods = new Set(['find', 'aggregate', 'listIndexes']);
    const synchronousMethods = new Set(['watch']);
    const optionPositions = {
        find: 1, findOne: 1, insertOne: 1, insertMany: 1, updateOne: 2, updateMany: 2,
        replaceOne: 2, deleteOne: 1, deleteMany: 1, bulkWrite: 1, aggregate: 1,
        findOneAndDelete: 1, findOneAndReplace: 2, findOneAndUpdate: 2, createIndex: 1,
        countDocuments: 1, distinct: 2
    };
    const proxy = new Proxy(collection, {
        get(object, key) {
            if (key === 'stats') return function () {
                const {args, callback} = splitCallback(arguments);
                return callAsync(() => {
                    const options = Object.assign({}, args[0]);
                    const commandOptions = commandSettings(object, options);
                    return db.command(Object.assign({collStats: object.collectionName}, options), commandOptions);
                }, callback);
            };
            if (key === 'mapReduce') return function (map, reduce) {
                // The two required arguments may themselves be functions.
                const {args, callback} = arguments.length > 2 ? splitCallback(arguments) : {args: Array.from(arguments)};
                return callAsync(() => {
                    const options = Object.assign({}, args[2]);
                    const commandOptions = commandSettings(object, options);
                    const verbose = options.verbose;
                    delete options.verbose;
                    if (options.scope) options.scope = scopeToCode(options.scope);
                    const command = Object.assign({mapReduce: object.collectionName, out: {inline: 1}}, options, {
                        map: typeof map === 'function' ? new Code(map.toString()) : map,
                        reduce: typeof reduce === 'function' ? new Code(reduce.toString()) : reduce
                    });
                    if (typeof command.finalize === 'function') command.finalize = new Code(command.finalize.toString());
                    const inline = command.out === 'inline' || command.out.inline === 1;
                    if (!inline) {
                        commandOptions.readPreference = 'primary';
                        if (commandOptions.writeConcern) command.writeConcern = commandOptions.writeConcern;
                    } else if (commandOptions.readConcern) {
                        command.readConcern = commandOptions.readConcern;
                    }
                    const executable = options.explain ? {
                        explain: Object.assign({}, command), verbosity: typeof options.explain === 'string' ? options.explain : 'allPlansExecution'
                    } : command;
                    if (options.explain) delete executable.explain.explain;
                    return db.command(executable, commandOptions).then(response => {
                        if (options.explain) return response;
                        const stats = {};
                        if (response.timeMillis) stats.processtime = response.timeMillis;
                        if (response.counts) stats.counts = response.counts;
                        if (response.timing) stats.timing = response.timing;
                        if (response.results) return verbose ? {results: response.results, stats} : response.results;
                        const target = response.result;
                        // Db.client is public; support output into a different database.
                        const outputDb = typeof target === 'object' ? db.client.db(target.db) : db;
                        const output = wrapCollection(outputDb.collection(typeof target === 'string' ? target : target.collection), outputDb);
                        return verbose ? {collection: output, stats} : output;
                    });
                }, callback);
            };
            const value = Reflect.get(object, key, object);
            if (typeof value !== 'function') return value;
            return function () {
                const {args, callback} = splitCallback(arguments);
                const position = optionPositions[key];
                if (position !== undefined) {
                    args[position] = normalizeOperationOptions(args[position]);
                    // Driver 3.x never sent distinct hints. Enabling them during
                    // migration changes behavior (and fails on older servers or
                    // absent indexes). Native Db collections retain modern hints.
                    if (key === 'distinct') delete args[position].hint;
                    if (String(key).startsWith('findOneAnd') && args[position].includeResultMetadata === undefined) {
                        args[position].includeResultMetadata = true;
                    }
                }
                const invoke = () => {
                    const result = value.apply(object, args);
                    if (cursorMethods.has(key)) return wrapCursor(result, key === 'find' ? {
                        db, collectionName: object.collectionName, filter: args[0] || {},
                        options: Object.assign({readPreference: object.readPreference, readConcern: object.readConcern}, args[1])
                    } : undefined);
                    if (key === 'initializeOrderedBulkOp' || key === 'initializeUnorderedBulkOp') return wrapBulk(result);
                    if (synchronousMethods.has(key)) return result;
                    return Q(result).then(result => key === 'rename' ? wrapCollection(result, db) : writeResult(key, result, args))
                        .catch(error => {
                            if (key === 'bulkWrite' && error.result) writeResult(key, error.result);
                            throw error;
                        });
                };
                // Native collection.find() and bulk builders remain synchronous.
                // BaseModel wraps this immediate return in its own Q promise.
                if (!callback && (cursorMethods.has(key) || synchronousMethods.has(key) || String(key).startsWith('initialize'))) {
                    return invoke();
                }
                return callAsync(invoke, callback);
            };
        }
    });
    collections.set(collection, proxy);
    return proxy;
}

module.exports = {normalizeClientOptions, normalizeOperationOptions, wrapCollection, wrapCursor, writeResult};

function commandSettings(collection, options) {
    const settings = {};
    ['readPreference', 'readConcern', 'writeConcern', 'session', 'timeoutMS'].forEach(name => {
        const value = options[name] === undefined ? collection[name] : options[name];
        if (value !== undefined) settings[name] = value;
        delete options[name];
    });
    return settings;
}

function scopeToCode(value) {
    if (typeof value === 'function') return new Code(value.toString());
    if (!value || typeof value !== 'object' || value._bsontype || value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(scopeToCode);
    const scope = {};
    Object.keys(value).forEach(key => {scope[key] = scopeToCode(value[key]);});
    return scope;
}
