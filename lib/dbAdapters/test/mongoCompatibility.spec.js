const Q = require('q');
const BaseModel = require('../../baseModel');
const Model = BaseModel.extend({}, {collectionName: 'mongoCompatibilityRegression', identity: 'MongoCompatibilityRegression'});

describe('modern MongoDB compatibility regressions', function () {
    beforeAll(function (done) {
        jasmine.database.connect().then(() => Model.drop()).then(() => done(), done.fail);
    });
    afterAll(function (done) {
        Model.drop().then(() => jasmine.database.close()).then(() => done(), done.fail);
    });
    beforeEach(function (done) {
        Model.drop().then(() => done(), done.fail);
    });

    it('counts full and paginated queries without consuming a cursor', function (done) {
        Model.insertMany([{group: 1}, {group: 1}, {group: 1}, {group: 2}])
            .then(() => Model.find({group: 1}, {skip: 1, limit: 1}))
            .then(async cursor => {
                expect(await cursor.count()).toBe(3);
                expect(await cursor.count(true)).toBe(1);
                expect(await Q.ninvoke(cursor, 'count', false)).toBe(3);
                expect((await Q.ninvoke(cursor, 'toArray')).length).toBe(1);
            }).then(() => done(), done.fail);
    });

    it('supports cursor next callbacks after fluent sort and limit', function (done) {
        Model.insertMany([{order: 2}, {order: 1}])
            .then(() => Model.find({}))
            .then(cursor => Q.ninvoke(cursor.sort({order: 1}).limit(1), 'next'))
            .then(doc => expect(doc.order).toBe(1))
            .then(() => done(), done.fail);
    });

    it('keeps metadata/value defaults for a missing findOneAnd result', function (done) {
        Model.findOneAndUpdate({_id: 'missing'}, {$set: {name: 'test'}})
            .then(result => {
                expect(result.ok).toBe(1);
                expect(result.value).toBeNull();
                return Model.findOneAndDelete({_id: 'missing'}, {includeResultMetadata: false});
            }).then(result => expect(result).toBeNull())
            .then(() => done(), done.fail);
    });

    it('translates returnOriginal without modifying the caller options', function (done) {
        const options = {returnOriginal: false};
        Model.insertOne({_id: 'item', name: 'before'})
            .then(() => Model.findOneAndUpdate({_id: 'item'}, {$set: {name: 'after'}}, options))
            .then(result => {
                expect(result.value.name).toBe('after');
                expect(options).toEqual({returnOriginal: false});
            }).then(() => done(), done.fail);
    });

    it('provides ops and nested write counts for upserts and zero-match updates', function (done) {
        Model.insertOne({state: 'active'}).then(result => {
            expect(result.ops[0]._id.equals(result.insertedId)).toBeTruthy();
            return Model.updateOne({_id: 'upserted'}, {$set: {state: 'new'}}, {upsert: true});
        }).then(result => {
            expect(result.result.n).toBe(1);
            expect(result.result.nModified).toBe(0);
            expect(result.result.upserted[0]._id).toBe('upserted');
            return Model.updateMany({_id: 'missing'}, {$set: {state: 'new'}});
        }).then(result => {
            expect(result.result.n).toBe(0);
            expect(result.result.nModified).toBe(0);
        }).then(() => done(), done.fail);
    });

    it('does not reinterpret application documents as write results', function (done) {
        Model.insertOne({_id: 'item', acknowledged: true, result: 'user data'})
            .then(() => Model.findOne({_id: 'item'}))
            .then(doc => expect(doc.result).toBe('user data'))
            .then(() => done(), done.fail);
    });

    it('retains partial bulk error counts and duplicate key errors', function (done) {
        Model.bulkWrite([
            {insertOne: {document: {_id: 'duplicate'}}},
            {insertOne: {document: {_id: 'duplicate'}}}
        ]).then(() => done.fail('expected duplicate-key rejection'), error => {
            expect(error.code).toBe(11000);
            expect(error.result.nInserted).toBe(1);
            expect(error.result.hasWriteErrors()).toBeTruthy();
            done();
        });
    });

    it('supports callable Mia ObjectIDs used by DMS and Livingdocs', function (done) {
        const ObjectID = require('..').MongoObjectID;
        Model.insertOne({name: 'callable-id'})
            .then(result => Model.findOne({_id: ObjectID(result.insertedId.toHexString())}))
            .then(doc => expect(doc.name).toBe('callable-id'))
            .then(() => done(), done.fail);
    });

    it('retains distinct behavior when legacy callers specify an ignored hint', function (done) {
        Model.insertMany([{group: 1}, {group: 2}])
            .then(() => Model.distinct('group', {}, {hint: {missingIndex: 1}}))
            .then(groups => expect(groups).toEqual([1, 2]))
            .then(() => done(), done.fail);
    });
});
