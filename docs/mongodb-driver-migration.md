# MongoDB driver migration (Node 24)

This branch upgrades `mongodb` from 3.7.3 to **7.8.0** and pins the direct
`bson` dependency to **7.3.2**, matching the driver's BSON implementation.
The fork targets Node **24.x** and npm **11+**. The package version remains
2.9.13 until a separate release is agreed; do not publish this as the existing
upstream 2.9.13 release.

## Compatibility boundary

`lib/dbAdapters/lib/mongoCompatibility.js` wraps collections returned by
**BaseModel.collection()**, their cursors and bulk builders. Native driver
objects and global prototypes are not patched.

- BaseModel retains Q promises (`.fail()`, `.nodeify()`) and optional callbacks.
- Collection operations also support callbacks through the wrapper.
- Cursors retain chaining, native iteration and callback `next`, `toArray`,
  `hasNext`, `tryNext`, `close`, `explain` and `forEach` completion.
- `findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete` default to metadata
  (`.value`, `.ok`, `.lastErrorObject`). Explicit `includeResultMetadata: false`
  opts into the modern document-only result. `returnOriginal` is translated to
  `returnDocument` without mutating options.
- Acknowledged inserts provide `.ops` and `.insertedCount`. Updates/deletes
  retain modern counts and add `.result.ok`, `.result.n`, `.result.nModified`
  where applicable. Unacknowledged writes do not fabricate counts or documents;
  their compatibility `.result.ok` is 0.
- Ordered/unordered bulk builders retain callback `execute`, fluent chains,
  and legacy count aliases such as `.nInserted`. Partial error results retain
  these aliases and the driver's error-inspection methods.
- `MongoObjectID` (and `MongoObjectId`) construct genuine driver BSON ObjectIds,
  both with and without `new`. Static methods and `instanceof` are preserved.
  Modern validation remains in force: this does not restore arbitrary 12-byte
  string or numeric constructor inputs removed by newer BSON versions.
- Index creation copies specifications instead of deleting their `key` fields.
- `distinct` retains driver-3.x behavior by ignoring `hint` in the compatibility
  wrapper. Driver 7 sends these hints (unsupported on some older servers and
  rejected for absent indexes), while 3.7 did not. Native DB collections keep
  modern hint support; enabling it for Mia callers requires a separate change.
- `stats` and `mapReduce` use public `Db.command` because the collection methods
  were removed from the driver. Map-reduce remains deprecated on the server;
  inline/collection outputs and the legacy verbose shapes are retained. Server
  JavaScript must be enabled. Prefer aggregation for new code.

### Cursor counts

The migration preserves the driver-3.x distinction used by Middleware:
`await cursor.count()` counts the **full query**, whereas `count(true)` applies
cursor skip/limit. `count(callback)` also applies skip/limit, as in the old
driver. Counts do not consume the cursor. The wrapper tracks public `filter`,
`skip`, `limit`, `hint`, `maxTimeMS`, `collation`, `withReadPreference` and clones.
It uses the server count command to preserve legacy query/count semantics;
use BaseModel.count / native countDocuments for new code.

### Connection settings

`poolSize` maps to `maxPoolSize` (an explicit modern value wins).
`keepAlive`, `keepAliveInitialDelay`, `useNewUrlParser`, `useUnifiedTopology`
and `bufferMaxEntries` are removed before connecting. TCP keepalive and the
modern topology implementation are always enabled by the driver.

**bufferMaxEntries has no exact modern equivalent.** In particular, setting it
to zero does not guarantee the old offline-queue behavior. Review explicit
`serverSelectionTimeoutMS`/`waitQueueTimeoutMS` and outage behavior before rollout.
Other unknown options are not silently removed; the driver rejects them.
Read preferences, replica-set names and write concerns are retained.

Database selection uses public `client.db()` and the URI/options database name;
the logical Mia connection identifier is retained for registration. No private
`client.s` fields are used by the framework.

## Tests

```sh
npm ci
npm run test:mongo-unit
# WARNING: the suite drops its test DB. Use only an isolated local server.
MONGODBURL_MIA_CORE_TEST=mongodb://127.0.0.1:27017/miaCoreTest \
  MIA_TEST_INIT_REPLICA_SET=1 npm run test:mongo-integration
```

