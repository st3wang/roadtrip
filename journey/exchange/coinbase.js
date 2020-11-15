var crypto = require('crypto')
const https = require('https')
const coinbasedata = require('./coinbasedata')
const winston = require('winston')
const shoes = require('../shoes')
const {symbol,exchange,setup} = shoes
const oneCandleMs = setup.candle.interval*60000
const name = 'coinbase'
const symbols = {
  XBTUSD: 'BTC-USD'
}

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global

var position = {}

async function getCurrentMarket() { try {
  const now = getTimeNow()
  const length = setup.candle.length
  const startTime = new Date(now-length*oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  const endTime = new Date(now-oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  var marketCache
  if (mock) {
    marketCache = await coinbasedata.readMarket(symbols.XBTUSD,60,startTime,endTime)
  }
  else {
    marketCache = await coinbasedata.getMarket(symbols.XBTUSD,60,startTime,endTime)
  }
  // console.log('coinbase',new Date(now).toISOString())
  // console.log('startTime',startTime)
  // console.log('endTime',endTime)
  // console.log(marketCache.candles.length)
  // console.log(marketCache.candles[0].time)
  // console.log(marketCache.candles[marketCache.candles.length-1].time)
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

async function request(method,path,body) { try {
  return new Promise((resolve,reject) => {
    var timestamp = Math.round(Date.now() / 1000)
    body = body ? JSON.stringify(body) : body
  
    var what = timestamp + method + path + (body || '')
    var key = Buffer.from(exchange.coinbase.secret, 'base64')
    var hmac = crypto.createHmac('sha256', key)
    var signedMessage = hmac.update(what).digest('base64')
  
    const options = {
      method: method,
      hostname: 'api.pro.coinbase.com',
      path: path,
      agent: false,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'CB-ACCESS-KEY': exchange.coinbase.key,
        'CB-ACCESS-SIGN': signedMessage,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'CB-ACCESS-PASSPHRASE': exchange.coinbase.passphrase,
        'Content-Type': 'application/',
      }
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
      options.headers['Content-Length'] = body.length
    }
    // const options = {
    //   hostname: 'encrypted.google.com',
    //   port: 443,
    //   path: '/',
    //   method: 'GET'
    // }
    const req = https.request(options, (res) => {
      // console.log('statusCode:', res.statusCode);
      // console.log('headers:', res.headers);
      let data = ''
      res.on('data', (chunk) => {data += chunk})
      res.on('end', () => {
        let value = JSON.parse(data)
        resolve(value)
      })
    })
    req.on('error', (e) => {
      console.error(e.message)
    })
    if (body) req.write(body)
    req.end()
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function init() { try {
  var res
  // await request('GET','/accounts')
  // await request('GET','/accounts/' + exchange.coinbase.account_id)
  // await request('GET','/orders')
  // res = await request('DELETE','/orders')
  // debugger
  // res = await request('POST','/orders', {
  //   side: 'buy',
  //   product_id: 'BTC-USD',
  //   size: 1,
  //   price: 8888,
  //   post_only: true
  // })
  // if (res.id) {
  //   // valid
  // }
  // else {
  //   console.error(res.message)
  // }
  // debugger
} catch(e) {logger.error(e.stack||e);debugger} }

module.exports = {
  name: name,
  init: init,
  getCurrentMarket: getCurrentMarket,
  symbols: symbols
}