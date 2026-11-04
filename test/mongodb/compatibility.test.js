const {test} = require('node:test');
const assert = require('node:assert/strict');
const Q = require('q');
const {MongoClient, ObjectId, BSON} = require('mongodb');
const {normalizeClientOptions, normalizeOperationOptions, wrapCollection, wrapCursor, writeResult} =
    require('../../lib/dbAdapters/lib/mongoCompatibility');

test('legacy client settings are copied, translated and accepted by driver 7', async () => {
    const legacy = {poolSize: 15, bufferMaxEntries: 0, useUnifiedTopology: true,
        keepAlive: true, keepAliveInitialDelay: 1, readPreference: 'secondaryPreferred', replicaSet: 'rs0'};
    const options = normalizeClientOptions(legacy);
    assert.equal(options.maxPoolSize, 15);
    assert.equal(options.readPreference, legacy.readPreference);
    assert.equal(options.replicaSet, 'rs0');
    assert.equal(options.bufferMaxEntries, undefined);
    assert.equal(legacy.poolSize, 15);
    assert.equal(normalizeClientOptions({poolSize: 15, maxPoolSize: 30}).maxPoolSize, 30);
    const client = new MongoClient('mongodb://127.0.0.1:27017/test', options);
    await client.close();
});

test('unknown driver settings are not silently swallowed', () => {
    assert.throws(() => new MongoClient('mongodb://127.0.0.1/test', normalizeClientOptions({badOption: true})), /not supported/);
});

test('operation options are copied and Mia-only settings do not reach the driver', () => {
    const input = {returnOriginal: false, validate: false, ignoreShardKey: true, writeConcern: {w: 'majority'}};
    assert.deepEqual(normalizeOperationOptions(input), {returnDocument: 'after', writeConcern: {w: 'majority'}});
    assert.equal(input.returnOriginal, false);
    assert.equal(normalizeOperationOptions({returnOriginal: false, returnDocument: 'before'}).returnDocument, 'before');
});

test('MongoObjectID creates genuine modern BSON IDs with and without new', () => {
    const adapters = require('../../lib/dbAdapters');
    assert.equal(adapters.MongoObjectID.prototype, ObjectId.prototype);
    assert.equal(adapters.MongoObjectId, adapters.MongoObjectID);
    const id = new adapters.MongoObjectID();
    assert.ok(BSON.deserialize(BSON.serialize({_id: id}))._id.equals(id));
    assert.ok(id instanceof adapters.MongoObjectID);
    assert.ok(id instanceof ObjectId);
    assert.ok(adapters.MongoObjectID(id.toHexString()).equals(id));
    assert.ok(adapters.MongoObjectID.createFromHexString(id.toHexString()).equals(id));
    assert.equal(require('bson').ObjectId, ObjectId);
});

test('collection methods support Q promises, callbacks and native promise rejection', async () => {
    const input = {returnOriginal: false};
    let seen;
    const native = {findOneAndUpdate(query, update, options) {
        seen = [query, update, options];
        return Promise.resolve({ok: 1, value: {state: 'active'}});
    }};
    const collection = wrapCollection(native, {});
    const result = await Q.ninvoke(collection, 'findOneAndUpdate', {}, {$set: {}}, input);
    assert.equal(result.value.state, 'active');
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[2], {returnDocument: 'after', includeResultMetadata: true});
    assert.deepEqual(input, {returnOriginal: false});
    assert.equal(typeof collection.findOneAndUpdate({}, {}).fail, 'function');
});

test('explicit modern document-only findOneAnd results remain available', async () => {
    const native = {findOneAndDelete(query, options) {
        assert.equal(options.includeResultMetadata, false);
        return Promise.resolve(null);
    }};
    assert.equal(await wrapCollection(native, {}).findOneAndDelete({}, {includeResultMetadata: false}), null);
});

test('distinct keeps driver-3 behavior by not forwarding formerly ignored hints', async () => {
    const input = {hint: {importedAt: 1}, readPreference: 'secondaryPreferred'};
    const native = {async distinct(key, query, options) {
        assert.equal(options.hint, undefined);
        assert.equal(options.readPreference, 'secondaryPreferred');
        return ['a'];
    }};
    assert.deepEqual(await wrapCollection(native, {}).distinct('id', {}, input), ['a']);
    assert.deepEqual(input.hint, {importedAt: 1});
});

