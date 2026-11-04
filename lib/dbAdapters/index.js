module.exports.MongoAdapter = require('./lib/mongoAdapter.js');
// Keep the historical Mia.js export, backed by the driver's BSON implementation.
// Older consumers also call ObjectID(hex) without `new`. The proxy creates a
// genuine modern BSON ObjectId while keeping its prototype and static methods.
module.exports.MongoObjectID = new Proxy(require('mongodb').ObjectId, {
    apply: function (ObjectId, receiver, args) {
        return new ObjectId(...args);
    }
});
module.exports.MongoObjectId = module.exports.MongoObjectID;
