'use strict';

var _ = require('lodash'),
  path = require('path'),
  StellarSdk = require('stellar-sdk'),
    Operation = StellarSdk.Operation,
    StrKey = StellarSdk.StrKey,
  StellarBase = require('stellar-base'),
  BigDecimal=require('bigdecimal').BigDecimal,
  crypto = require("crypto"),
	// optional = require("optional"),
    request = require('request'),
  log = require('tracer').colorConsole();

let pgo, fake
  try {
    pgo = require('pg-orm');
      fake = require("./stellarFake");
  } catch (error) {

  }

var Model = Object
if (pgo) {
	Model = pgo.Model;
}

function StellarServer(serverAddress, isTestnet) {
	this.serverAddress=serverAddress
	this.isTestnet = isTestnet
	log.info(`creating server: ${serverAddress} isTestnet: ${isTestnet}`)

	if (isTestnet) {
		StellarSdk.Network.useTestNetwork();
	} else {
		StellarSdk.Network.usePublicNetwork();
	}

	this.server = new StellarSdk.Server(serverAddress);
}

class ExtendableError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else { 
      this.stack = (new Error(message)).stack; 
    }
  }
}    

module.exports.BadDestinationError = class extends ExtendableError {}
module.exports.BadSourceError = class extends ExtendableError {}
module.exports.InsufficientBalance = class extends ExtendableError {}	

let MINIMUM_CREATE_ACCOUNT_AMOUNT = 1

StellarServer.prototype.getAsset=function(code, issuer){
	return new StellarSdk.Asset(code,issuer)
}

StellarServer.prototype.listIncomingTransactions = async function (account, lastSeenRecord) {
	let transactions = await this.server.transactions().forAccount(account).order('desc').limit(200).call()
	let doContinue = true
	let out = []
	do {
		for (let record of transactions.records) {
			if (lastSeenRecord && record.id == lastSeenRecord) {
				console.log("already seen")
				doContinue = false
				break
			}

			let data = new StellarSdk.Transaction(record.envelope_xdr)
			let memo = record.memo
			let firstOperation = data.operations[0]

			if (firstOperation.type != "payment") {
				continue;
			}

			let destination = firstOperation.destination
			let amount = firstOperation.amount
			let assetType = firstOperation.asset.code

			if (assetType != "XLM") {
				continue
			}

			if (destination!=account) {
				continue
			}

            let outRecord = { destination: destination, 
                                source: record.source_account,
                                memo: memo, 
                                amount: amount, 
                                transactionId: record.id }
			console.dir(outRecord)
			out.push(outRecord)
		} // for loop

		if (transactions.records.length == 0 || !doContinue) {
			break
		}

		transactions = await transactions.next()

	} while (doContinue)

	return out
}

StellarServer.prototype.getBalance = async function (address) {
	console.log("get bal")
	let account=await this.server.accounts().accountId(address).call()

	for (var row in account.balances) {
		var asset = account.balances[row];

		if (asset.asset_type == 'native') {
			return asset.balance
		}
	}

	throw new Error("did not find the native asset")
}

StellarServer.prototype.createAccount=async function () {
	var pair = StellarSdk.Keypair.random();

	if (!this.isTestnet) {
		return [pair.secret(), pair.publicKey()]
		return
	}

	return new Promise(function (resolve, reject) {
		console.log("activating account")
		// console.dir(pair)
		request.get({
			url: 'https://horizon-testnet.stellar.org/friendbot',
			qs: { addr: pair.publicKey() },
			json: true
		}, function (error, response, body) {
			if (error || response.statusCode !== 200) {
				console.error('ERROR!', error || body);
				reject(error)
			}
			else {				
				resolve([pair.secret(), pair.publicKey()])
			}
		});
	});
}

