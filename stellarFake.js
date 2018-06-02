'use strict';

var _ = require('lodash'),
    path = require('path'),
    StellarSdk = require('stellar-sdk'),
    StrKey = require('stellar-sdk').StrKey,
    StellarBase = require('stellar-base'),
    BigDecimal = require('bigdecimal').BigDecimal,
    crypto = require("crypto"),
    // optional = require("optional"),
    pgo = require('pg-orm'),
    request = require('request'),
    log = require('tracer').colorConsole();

var Model = Object
if (pgo) {
    Model = pgo.Model;
}

class FakeStellarAccount {
    constructor(info, server, trustedIssuers) {
        this.server = server
        this.address = info.address
        this.seed = info.seed
        this.trustedIssuers = trustedIssuers

        if (!this.address) {
            throw new Error("no address")
        }
    }

    async createAccount(destination, amount, memo) {
        return this.sendPayment(destination, amount, memo)
    }

    async sendPayment(destination, amount, memo, asset) {
        var transactionId = getTransactionId()
        var data = {
            source: this.address,
            destination: destination,
            amount: amount,
            memo: memo,
            transactionId: transactionId,
            asset: asset
        }
        // log.info(`inserting collection`)
        // console.dir(data)
        let tx = await FakeTransaction.objects.create(data)
        // log.info(`created transaction`)
        // console.dir(tx)
        return [transactionId, null]
    }

    async getTransaction(transactionId, matchSpec) {
        if (transactionId == ("seed".repeat(10))) {
            return {
                transactionId: "fake" + crypto.randomBytes(8).toString('hex'),
                destination: "fake",
                memo: "fake",
                amount: "100",
                asset: "WIN",
                isFake:true
            }
        }

        log.info(`getting transaction` + transactionId)
        var transaction = await FakeTransaction.objects.get({ "transactionId": transactionId })
        if (null == transaction) {
            log.error("no transaction found:"+transactionId)
            return
        }

        if (matchSpec) {
            if (matchSpec.memo && transaction.memo != matchSpec.memo) {
                console.log("memo mismatch")
                console.dir(matchSpec)
                console.dir(transaction)
                return null
            }
        }

        return transaction
    }
}

function FakeServer() {
    this.mockTxs = []
}

module.exports.FakeServer = FakeServer

FakeServer.prototype.getAccount = function (info, trustedIssuers) {
    return new FakeStellarAccount(info, this.server, trustedIssuers)
}

function getTransactionId() {
    return crypto.randomBytes(8).toString('hex');
}

FakeServer.prototype.mockTx = function (tx) {
    // console.log("mocking tx")
    // console.dir(tx)
    tx.transactionId = getTransactionId()
    this.mockTxs.push(tx)
}

FakeServer.prototype.listIncomingTransactions = async function (account, last) {
    let m = this.mockTxs
    this.mockTxs = []
    return m
}

FakeServer.prototype.getBalance = async function (address) {
    let txs = await FakeTransaction.objects.filter({ destination: address })
    let sum = 0
    for (let tx of txs) {
        sum += +tx.amount
    }
    return `${sum}`
}

FakeServer.prototype.createAccount = async function () {
    var pair = StellarSdk.Keypair.random();
    return [pair.secret(), pair.publicKey()]
}

FakeServer.prototype.getTransaction = async function (transactionId) {
    log.info(`getting transaction` + transactionId)
    var transaction = await FakeTransaction.objects.get({ "transactionId": transactionId })
    log.info(`got transaction`)
    console.dir(transaction)
    return transaction
}

FakeServer.prototype.sendPayment = async function (wallet, destination, amount, memo, asset) {
    var transactionId = getTransactionId()
    var data = {
        source: wallet.address,
        destination: destination,
        amount: amount,
        memo: memo,
        transactionId: transactionId,
        asset: asset
    }
    log.info(`inserting collection`)
    console.dir(data)
    let tx = await FakeTransaction.objects.create(data)
    log.info(`created transaction`)
    console.dir(tx)
    return [transactionId, null]
}


FakeServer.prototype.postTransaction = async function (data) {
    if (data.constructor == TransactionBuilder) {
        data = data.build()
    }

    if (!data.transactionId) {
        var transactionId = getTransactionId()
        data.transactionId = transactionId
    }

    data.ignoreConflict = true
    await FakeTransaction.objects.create(data)
    return transactionId
}

class FakeTransaction extends Model {

}

FakeTransaction.structure = [
    ["transactionId", { "type": "string", "maxLength": 40, "unique": true }],
    ["amount", { "type": "string", "maxLength": 20 }],
    ["source", { "type": "string", "maxLength": 60 }],
    ["destination", { "type": "string", "maxLength": 60 }],
    ["memo", { "type": "string", "maxLength": 60, "optional": true }],
    ["asset", { "type": "string", "maxLength": 10, "optional": true }]
]

var moduleName = "stellarpay"

log.info(`Registry model for fake transaction:` + pgo)
if (pgo) {
    console.log("the registry")
    pgo.registerModel(FakeTransaction, moduleName)
}

module.exports.registerModels = function() {
    pgo.registerModel(FakeTransaction, moduleName)
}