test('driver sync throws and rejected operations each call the callback once', async () => {
    for (const operation of [() => {throw new Error('bad query');}, () => Promise.reject(new Error('bad query'))]) {
        const collection = wrapCollection({findOne: operation}, {});
        let calls = 0;
        await new Promise(resolve => collection.findOne({}, error => {
            calls++;
            assert.match(error.message, /bad query/);
            resolve();
        }));
        assert.equal(calls, 1);
        await assert.rejects(collection.findOne({}), /bad query/);
    }
});

test('legacy insert results contain driver-assigned IDs, count, ops and acknowledgment', async () => {
    const doc = {name: 'heartbeat'};
    const native = {insertOne(value) {
        value._id = new ObjectId();
        return Promise.resolve({acknowledged: true, insertedId: value._id});
    }};
    const result = await wrapCollection(native, {}).insertOne(doc);
    assert.equal(result.ops[0], doc);
    assert.equal(result.insertedId, result.ops[0]._id);
    assert.equal(result.insertedCount, 1);
    assert.deepEqual(result.result, {ok: 1, n: 1});
});

test('update/upsert and delete result shapes preserve zero counts', () => {
    assert.deepEqual(writeResult('updateOne', {acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0}, []).result,
        {ok: 1, n: 0, nModified: 0});
    const id = new ObjectId();
    assert.deepEqual(writeResult('replaceOne', {acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: id}, []).result,
        {ok: 1, n: 1, nModified: 0, upserted: [{index: 0, _id: id}]});
    assert.deepEqual(writeResult('deleteMany', {acknowledged: true, deletedCount: 0}, []).result, {ok: 1, n: 0});
});

test('unacknowledged writes do not claim success, counts or inserted documents', () => {
    const result = writeResult('insertOne', {acknowledged: false}, [{}]);
    assert.deepEqual(result.result, {ok: 0});
    assert.equal(result.ops, undefined);
    assert.equal(result.insertedCount, undefined);
});

test('documents with fields named acknowledged/result are never normalized as write results', () => {
    const doc = {acknowledged: true, result: 'application data'};
    assert.equal(writeResult('findOne', doc, []), doc);
    assert.deepEqual(doc, {acknowledged: true, result: 'application data'});
});

test('cursor chaining, callback next/toArray and Q.ninvoke retain the native receiver', async () => {
    const native = {
        limit() {assert.equal(this, native); return this;},
        async next() {assert.equal(this, native); return {id: 1};},
        async toArray() {assert.equal(this, native); return [{id: 2}];}
    };
    const cursor = wrapCursor(native);
    assert.equal(cursor.limit(2), cursor);
    assert.deepEqual(await Q.ninvoke(cursor, 'next'), {id: 1});
    assert.deepEqual(await cursor.toArray(), [{id: 2}]);
    assert.notEqual(cursor.toArray, native.toArray);
});

test('cursor forEach keeps its iterator and completion callback distinct', async () => {
    const cursor = wrapCursor({async forEach(iterator) {iterator({id: 1});}});
    const ids = [];
    await cursor.forEach(doc => ids.push(doc.id));
    await Q.ninvoke(cursor, 'forEach', doc => ids.push(doc.id));
    assert.deepEqual(ids, [1, 1]);
});

test('count() uses the full query, count(true) honors chained skip/limit without consuming cursor', async () => {
    const seen = [];
    const db = {async command(command, options) {seen.push({command, options}); return {n: 10};}};
    const native = {limit() {return this;}, skip() {return this;}, clone() {return {...this};}};
    const cursor = wrapCursor(native, {db, collectionName: 'videos', filter: {published: true},
        options: {readPreference: 'secondaryPreferred'}}).skip(3).limit(2);
    assert.equal(await cursor.count(), 10);
    assert.deepEqual(seen[0].command, {count: 'videos', query: {published: true}});
    assert.equal(seen[0].options.readPreference, 'secondaryPreferred');
    await cursor.count(true);
    assert.equal(seen[1].command.skip, 3);
    assert.equal(seen[1].command.limit, 2);
    const clone = cursor.clone().limit(1);
    await clone.count(true);
    await cursor.count(true);
    assert.equal(seen[2].command.limit, 1);
    assert.equal(seen[3].command.limit, 2);
    await Q.ninvoke(cursor, 'count');
    assert.equal(seen[4].command.limit, 2);
});