// TODO: support other asset types
// TODO: wrap and throw not found errors
StellarServer.prototype.sendPayment=async function(wallet,destination,amount,memo) {	
	try {
		log.info(`sending payment to dest=${destination} amt=${amount}`)
		var server = this.server;
		var sourceKeys = StellarSdk.Keypair.fromSecret(wallet.seed);
		log.info(`seed:` + wallet.seed)
	    var destinationId = destination

		if (!StrKey.isValidEd25519PublicKey(destinationId)) {
			log.error("invalid destination: " + destination)
			return [null, "bad_destination"]
		}

		let destinationExists = true
	    try {
		    // First, check to make sure that the destination account exists.
		    // You could skip this, but if the account does not exist, you will be charged
		    // the transaction fee when the transaction fails.
		    await server.loadAccount(destinationId)
		} catch (error) {
			log.warn(`destination account not found`)
			destinationExists = false
			// if (error instanceof StellarSdk.NotFoundError) {
			// 	throw new BadDestinationError(destinationId)	
			// }
			// throw error
		}

		try {
	    	var sourceAccount=await server.loadAccount(sourceKeys.publicKey());
	    } catch (error) {
			if (error instanceof StellarSdk.NotFoundError) {
				log.error(error)
				return [null, "bad_source"]
			}
			return [null, "unknown"]
		}

		let txBuilder = new StellarSdk.TransactionBuilder(sourceAccount);
		if (destinationExists) {
			log.info(`sending payment`)
			txBuilder.addOperation(StellarSdk.Operation.payment({
				destination: destinationId,
				asset: StellarSdk.Asset.native(),
				amount: amount
			}))
		} else {
			log.info(`creating an account`)
			if (+amount<MINIMUM_CREATE_ACCOUNT_AMOUNT) {
				return [null, "insufficient_balance"]
			}

			txBuilder.addOperation(StellarSdk.Operation.createAccount({
				  destination: destinationId,  
				  startingBalance: amount
			  }))
		}	        

	    if (memo) {
			txBuilder.addMemo(StellarSdk.Memo.text(memo))
	    }
	          
		let transaction = txBuilder.build();

	    transaction.sign(sourceKeys);

	    var result =await server.submitTransaction(transaction);

	    // log.info(`successfully sent payment`)
	    // console.dir(result.hash)
	    return [result.hash, null]
	} catch (error) {
		log.error(`error sending payment: ${error}`)
		log.error(error)		
		return [null, "unknown"]
	}    
}

StellarServer.prototype.getTransaction=async function(transactionId) {
	var tx = await this.server.transactions()
        .transaction(transactionId)
        .call();

    var txd = new StellarBase.Transaction(tx.envelope_xdr)

    if (txd.operations[0].type!="payment") {
    	throw new Error("not a payment: "+transactionId)
    }

    // console.dir(txd)
    var out={
    	"transactionId":transactionId,
    	"source":txd.source,
    	"amount":txd.operations[0].amount,
    	"destination":txd.operations[0].destination,
    	"memo":tx.memo
    }
   
   	return out
}

function TransactionBuilder(data){
	this.data=data || {}
}

TransactionBuilder.prototype.build=function(){
	return this.data
}

TransactionBuilder.prototype.amount=function(value) {
	this.data.amount=value
	return this
}

module.exports.testServer = function () {  	
	return new StellarServer('https://horizon-testnet.stellar.org', true)
};

module.exports.liveServer = function () {
	return new StellarServer('https://horizon.stellar.org', false)
};

module.exports.fakeServer = function () {  
	return new fake.FakeServer()
};

module.exports.transactionBuilder = function (initial) {  
	return new TransactionBuilder(initial)
};

module.exports.registerModels = function () {
	fake.registerModels()
}

module.exports.init = function () {  
	log.info(`initializing stellar pay`)
};

const XLM_TO_DS = BigDecimal(100000)
module.exports.toDS=function(value) {
	if (typeof value=="string") {
		var big=BigDecimal(value).multiply(XLM_TO_DS)
		value=big.intValue()
		return value
	} else {
		return value*XLM_TO_DS
	}
}

module.exports.fromDS=function(value) {
	var big=BigDecimal(value).divide(XLM_TO_DS)
	if (big.signum() == 0) {
		return "0"		
	}
	return big.toPlainString()
}

StellarServer.prototype.getAccount = function (info, trustedIssuers) {
    let main, signers
    if (_.isArray(info)) {
    	info = info.slice(0)
        main = info.shift()
        signers = info
    } else {
        main = info
    }

    let a = new StellarAccount(main, this.server, trustedIssuers, signers)
    return a
}

class StellarAccount {
	constructor(info, server, trustedIssuers, signers) {
		log.info("loading account:" + info.address)
		this.server = server
		this.address = info.address
		this.seed = info.seed
        this.trustedIssuers = trustedIssuers
        this.signers = signers || []

		if (this.seed) {
			this.key = StellarSdk.Keypair.fromSecret(this.seed);
        }
        
        if (this.signers) {
            this.signerKeys = []
            for (let s of this.signers) {
            	log.info("signer: "+s.address)
                this.signerKeys.push(StellarSdk.Keypair.fromSecret(s.seed))
            }
        }

		if (!this.address) {
			throw new Error("no address")
		}
	}

