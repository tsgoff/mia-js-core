const {test} = require('node:test');
const assert = require('node:assert/strict');
const Q = require('q');
const Shared = require('../../lib/shared');
const BaseModel = require('../../lib/baseModel');
const MongoAdapter = require('../../lib/dbAdapters').MongoAdapter;
const {MongoClient} = require('mongodb');

test('adapter uses public db() and promise close, retaining the logical registration name', async t => {
    const client = {db() {return {databaseName: 'physicalDb'};}, async close() {}};
    let registration;
    t.mock.method(Shared, 'config', key => key.endsWith('.url') ? 'mongodb://127.0.0.1/physicalDb' : {poolSize: 9});
    t.mock.method(Shared, 'registerDbConnection', (...args) => {registration = args;});
    t.mock.method(MongoClient, 'connect', async (url, options) => {
        assert.equal(url, 'mongodb://127.0.0.1/physicalDb');
        assert.equal(options.maxPoolSize, 9);
        return client;
    });
    const adapter = new MongoAdapter();
    const db = await adapter.connect('logicalDb');
    assert.deepEqual(registration, ['logicalDb', db, client]);
    await adapter.close('logicalDb', client);
});

test('adapter connection and close errors reject without logging credential-bearing errors', async t => {
    const logger = require('../../lib/logger');
    const messages = [];
    t.mock.method(logger, 'error', message => messages.push(message));
    t.mock.method(Shared, 'config', key => key.endsWith('.url') ? 'mongodb://127.0.0.1/test' : {});
    t.mock.method(MongoClient, 'connect', () => {throw new Error('secret-from-uri');});
    const adapter = new MongoAdapter();
    await assert.rejects(adapter.connect('test'));
    await assert.rejects(adapter.close('test', {async close() {throw new Error('secret-from-uri');}}));
    assert.ok(messages.every(message => !message.includes('secret-from-uri')));
});

test('BaseModel dispatch adopts native promises without appending callbacks or changing args', async () => {
    const Model = BaseModel.extend({}, {collectionName: 'test'});
    const args = [{name: 'query'}];
    Model.collection = () => Q({findOne(query) {
        assert.equal(arguments.length, 1);
        assert.equal(query, args[0]);
        return Promise.resolve({found: true});
    }});
    assert.deepEqual(await Model._generic('findOne', args), {found: true});
    assert.equal(args.length, 1);
});

test('ensureIndexes never mutates reusable or frozen index specifications', async () => {
    const Model = BaseModel.extend({}, {collectionName: 'test'});
    const index = Object.freeze({key: Object.freeze({name: 1}), unique: true, name: 'name'});
    const seen = [];
    Model.collection = callback => {
        const collection = {createIndex(key, options, done) {seen.push({key, options}); done(null, 'name');}};
        callback(null, collection);
        return Q(collection);
    };
    await Model.ensureIndexes([index], true);
    await Model.ensureIndexes([index], false);
    assert.deepEqual(index.key, {name: 1});
    assert.equal(index.background, undefined);
    assert.equal(seen[0].options.background, true);
    assert.equal(seen[1].options.background, false);
});

test('collection-existence checks nodeify success and errors exactly once', async () => {
    const Model = BaseModel.extend({}, {collectionName: 'test', dbName: 'test'});
    Model.db = () => ({listCollections() {return {async toArray() {return [];}};}});
    assert.deepEqual(await Model.indexes(), []);
    let calls = 0;
    await new Promise(resolve => Model.indexes((error, value) => {
        calls++;
        assert.equal(error, null);
        assert.deepEqual(value, []);
        resolve();
    }));
    assert.equal(calls, 1);
    Model.db = () => ({listCollections() {return {async toArray() {throw new Error('not authorized');}};}});
    await new Promise(resolve => Model.indexes(error => {
        calls++;
        assert.match(error.message, /not authorized/);
        resolve();
    }));
    assert.equal(calls, 2);
    Model.db = () => {throw new Error('missing connection');};
    await new Promise(resolve => Model.indexes(error => {
        calls++;
        assert.match(error.message, /missing connection/);
        resolve();
    }));
    assert.equal(calls, 3);
});

test('disabled models return settled promises even when ensuring indexes', async () => {
    const Model = BaseModel.extend({}, {disabled: true});
    assert.equal(typeof Model.ensureIndexes([]).then, 'function');
    assert.equal(await Model.ensureAllIndexes(), undefined);
    assert.equal(await Model.indexes(), undefined);
});