The integration launcher rejects non-loopback targets and databases other than
`miaCoreTest`. Start the disposable server with `--replSet mia-test` when using
replica-set initialization. The historical `npm test` entry point is unchanged
and does not itself perform the launcher's target validation.

GitHub Actions defines Node 24 tests against disposable MongoDB **4.4, 5.0,
6.0, 7.0 and 8.0** replica sets. The older versions are migration baselines,
not recommendations for continued production operation. This matrix is not
considered verified until its runs actually succeed.

Additional jobs test Node 24 Debian/Alpine on x86_64 and ARM64 against MongoDB
8.0, authenticated CRUD/indexes with verified TLS (including rejection of bad
credentials and untrusted certificates), and a disposable three-member replica
set: atomic lock contention, primary step-down, bounded outage errors and writes
after restarting all members. These jobs require Docker; test mutation targets
are fixed loopback ports with explicitly opted-in disposable containers.

CI uses Ubuntu 22 runners (kernel 6.8), because the first run found MongoDB 8
refuses startup on the Ubuntu 24 runner's kernel 7.0 / >=6.19
([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). No startup
guard is bypassed. ARM64 Node containers run via QEMU on x86_64 against the
MongoDB 8 server; this validates ARM64 userspace, **not native ARM64 server/CPU
behavior**. A native ARM64 deployment smoke test remains required.

The first Actions run passed MongoDB 4.4, 5.0, 6.0 and 7.0. MongoDB-8-based
jobs failed before testing because of that kernel incompatibility; the corrected
workflow must pass before claiming the complete CI matrix is verified.

The private Middleware repository is **not** cloned into this public fork's
workflow. Its 375-spec application suite remains a separate consumer check;
no private fixtures, credentials or repository tokens are published here.

### Locally verified (2026-11-04)

- Node **24.22.1**, macOS ARM64, `mongodb@7.8.0` / `bson@7.3.2`.
- Focused compatibility unit tests: **28 tests, 0 failures**.
- Framework suite: **130 specs, 0 failures** on disposable single-member replica
  sets with MongoDB Community **7.0.16** and **8.0.34** (121 existing specs plus
  9 new integration regressions).
- Middleware suite: **375 specs, 0 failures, 27 pre-existing pending specs**
  with the fork redirected only in the test process, MongoDB **8.0.34** and Redis
  **7.4.2**. The local network guard blocked external service connections.
- Clean lockfile install with `npm ci --ignore-scripts` succeeded. Native
  dependencies were rebuilt for the separate local framework test checkout.
- No MongoDB/BSON-chain advisory was reported by `npm audit --omit=dev`.
  The rest of this old framework still has **59 production dependency findings**
  (9 critical, 34 high, 11 moderate, 5 low); this is not a full security cleanup.

MongoDB 4.4/5.0/6.0, Linux/Alpine, authenticated/TLS connections and failover
have **not** been validated locally. Pending Middleware specs do not certify
their corresponding external integrations.

## Consumer and rollout checklist

1. Test against isolated MongoDB 4.4 as the current-server baseline, including
   authentication, indexes, representative Middleware APIs and cron workloads.
2. Validate the Linux/Alpine deployment runtime and ARM64 environment; local
   macOS results are not a substitute for the production image.
3. Switch Middleware to an immutable fork commit/release only in a separate
   application change. Do not overwrite installed `node_modules` manually.
4. Middleware also declares its own devDependency `mongodb@3.7.3`. Direct
   `require('mongodb')` calls do **not** pass through this compatibility layer.
   Keep the test-init/retirement scripts separate from the framework migration
   or modernize them explicitly, including their connection options.
5. Direct `Shared.dbconnection(...).db`, clients and change streams remain
   modern native objects, not general-purpose legacy callback wrappers. Review
   direct access and BSON objects originating from another driver major.
6. Test authentication/TLS, reconnects, primary elections, concurrency and
   representative query results/latency before promoting the client.
7. Server binaries, FCV, backups and infrastructure are a **separate migration**.
   For existing 4.4 datafiles rehearse the sequential major upgrades and restore
   procedure; a green driver suite does not authorize or certify an upgrade.

This branch changes neither Middleware's dependency nor any deployed database,
FCV, infrastructure or retired integration code.