	// Default to payment only type tx
	parseTransaction(record) {
		let data = new StellarSdk.Transaction(record.envelope_xdr)
		let memo = record.memo
		let firstOperation = data.operations[0]
		console.dir(firstOperation)

		if (firstOperation.type != "payment" && firstOperation.type != "pathPayment") {
			return;
		}

		let destination = firstOperation.destination

		let amount, asset
		if (firstOperation.type == "pathPayment") {
			amount = firstOperation.destAmount
			asset = firstOperation.destAsset
		} else {
			amount = firstOperation.amount
			asset = firstOperation.asset
		}

		// No issuer means XLM
		if (this.trustedIssuers && asset.issuer) {
			if (!this.trustedIssuers.includes(asset.issuer)) {
				console.log("untrusted assets")
				console.dir(asset)
				return
			}
		}

		if (destination != this.address) {
			return
		}

		let outRecord = {
			type: firstOperation.type,
			destination: destination,
			source: record.source_account,
			memo: memo,
			amount: amount,
			transactionId: record.id,
			asset: asset.code
		}

		return outRecord
	}

	async sendPathPayment(sendAsset, sendMax, dest, destAsset, destAmount, path) {
		try {
			await this.loadAccount()

			log.info(`sending path payment to dest=${dest} amt=${destAmount}`)

			let txBuilder = new StellarSdk.TransactionBuilder(this.account);

			let data = {
				sendAsset: sendAsset,
				sendMax: String(sendMax),
				destination: dest,
				destAsset: destAsset,
				destAmount: String(destAmount),
				path: path
			}
			console.dir(data)
			// txBuilder.addOperation(StellarSdk.Operation.createAccount({
			// 	destination: dest,
			// 	startingBalance: destAmount
			// }))
			txBuilder.addOperation(StellarSdk.Operation.pathPayment(data))

			let transaction = txBuilder.build();

			transaction.sign(this.key);

			var result = await this.server.submitTransaction(transaction);

			console.dir(result)
			return result.hash
		} catch (error) {
			log.error(`error sending payment: ${error}`)
			log.error(error)
			var stringify = require('json-stringify-safe');
			var json = stringify(error, null, 4);
			let fs = require('fs')
			fs.writeFileSync("./error", json, 'utf8');

			if (error.data) {
				log.info("---------------------------------")
				log.info("DUMP extras")
				log.info("---------------------------------")
				console.dir(error.data)
			}
			throw error
		}
	}

	async createAccount(destination, amount, memo) { 
		try {
			if (!StrKey.isValidEd25519PublicKey(destination)) {
				log.error("invalid destination: " + destination)
				return [null, "bad_destination"]
			}

			try {
				await this.server.loadAccount(destination)
				log.error(`destination already exist`)
				return [null, "already_exists"]
			} catch (error) {
				log.warn(`destination account not found`)
			}

			await this.loadAccount()
			let txBuilder = new StellarSdk.TransactionBuilder(this.account);
			txBuilder.addOperation(StellarSdk.Operation.createAccount({
				destination: destination,
				startingBalance: amount
			}))

			if (memo) {
				txBuilder.addMemo(StellarSdk.Memo.text(memo))
			}

			let transaction = txBuilder.build();
			transaction.sign(this.key);
			var result = await this.server.submitTransaction(transaction);
			// console.dir(result)
			return [result.hash, null]
		} catch(error) {
			log.error(`error sending payment: ${error}`)
			log.error(error)
			return [null, "unknown"]
		} 
    }
    
	async setHomeDomain(dom) {
		await this.loadAccount()

		var transaction = new StellarSdk.TransactionBuilder(this.account)
	      .addOperation(StellarSdk.Operation.setOptions({
	        homeDomain: dom,
	      }))
	      .build();
	    this.sign(transaction)
	    log.info("submit tx")
	    return await this.server.submitTransaction(transaction);
	}

    async lockout(addr) {
        await this.loadAccount()

		var txBuilder = new StellarSdk.TransactionBuilder(this.account)
		
        txBuilder.addOperation(Operation.setOptions({
                masterWeight: 0,
                lowThreshold: 0,
                medThreshold: 0,
                highThreshold: 0
            }))

        let transaction = txBuilder.build(); 
        this.sign(transaction)
        var result = await this.server.submitTransaction(transaction);
        log.info("subm result")
        console.dir(result)
        return result
    }

	async setWeights() {
        await this.loadAccount()

		var txBuilder = new StellarSdk.TransactionBuilder(this.account)
		
        txBuilder.addOperation(Operation.setOptions({
                masterWeight: 1,
                lowThreshold: 1,
                medThreshold: 2,
                highThreshold: 2
            }))

        let transaction = txBuilder.build(); 
        this.sign(transaction)
        var result = await this.server.submitTransaction(transaction);
        log.info("subm result")
        console.dir(result)
        return result
    }

