const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {setTimeout: sleep} = require('node:timers/promises');
const {MongoClient} = require('mongodb');
const Shared = require('../../lib/shared');
const BaseModel = require('../../lib/baseModel');
const MongoAdapter = require('../../lib/dbAdapters').MongoAdapter;

if (process.env.MIA_TEST_DOCKER !== '1') throw new Error('Requires explicit disposable Docker test opt-in');
const ports = [27033, 27034, 27035];
const names = ports.map(port => 'mia-resilience-' + port);
const url = 'mongodb://' + ports.map(port => '127.0.0.1:' + port).join(',') + '/miaCoreTest?replicaSet=mia-resilience';

function docker(args) {
    const result = spawnSync('docker', args, {encoding: 'utf8', timeout: 90000});
    if (result.status !== 0) throw new Error('Docker ' + args[0] + ' failed: ' + result.stderr);
    return result.stdout;
}

async function eventually(operation, timeout = 60000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {return await operation();}
        catch (error) {if (Date.now() >= deadline) throw error; await sleep(500);}
    }
}

async function primary() {
    const client = new MongoClient(url, {serverSelectionTimeoutMS: 2000});
    try {
        await client.connect();
        const host = (await client.db('admin').command({hello: 1})).primary;
        assert.ok(host, 'replica set must have a primary');
        return host;
    }
    finally {await client.close();}
}

test('Mia writes survive primary election and full outage/restart, without losing atomic locks', {timeout: 240000}, async t => {
    // The host-network replica members are advertised on loopback, never externally.
    const started = [];
    t.after(() => {
        for (const name of started) {
            const logs = spawnSync('docker', ['logs', '--tail', '30', name], {encoding: 'utf8'});
            if (t.signal.aborted) console.error(logs.stdout, logs.stderr);
            spawnSync('docker', ['rm', '--force', '--volumes', name], {encoding: 'utf8'});
        }
    });
    for (let i = 0; i < ports.length; i++) {
        docker(['run', '--detach', '--name', names[i], '--network', 'host', 'mongo:8.0',
            '--replSet', 'mia-resilience', '--bind_ip', '127.0.0.1', '--port', String(ports[i])]);
        started.push(names[i]);
    }
    const bootstrap = new MongoClient('mongodb://127.0.0.1:27033/admin', {directConnection: true, serverSelectionTimeoutMS: 1000});
    try {
        await eventually(() => bootstrap.connect());
        await bootstrap.db('admin').command({replSetInitiate: {_id: 'mia-resilience',
            members: ports.map((port, i) => ({_id: i, host: '127.0.0.1:' + port}))}});
    } finally {await bootstrap.close();}
    await eventually(primary);
    const options = {serverSelectionTimeoutMS: 2000, writeConcern: {w: 'majority', wtimeoutMS: 5000}};
    t.mock.method(Shared, 'config', key => key.endsWith('.url') ? url : options);
    const adapter = new MongoAdapter();
    const db = await adapter.connect('resilience');
    const client = Shared.dbconnection('resilience').client;
    t.after(() => client.close());
    const Model = BaseModel.extend({}, {dbName: 'resilience', collectionName: 'locks', identity: 'ResilienceLocks'});
    await Model.insertOne({_id: 'lock', owner: null, value: 0});
    const attempts = await Promise.all(Array.from({length: 20}, (_, owner) =>
        Model.findOneAndUpdate({_id: 'lock', owner: null}, {$set: {owner}}, {returnDocument: 'after'})));
    assert.equal(attempts.filter(result => result.value !== null).length, 1);
    const before = await primary();
    const direct = new MongoClient('mongodb://' + before + '/admin', {directConnection: true, serverSelectionTimeoutMS: 2000});
    try {
        await direct.connect();
        try {await direct.db('admin').command({replSetStepDown: 20, force: true});}
        catch (error) {if (!/network|connection|closed/i.test(error.name + error.message)) throw error;}
    } finally {await direct.close();}
    await eventually(async () => {assert.notEqual(await primary(), before);});
    await eventually(() => Model.updateOne({_id: 'lock'}, {$set: {value: 2}}));
    assert.equal((await Model.findOne({_id: 'lock'})).value, 2);
    docker(['stop', '--time', '10', ...names]);
    const began = Date.now();
    await assert.rejects(Model.findOne({_id: 'lock'}));
    assert.ok(Date.now() - began < 15000, 'outage read must fail within the configured timeout');
    docker(['start', ...names]);
    await eventually(() => Model.updateOne({_id: 'lock'}, {$set: {value: 3}}));
    assert.equal((await Model.findOne({_id: 'lock'})).value, 3);
    await db.dropDatabase();
});