test('bulk builders retain fluent chains and callback execute aliases', async () => {
    const result = {ok: 1, insertedCount: 2, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0};
    const bulk = {
        insert() {return this;},
        find() {return {updateOne() {return bulk;}};},
        async execute() {assert.equal(this, bulk); return result;}
    };
    const collection = wrapCollection({initializeOrderedBulkOp() {return bulk;}}, {});
    const builder = collection.initializeOrderedBulkOp();
    assert.equal(builder.insert({}), builder);
    assert.equal(builder.find({}).updateOne({$set: {}}), builder);
    assert.equal((await Q.ninvoke(builder, 'execute')).nInserted, 2);
});

test('stats and mapReduce use public Db.command with BSON Code', async () => {
    const seen = [];
    const db = {async command(command) {seen.push(command); return command.mapReduce ? {results: [{_id: 1, value: 2}]} : {count: 2};}};
    const collection = wrapCollection({collectionName: 'legacy'}, db);
    assert.equal((await collection.stats()).count, 2);
    assert.deepEqual(await Q.ninvoke(collection, 'mapReduce', function () {}, function () {}, {out: {inline: 1}}), [{_id: 1, value: 2}]);
    assert.equal(seen[1].map._bsontype, 'Code');
});

test('native collections are not monkey-patched and wrappers are stable', () => {
    const native = {async findOne() {return {};}};
    const original = native.findOne;
    assert.equal(wrapCollection(native, {}), wrapCollection(native, {}));
    assert.equal(native.findOne, original);
});

test('mapReduce separates driver options, preserves verbose stats and converts nested scope', async () => {
    const session = {};
    const collection = wrapCollection({collectionName: 'legacy'}, {
        async command(command, options) {
            assert.equal(command.session, undefined);
            assert.equal(command.readPreference, undefined);
            assert.equal(options.session, session);
            assert.equal(options.readPreference, 'secondaryPreferred');
            assert.equal(command.scope.helper._bsontype, 'Code');
            return {results: [], counts: {input: 0}, timeMillis: 2};
        }
    });
    const result = await collection.mapReduce(function () {}, function () {}, {
        session, readPreference: 'secondaryPreferred', verbose: true, scope: {helper() {}}
    });
    assert.deepEqual(result, {results: [], stats: {processtime: 2, counts: {input: 0}}});
});

test('mapReduce collection output keeps the legacy verbose shape and targets the output DB', async () => {
    const outputDb = {collection(name) {assert.equal(name, 'output'); return {collectionName: name};}};
    const db = {
        client: {db(name) {assert.equal(name, 'otherDb'); return outputDb;}},
        async command(command, options) {
            assert.equal(options.readPreference, 'primary');
            assert.deepEqual(command.writeConcern, {w: 'majority'});
            return {result: {db: 'otherDb', collection: 'output'}, counts: {output: 1}};
        }
    };
    const result = await wrapCollection({collectionName: 'input'}, db)
        .mapReduce(function () {}, function () {}, {out: {replace: 'output', db: 'otherDb'}, verbose: true, writeConcern: {w: 'majority'}});
    assert.equal(result.collection.collectionName, 'output');
    assert.deepEqual(result.stats, {counts: {output: 1}});
});

test('mapReduce function arguments are not mistaken for completion callbacks', async () => {
    let reductions = 0;
    const db = {async command(command) {
        assert.equal(command.reduce._bsontype, 'Code');
        return {results: []};
    }};
    const collection = wrapCollection({collectionName: 'input'}, db);
    await collection.mapReduce(function () {}, function () {reductions++;});
    assert.equal(reductions, 0);
});

test('cursor counts inherit collection read preference/concern and allow explicit overrides', async () => {
    const seen = [];
    const collection = wrapCollection({
        collectionName: 'video', readPreference: 'secondaryPreferred', readConcern: {level: 'majority'},
        find() {return {};}
    }, {async command(command, options) {seen.push({command, options}); return {n: 0};}});
    await collection.find({}).count();
    assert.equal(seen[0].options.readPreference, 'secondaryPreferred');
    assert.deepEqual(seen[0].command.readConcern, {level: 'majority'});
    await collection.find({}, {readPreference: 'primary'}).count();
    assert.equal(seen[1].options.readPreference, 'primary');
});