    async removeSigner(addr) {
    	// TODO: test
    	log.info("removing signer:" + addr)
        await this.loadAccount()

        var txBuilder = new StellarSdk.TransactionBuilder(this.account)

        txBuilder.addOperation(Operation.setOptions({
                signer: {
                    ed25519PublicKey: addr,
                    weight: 0
                }
            }))

        let transaction = txBuilder.build(); 
        this.sign(transaction)
        var result = await this.server.submitTransaction(transaction);
        log.info("subm result")
        console.dir(result)
        return result
    }

    async addSigner(addr) {
        await this.loadAccount()

        let count = 1 + this.signers.length + 1
        log.info("adding signer; total="+count)
        var txBuilder = new StellarSdk.TransactionBuilder(this.account)

        txBuilder.addOperation(Operation.setOptions({
                signer: {
                    ed25519PublicKey: addr,
                    weight: 1
                }
            }))

        txBuilder.addOperation(Operation.setOptions({
                masterWeight: 1,
                lowThreshold: count - 1,
                medThreshold: count,
                highThreshold: count
            }))

        let transaction = txBuilder.build(); 
        this.sign(transaction)
        var result = await this.server.submitTransaction(transaction);
        log.info("subm result")
        console.dir(result)
        return result
    }

    getAccount(addr) {
		return new StellarAccount({address: addr}, this.server)
	}

	async sendPayment(destination, amount, memo, asset) { 		
		if (!asset) {
			asset = StellarSdk.Asset.native()
		}

		if (!StrKey.isValidEd25519PublicKey(destination)) {
			log.error("invalid destination: " + destination)
			return [null, "bad_destination"]
		}

		try {
			await this.loadAccount()

			log.info(`sending payment to dest=${destination} amt=${amount} asset=${asset.code}`)
			console.dir(asset)
			var server = this.server;
			var destinationId = destination

			let destinationExists = true
			try {
				// First, check to make sure that the destination account exists.
				// You could skip this, but if the account does not exist, you will be charged
				// the transaction fee when the transaction fails.
				await server.loadAccount(destinationId)
			} catch (error) {
				log.warn(`destination account not found`)
				destinationExists = false
				// if (error instanceof StellarSdk.NotFoundError) {
				// 	throw new BadDestinationError(destinationId)	
				// }
				// throw error
			}

			let txBuilder = new StellarSdk.TransactionBuilder(this.account);
			if (destinationExists) {
				let da = this.getAccount(destination)
				let t = await da.hasTrust(asset)
				if (!t) {
					return [null, "no_trust"]
				}

				log.info(`sending payment`)
				txBuilder.addOperation(StellarSdk.Operation.payment({
					destination: destinationId,
					asset: asset,
					amount: amount	
				}))
			} else {
				log.info(`creating an account`)
				if (asset && asset.code != "XLM") {
					log.warn(`cannot send custom assets to inactive Stellar account`)
					return [null, "no_account"]
				}

				txBuilder.addOperation(StellarSdk.Operation.createAccount({
					destination: destinationId,
					startingBalance: amount
				}))
			}

			if (memo) {
				txBuilder.addMemo(StellarSdk.Memo.text(memo))
			}

			let transaction = txBuilder.build();
            this.sign(transaction)

			var result = await server.submitTransaction(transaction);

			// log.info(`successfully sent payment`)
			console.dir(result)
			return [result.hash, null]
		} catch (error) {
			log.error(`error sending payment: ${error}`)
			log.error(error)
			return [null, "unknown"]
		} 
    }
    
    sign(transaction) {
        // console.log("signing with: k=" + this.key)
        transaction.sign(this.key);

        for (let sk of this.signerKeys) {
            console.log("signing with: sk="+sk)
            transaction.sign(sk);
        }
    }

    async hasTrust(asset) {
		let account = await this.server.accounts().accountId(this.address).call()

    	if (asset.code == "XLM" && !asset.issuer) {
    		return true
    	}

    	for (var row in account.balances) {
			var a = account.balances[row];
			if (a.asset_issuer == asset.issuer && a.asset_code == asset.code) {
				return true
			}
		}

		return false;
    }

	async getBalance() {
		let account = await this.server.accounts().accountId(this.address).call()

		let out = {}
		for (var row in account.balances) {
			var asset = account.balances[row];
			console.dir(asset)

			if (asset.asset_type == 'native') {
				out.XLM = asset.balance
			} else {
				out[asset.asset_code] = asset.balance
			}
		}

		return out
	}

