// This suite drops its test database. Refuse non-loopback or non-test targets.
const {MongoClient} = require('mongodb');
const {spawnSync} = require('node:child_process');
const uri = process.env.MONGODBURL_MIA_CORE_TEST;
if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/miaCoreTest(?:\?|$)/.test(uri)) {
    throw new Error('Set MONGODBURL_MIA_CORE_TEST to a loopback URL with database miaCoreTest');
}

async function main() {
    const client = new MongoClient(uri, {directConnection: true, serverSelectionTimeoutMS: 1000});
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                await client.connect();
                await client.db('admin').command({ping: 1});
                break;
            } catch (error) {
                if (attempt >= 60) throw error;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        if (process.env.MIA_TEST_INIT_REPLICA_SET === '1') {
            const port = new URL(uri).port;
            try {
                await client.db('admin').command({replSetInitiate: {_id: 'mia-test', members: [{_id: 0, host: '127.0.0.1:' + port}]}});
            } catch (error) {
                if (error.codeName !== 'AlreadyInitialized') throw error;
            }
            for (let attempt = 0; ; attempt++) {
                // isMaster also works on older 4.4 patch levels without hello.
                const hello = await client.db('admin').command({isMaster: 1});
                if (hello.ismaster) break;
                if (attempt >= 60) throw new Error('Test replica set did not elect a primary');
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        const build = await client.db('admin').command({buildInfo: 1});
        console.log('Isolated test server:', build.version, 'Node:', process.version);
    } finally {
        await client.close();
    }
    const result = spawnSync(process.execPath, ['runTests.js'], {stdio: 'inherit', env: process.env});
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
}

main().catch(error => {console.error(error); process.exitCode = 1;});
