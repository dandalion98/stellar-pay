var _ = require('lodash'),
    CryptoJS = require("crypto-js"),
    path = require('path'),
    crypto = require("crypto"),
    bcrypt = require("bcrypt-nodejs"),
    config = require(path.resolve("config/config")),
    stellarPay = require("stellar-pay"),
    toDS = stellarPay.toDS,
    fromDS = stellarPay.fromDS,
    log = require('tracer').colorConsole(),
    colors = require('colors'),
    ddlog = require('tracer').colorConsole({
        methods: ["info"],
        filters: [colors.magenta]
    }),
    pgo = require('pg-orm'),
    url = require('url'),
    cookieParser = require("cookie-parser"),
    randomstring = require("randomstring"),
    tx = pgo.tx,
    StellarAccount = pgo.model("StellarAccount");

module.exports.registerRoutes = function(app) {
    app.route('/api/federation')
        .get(getFederation)
}

async function getFederation(request, response) {
    log.info(`received federation request`)
    console.dir(config.app)
    console.dir(request.query)
    let q = request.query.q
    let type = request.query.type

    if (type != "name") {
        log.error(`request is not supported: ${type}`)
        response.status(404)
        return
    }

    let name = q
    name = name.split("*")[0]

    out = {}

    let account = await StellarAccount.objects.get({name:name})
    if (!account) {
        log.error(`account is not found`)
        response.status(404)
        return
    }

    out.stellar_address = `${name}*${config.app.domain}`

    if (account.address) {
        out.account_id = account.address
    } else {
        let user = await account.get("user")
        out.account_id = config.wallet.address
        out.memo_type="text"
        out.memo = user.accountId
    }

    response.json(out)
}