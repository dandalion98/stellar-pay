var stellarPay = require("./stellarPay"),
    log = require('tracer').colorConsole(),
    StellarSdk = require('stellar-sdk'),
    util = require('util'),
    StellarAssets = require("./stellarAssets").StellarAssets,
    exec = util.promisify(require('child_process').exec);

var stellarServer, WALLET_FILE, assets;
if (process.env.LIVE == "1") {
    log.info(`using live server`)
    stellarServer = stellarPay.liveServer()
    WALLET_FILE = "./wallets_live.json"
    assets = StellarAssets.getLive()
} else {
    log.info(`using test server`)
    stellarServer = stellarPay.testServer()
    WALLET_FILE = "./wallets.json"
    assets = StellarAssets.getTest()    
}

var wallets = require(WALLET_FILE)

let winAsset = new StellarSdk.Asset('WIN', "GCNHYZLBCSVZHSQJ2DOIBHYBF4J24DJYGS5QKURX4AGSLBK6SDJOYWIN");
let nativeAsset = StellarSdk.Asset.native()

let asset
if (process.env.WIN == "1") {
    asset = winAsset
    stellarServer.asset = asset
}

class Wallet {
    constructor(data) {
        this.seed = data.seed
        this.address = data.address
    }

    getDescription() {
        return this.address
    }

    async sendPayment(receiver, value) {
        await stellarServer.sendPayment(this.address, receiver, value)
        return
    }

    async getTransactions() {
        console.log("listing transactions for " + this.address)
        let transactions = await stellarServer.server.transactions().forAccount(this.address).order('desc').limit(25).call()
        for (let record of transactions.records) {
            let memo = record.memo
            let data = new StellarSdk.Transaction(record.envelope_xdr)
            // console.dir(data.operations[0])
            let firstOperation = data.operations[0]
            let destination = firstOperation.destination
            let amount, assetType
            if (firstOperation.type == "payment") {
                amount = firstOperation.amount
                assetType = firstOperation.asset.code
            } else if (firstOperation.type == "pathPayment") {
                console.dir(firstOperation)
            }
            log.info(`data type=${firstOperation.type} memo=${memo} dest=${destination} amt=${amount} asset=${assetType}`)
        }
        // console.dir(transactions)
    }
}

let arguments = process.argv
let walletName = arguments[2]
let operation = arguments[3]

if (!walletName) {
    throw new Error("wallet name is required")
}

if (!operation) {
    throw new Error("operation is required")
}

let operationMap = {
    "create": create,
    "balance": balance,
    "send": send,    
    "pay": pay,
    "send": send,
    "info": info,
    "tx": tx,
    "encode": encode,
    "trust": trustAsset,
    "issue": issueAsset,
    "offer": createOffer,
    "offerdel": deleteOffer,
    "pathxlm": pathToNative,
    "pathwin": pathToWin,
    "test": test,
    "clearOffers": clearOffers,
    "domain": setDomain
}

let method = operationMap[operation]
if (method) {
    try {
        method(walletName, ...arguments.slice(4));
    } catch (error) {
        log.error(error)
    }
} else {
    console.dir(arguments)
    let method = arguments[2]
    log.info("m="+method)
    if (method == "help") {
        for (let k in operationMap) {
            console.log(k)
        }
    } else if (method=="xdr") {
        console.dir(JSON.stringify(StellarSdk.xdr.TransactionEnvelope.fromXDR(arguments[3])));
    }
    else {
        throw new Error("op does not exist:" + operation)
    }
}

async function info(walletName) {
    if (!wallets[walletName]) {
        throw new Error("wallet not found:" + walletName)
    }

    let wallet = new Wallet(wallets[walletName])
    console.log(wallet.address)
    console.log(wallet.seed)
}

async function tx(walletName) {
    try {
        if (!wallets[walletName]) {
            throw new Error("wallet not found:" + walletName)
        }

        let wallet = wallets[walletName]
        let a = stellarServer.getAccount(wallet)
        let txs = await a.listIncomingTransactions()
        for (let t of txs) {
            console.dir(t)
        }

        // let wallet = new Wallet(wallets[walletName])
        // await wallet.getTransactions()
    } catch (error) {
        console.log(error)
    }
}

async function create(name) {
    if (wallets[name]) {
        throw new Error("already exist: " + name)
    }

    [seed, address] = await stellarServer.createAccount()
    wallets[name] = { "seed": seed, "address": address }
    var fs = require('fs');
    var json = JSON.stringify(wallets, null, 4);
    fs.writeFileSync(WALLET_FILE, json, 'utf8');
}

async function balance(name) {
    let account = stellarServer.getAccount(wallets[name])
    let balance = await account.getBalance()
    console.dir(balance)
}

async function send(name, destination, amount, assetName) {
    let asset = assets.get(assetName)
    log.info(`sending ${amount} ${assetName} to ${destination}`)

    let account = stellarServer.getAccount(wallets[name])
    let transactionId = await account.sendPayment(wallets[destination].address, amount, null, asset)
    console.log(transactionId)
    return null
}

async function pay(name, destination, amount, memo, asset) {
    // let arguments = process.argv
    // console.dir(arguments)
    // let destination=arguments[4]
    // let amount=arguments[5]
    // let memo=arguments[6]
    log.info(`amount` + amount + " destination" + destination)
    let account = stellarServer.getAccount(wallets[name])
    let transactionId = await account.sendPayment(wallets[destination].address, amount, memo, asset)
    // let transactionId = await stellarServer.sendPayment(wallets[name], wallets[destination].address, amount, memo, asset)
    console.log(transactionId)
    return null
}

