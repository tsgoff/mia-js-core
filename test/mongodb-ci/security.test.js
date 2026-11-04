const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {MongoClient} = require('mongodb');
const {setTimeout: sleep} = require('node:timers/promises');
const Shared = require('../../lib/shared');
const BaseModel = require('../../lib/baseModel');
const MongoAdapter = require('../../lib/dbAdapters').MongoAdapter;

if (process.env.MIA_TEST_DOCKER !== '1') throw new Error('Requires explicit disposable Docker test opt-in');
const url = 'mongodb://mia-ci:disposable-ci-password@127.0.0.1:27032/miaCoreTest?authSource=admin';
const options = {tls: true, tlsCAFile: path.resolve('.ci-mongo-tls/ca.crt'), serverSelectionTimeoutMS: 2000};

test('authenticated TLS through the Mia adapter supports indexes, CRUD, BSON and callbacks', {timeout: 90000}, async t => {
    t.mock.method(Shared, 'config', key => key.endsWith('.url') ? url : options);
    const adapter = new MongoAdapter();
    let db;
    for (let attempt = 0; ; attempt++) {
        try {db = await adapter.connect('security'); break;}
        catch (error) {if (attempt === 20) throw error; await sleep(500);}
    }
    const client = Shared.dbconnection('security').client;
    t.after(async () => {try {await db.dropDatabase();} finally {await client.close();}});
    const Model = BaseModel.extend({}, {dbName: 'security', collectionName: 'secureAdapter', identity: 'SecureAdapter'});
    await Model.ensureIndexes([{key: {name: 1}, unique: true, name: 'name'}]);
    const inserted = await Model.insertOne({name: 'TLS', value: 1});
    assert.ok(inserted.ops[0]._id.equals(inserted.insertedId));
    await new Promise((resolve, reject) => Model.findOneAndUpdate({_id: inserted.insertedId}, {$inc: {value: 1}},
        {returnDocument: 'after'}, (error, result) => {
            if (error) return reject(error);
            try {assert.equal(result.value.value, 2); resolve();} catch (error) {reject(error);}
        }));
    assert.equal((await Model.deleteOne({_id: inserted.insertedId})).result.n, 1);
});

test('wrong password is rejected instead of silently connecting', {timeout: 15000}, async () => {
    const client = new MongoClient(url.replace('disposable-ci-password', 'wrong-password'), options);
    try {await assert.rejects(client.connect(), error => error.code === 18);}
    finally {await client.close();}
});

test('TLS rejects an untrusted server certificate without insecure bypass flags', {timeout: 15000}, async () => {
    const client = new MongoClient(url, {tls: true, serverSelectionTimeoutMS: 2000});
    try {await assert.rejects(client.connect(), /certificate|self.signed|issuer/i);}
    finally {await client.close();}
});