	async getBalanceFull() {
		let account = await this.server.accounts().accountId(this.address).call()

		let out = {}
		for (var row in account.balances) {
			var asset = account.balances[row];
			console.dir(asset)

			if (asset.asset_type == 'native') {
				out.native = +asset.balance
			} else {
				out[`${asset.asset_code}-${asset.asset_issuer}`] = +asset.balance
			}
		}

		return out
	}

	async loadAccount() {
		if (this.account) {
			return
		}

		try {
            this.account = await this.server.loadAccount(this.address);
		} catch (error) {
			if (error instanceof StellarSdk.NotFoundError) {
				log.error(`account not found`)
				throw new BadSourceError(this.address)
			}
			throw error
		}
	}

	async getOffers() {
		let result = await this.server.offers('accounts', this.address).call()
		return result.records
	}

	async getOffer(offerId) {
		let os = await this.getOffers()
		for (let o of os) {
			if (o.id == +offerId) {
				return o
			}
		}
		return []
	}

	async deleteAllOffers() {
		let os = await this.getOffers()
		console.dir(os)
		for (let offer of os) {
			this.deleteOffer(offer.id)
		}
	}

	async deleteOffer(offerId) {
		await this.loadAccount()

		let o = await this.getOffer(offerId)
		console.dir(o)

		function parseAsset(a) {
			if (a.asset_type == "native") {
				return StellarSdk.Asset.native()
			} else {
				return new StellarSdk.Asset(a.asset_code, a.asset_issuer);
			}
		}

		let b = parseAsset(o.buying)
		let s = parseAsset(o.selling)
		const operationOpts = {
			buying: b,
			selling: s,
			price: o.price,
			amount: '0',
			offerId: offerId
		};
		console.log("del offer")
		console.dir(operationOpts)

		let transaction = new StellarSdk.TransactionBuilder(this.account)
			.addOperation(StellarSdk.Operation.manageOffer(operationOpts))

		transaction = transaction.build();
        this.sign(transaction)

		var result = await this.server.submitTransaction(transaction);
		return result
	}

	async createOffer(selling, buying, price, amount) {
		await this.loadAccount()

		const operationOpts = {
			buying: buying,
			selling: selling,
			amount: amount,
			price: price,
			offerId: 0
		};
		console.log("create offer")
		console.dir(operationOpts)

		let op = StellarSdk.Operation.manageOffer(operationOpts)
		console.dir(op)
		console.log(op.id)
		let transaction = new StellarSdk.TransactionBuilder(this.account)
			.addOperation(op)

		transaction = transaction.build();
        this.sign(transaction)

		var result = await this.server.submitTransaction(transaction);
		return result
	}

	async getTransaction(transactionId, matchSpec) {
		var tx = await this.server.transactions()
			.transaction(transactionId)
			.call();

		if (!tx) {
			console.log("the transaction not found:"+transactionId)
			return null
		}

		var txd = new StellarBase.Transaction(tx.envelope_xdr)
		let record= this.parseTransaction(tx)
		if (matchSpec) {
			if (matchSpec.memo && record.memo != matchSpec.memo) {
				console.log("memo mismatch")
				console.dir(matchSpec)
				console.dir(record)
				return null
			}
		}

		return record
	}

	async listEffects(lastSeenRecord) {
		console.log("lsiting all tx")
		let batch = await this.server.effects().forAccount(this.address).order('desc').limit(100).call()
		console.dir(batch)
		let doContinue = true
		let out = []
		do {
			doContinue = false
			if (batch.records.length == 0 ) {
				break
			}

			console.log("got " + batch.records.length)
			for (let record of batch.records) {
				if (lastSeenRecord && record.id == lastSeenRecord) {
					console.log("already seen")
					doContinue = false
					break
				}

				out.push(record)
			} // for loop

			if (batch.records.length == 0 || !doContinue) {
				break
			}

			batch = await batch.next()

		} while (doContinue)

		return out
	}

	async listIncomingTransactions(lastSeenRecord) {
		let transactions = await this.server.transactions().forAccount(this.address).order('desc').limit(200).call()
		let doContinue = true
		let out = []
		do {
			for (let record of transactions.records) {
				if (lastSeenRecord && record.id == lastSeenRecord) {
					console.log("already seen")
					doContinue = false
					break
				}

				let outRecord = this.parseTransaction(record)
				if (!outRecord) {
					continue
				}

				out.push(outRecord)
			} // for loop

			if (transactions.records.length == 0 || !doContinue) {
				break
			}

			transactions = await transactions.next()

		} while (doContinue)

		return out
	}
}

//module.exports.accounts = require("./stellarAccount")