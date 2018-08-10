# stellar-pay
A JS library that provides nicely abstracted, promisfied calls for common Stellar operations. Support multiple assets, path payments, trading, and multi-sig.

# Basic Abstractions
`StellarServer` represents an instance of a Horizon server.

`StellarAccount` represents a Stellar account. Methods on this class operates on that specific account. This class provides the bulk of the functionalities.

`StellarAccountEffect` provides parsing for Stellar account effects.

# Usage
To see how it can be used, please see s-cli and s-shell, which makes use of this library.

#### Sample Usage
```javascript
let stellarPay = require("stellar-pay")

let server = stellarPay.liveServer()

let account = server.getAccount({ address: "<account_addr>", seed: "<account_seed"> })

let balance = await account.getBalance()

let effects = await account.listEffects()
```


# Installation
Currently available for consumption as a git submodule. 