async function issueAsset(name, amount) {
    amount = amount || "1000"
    let ws = getWallets(name)
    for (let w of ws) {
        try {
            console.dir(w)
            if (w.name == "a") {
                continue
            }

            let account = stellarServer.getAccount(wallets["a"])
            let transactionId = await account.sendPayment(w.address, amount, null, asset)
            console.log("transactionId: " + transactionId)
        } catch (error) {
            console.error(error)
            // log.error(error)
        }
    }
}

function getWallets(walletName) {
    if (walletName != "all") {
        return [wallets[walletName]]
    }

    let o = []
    for (let name in wallets) {
        o.push(wallets[name])
    }
    return o
}

async function trustAsset(walletName, assetName, limit) {
    limit = limit || '1000000'
    console.log("trust asset: " + walletName)
    let asset = assets.get(assetName)
    console.dir(assetName)

    let ws = getWallets(walletName)

    console.dir(ws)
    for (let w of ws) {
        try {
            console.dir(w)
            if (w.name == "a") {
                continue
            }

            let server = stellarServer.server
            let receiver = await server.loadAccount(w.address)
            console.dir(receiver)
            console.dir(asset)
            var transaction = new StellarSdk.TransactionBuilder(receiver)
                .addOperation(StellarSdk.Operation.changeTrust({
                    asset: asset,
                    limit: limit
                }))
                .build();
            var receivingKeys = StellarSdk.Keypair.fromSecret(w.seed);
            transaction.sign(receivingKeys);
            await server.submitTransaction(transaction);
        } catch (error) {
            console.error(error)
            // console.dir(error.data.extras.result_codes)
            // log.error(error)
        }
    }
}

function getMasterAccount() {
    return wallets["master"]
}

function getAsset(name) {
    name = name.toLowerCase()
    if (name == "native" || name == "xlm") {
        return nativeAsset
    } else {
        let masterAccount = getMasterAccount()
        if (!masterAccount) {
            throw new Error("No master account! Please create an account named master")
        }

        return new StellarSdk.Asset(name.toUpperCase(), masterAccount.address);
    }
}

async function setDomain(walletName, d) {
    console.log("setting dom: d="+d)
    let wallet = wallets[walletName]
    let a = await stellarServer.getAccount(wallet)
    await a.setHomeDomain(d)
}

async function clearOffers(walletName) {
    let wallet = wallets[walletName]    
    let a = stellarServer.getAccount(wallet)
    let o = await a.deleteAllOffers()
}

async function createOffer(walletName, selling, buying, price, amount) {
    try {
        let wallet = wallets[walletName]

        buying = assets.get(buying)
        selling = assets.get(selling)
        let a = stellarServer.getAccount(wallet)
        let o = await a.createOffer(selling, buying, price, amount)
        console.dir(o)
        console.dir(JSON.stringify(StellarSdk.xdr.TransactionEnvelope.fromXDR(o.envelope_xdr, 'base64')));
        console.dir(JSON.stringify(StellarSdk.xdr.TransactionResult.fromXDR(o.result_xdr, 'base64')));
        console.dir(JSON.stringify(StellarSdk.xdr.TransactionMeta.fromXDR(o.result_meta_xdr, 'base64')));
    } catch (error) {
        console.error(error)
        // console.dir(error.data)
        console.dir(error.data.extras.result_codes)
    }
}

async function deleteOffer(walletName, offerId) {
    try {
        let wallet = wallets[walletName]

        // buying = getAsset(buying)
        // selling = getAsset(selling)
        let a = stellarServer.getAccount(wallet)
        let o = await a.deleteOffer(offerId)
        console.dir(new StellarSdk.Transaction(o.envelope_xdr))
        // console.dir(new StellarSdk.Transaction(o.result_xdr))
        // console.dir(new StellarSdk.Transaction(o.result_meta_xdr))
    } catch (error) {
        console.error(error)
        // console.dir(error.data)
        console.dir(error.data.extras.result_codes)
    }
}

async function pathToNative(srcWallet, destWallet, amt) {
    try {
        let r = stellarServer.getPath(wallets[srcWallet].address, wallets[destWallet].address, nativeAsset, amt)
    } catch (error) {
        console.error(error)
        // console.dir(error.data)
        console.dir(error.data.extras.result_codes)
    }
}

async function pathToWin(srcWallet, destWallet, amt) {
}

async function test(walletName) {
    try {
        let wallet = wallets[walletName]
        let a = stellarServer.getAccount(wallet)
        let t = await a.hasTrust(StellarSdk.Asset.native())
        console.log("trust: "+t)

        // let a = stellarServer.server.assets()
        // let t = a.forCode("WIN")
        // let o = await t.call()
        // console.dir(o)

        // let opb = stellarServer.server.operations()
        // let o1 = await opb.forTransaction("49a0dfee2a0f9543c69a81509e871dafedcbed128691cf0835e808fd70e991f2").call()
        // // console.dir(o1)

        // let tb = stellarServer.server.trades()
        // let o = await tb.forOffer("140707").call()
        // // console.dir(o)
        // for (let t of o.records) {
        //     console.dir(t)
        //     let o = await t.operation()
        //     // console.log("op")
        //     // console.dir(o)
        //     // console.log(t.counter())
        // }
    } catch (error) {
        console.error(error)
    }
    // let a = await stellarServer.getAccount(wallets[walletName])
    // let r = await a.sendPathPayment(winAsset, "100", wallets["s4"].address, nativeAsset, "1")    
    // console.dir(r)
}

async function encode(walletName, f, pass) {
    let wallet = wallets[walletName]
    let o = `${wallet.address}.${wallet.seed}`
    let cmd = `echo ${o} | openssl enc -base64 -e -aes-256-cbc -a -salt -k ${pass} -out ${f}`
    let { out, err } = await exec(cmd);
}

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});