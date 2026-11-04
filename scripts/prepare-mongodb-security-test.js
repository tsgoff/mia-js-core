// Bootstrap only the disposable CI server, never a deployed database.
const {MongoClient} = require('mongodb');
const {setTimeout: sleep} = require('node:timers/promises');

async function main() {
    const client = new MongoClient('mongodb://127.0.0.1:27032/admin', {serverSelectionTimeoutMS: 1000});
    try {
        for (let attempt = 0; ; attempt++) {
            try {await client.connect(); break;}
            catch (error) {if (attempt === 60) throw error; await sleep(500);}
        }
        await client.db('admin').command({createUser: 'mia-ci', pwd: 'disposable-ci-password', roles: ['root']});
        console.log('Disposable CI user created');
    } finally {await client.close();}
}

if (process.env.MIA_TEST_DOCKER !== '1') throw new Error('Requires explicit disposable Docker test opt-in');
main().catch(error => {console.error(error); process.exitCode = 1;});
