var StellarSdk = require('stellar-sdk');

class StellarAssets {
    constructor(assetsFile) {
        this.assets = require(assetsFile)
    }

    static getLive() {
        return new StellarAssets("./config/assets_live.json")
    }

    static getTest() {
        return new StellarAssets("./config/assets_test.json")
    }

    get(name) {
        name = name.toUpperCase()
        if (name == "XLM") {
            return StellarSdk.Asset.native()
        }

        let a = this.assets[name]
        if (!a) {
            console.dir(this.assets)
            throw new Error("Asset does not exist: " + name)
        }
        return new StellarSdk.Asset(a.code, a.issuer);
    }
}

module.exports.StellarAssets = StellarAssets