var _ = require('lodash'),
    path = require('path'),
    stellarPay = require("stellar-pay"),
    toDS = stellarPay.toDS,
    fromDS = stellarPay.fromDS,
    BigDecimal = require('bigdecimal').BigDecimal,
    crypto = require("crypto"),
    pgo = require('pg-orm'),
    Model = pgo.Model,
    tx = pgo.tx,
    config = require(path.resolve("config/config")),
    log = require('tracer').colorConsole();

var moduleName = "stellarpay"

class StellarAccount extends Model {
    constructor(data) {
        super(data)
    }

    getFederationAddress() {
        return `${this.name}*${config.app.domain}`
    }
}
StellarAccount.structure = [
    ["user", { "type": "foreignKey", "target": "User", "targetModule": "user", unique:true, noUpdate: true }],
    ["name", { "type": "string", "maxLength": 100, unique: true }],
    ["address", { "type": "string", "maxLength": 120, optional: true }],
    ["balance", { "type": "long", default: 0 }]
]

class StellarTransaction extends Model {
    constructor(data) {
        super(data)
    }
}
StellarTransaction.structure = [
    ["user", { "type": "foreignKey", "target": "User", "targetModule": "user", noUpdate: true, optional: true }],
    ["amount", { "type": "string", "maxLength": 12 }],
    ["transactionId", { "type": "string", "maxLength": 120, unique: true}],
    ["peer", { "type": "string", "maxLength": 120}],
    ["isIncoming", { "type": "boolean", "default":true }],
    ["memo", { "type": "string", "maxLength": 60, optional:true}],
    ["asset", { "type": "string", "maxLength": 10, optional: true }]
]


class StellarTransactionSummary extends Model {
    constructor(data) {
        super(data)
    }
}
StellarTransactionSummary.structure = [
    ["name", { "type": "string", "maxLength": 20, unique: true }],
    ["lastTransactionId", { "type": "string", "maxLength": 120, optional: true}]
]

pgo.registerModel(StellarAccount, moduleName)
pgo.registerModel(StellarTransaction, moduleName)
pgo.registerModel(StellarTransactionSummary, moduleName)

module.exports.init = function() {
    // pgo.registerModel(StellarAccount, moduleName)
    // pgo.registerModel(StellarTransaction, moduleName)
    // pgo.registerModel(StellarTransactionSummary, moduleName)
}

class StellarAccountListener {
    constructor(stellarServer, address) {
        this.stellarServer = stellarServer
        this.address = address
    }

    async init() {
        console.log("start init")
        let summary = await StellarTransactionSummary.objects.get({})
        if (!summary) {
            summary = await StellarTransactionSummary.objects.create({ "name": "main" })
        }
        this.summary = summary
        console.log("finish init")
    }

    async process() {
        if (!this.summary) {
            throw new Error("Not initialized")
        }

        let User = pgo.model("User")

        let txs = await this.stellarServer.listIncomingTransactions(this.address, this.summary.lastTransactionId)
        if (!txs || txs.length == 0) {
            return
        }

        let acctTxMap = new Map()
        let acctSumMap = new Map()
        let allTxs = []

        let lastTx
        for (let t of txs) {
            if (!lastTx) {
                lastTx = t
            }

            t.isIncoming = true
            t.peer = t.source

            allTxs.push(t)
            let memo = t.memo
            let sum = acctSumMap.get(memo)
            if (undefined===sum) {
                sum = 0
            }
            acctSumMap.set(memo, sum+toDS(t.amount))

            if (acctTxMap.has(memo)) {
                acctTxMap.get(memo).push(t)
            } else {
                acctTxMap.set(memo, [t])
            }
        }

        let acctIds = Array.from(acctTxMap.keys())
        let users = await User.objects.filter({"accountId__in": acctIds})
        let userAcctMap = new Map()
        let uids = []
        for (let user of users) {
            userAcctMap.set(user.id, user.accountId)
            uids.push(user.id)
            let txs2 = acctTxMap.get(user.accountId)
            for (let t of txs2) {
                t.user = user
            }
        }

        log.info("sum map")
        console.dir(acctSumMap)
        console.dir(userAcctMap)

        await tx(async client => {
            await StellarTransaction.objects.create(allTxs, client)

            if (uids.length > 0) {
                let sas = await StellarAccount.objects.filter({"user__in":uids, lock:true}, client)
                for (let sa of sas) {
                    let sum = acctSumMap.get(userAcctMap.get(sa.user))
                    log.info("sum for u="+sa.user + " sum="+sum)
                    sa.balance += sum
                    await sa.save(client)
                }
            }

            this.summary.lastTransactionId = lastTx.transactionId
            await this.summary.save(client)
        })

    }
}

module.exports.StellarAccountListener = StellarAccountListener

module.exports.federation = require("./stellarFederation")