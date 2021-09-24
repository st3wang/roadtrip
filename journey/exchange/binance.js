var crypto = require('crypto')
const binancedata = require('./binancedata')
const https = require('https')
const winston = require('winston')
const shoes = require('../shoes')
const {symbol,account,exchange,setup} = shoes
const oneCandleMs = setup.candle.interval*60000
const name = 'binance'
const symbols = {
  XBTUSD: 'BTCUSDT',
  COMPUSD: 'COMPUSDT',
  UMAUSD: 'UMAUSDT',
  IOTXUSD: 'IOTXUSDT',
  RENUSD: 'RENUSDT',
  CRVUSD: 'CRVUSDT',
  QUICKUSD: 'QUICKUSDT',
  PAXUSD: 'PAXUSDT',
  XTZUSD: 'XTZUSDT',
  GTCUSD: 'GTCUSDT',
  DASHUSD: 'DASHUSDT',
  TRBUSD: 'TRBUSDT',
  YFIUSD: 'YFIUSDT',
  OXTUSD: 'OXTUSDT',
  BALUSD: 'BALUSDT',
  CHZUSD: 'CHZUSDT',
  AXSUSD: 'AXSUSDT',
  ANKRUSD: 'ANKRUSDT',
  TRUUSD: 'TRUUSDT',
  QNTUSD: 'QNTUSDT',
  XLMUSD: 'XLMUSDT',
  FORTHUSD: 'FORTHUSDT',
  MASKUSD: 'MASKUSDT',
  ETCUSD: 'ETCUSDT',
  DOGEUSD: 'DOGEUSDT',
  ALGOUSD: 'ALGOUSDT',
  ZRXUSD: 'ZRXUSDT',
  BANDUSD: 'BANDUSDT',
  OGNUSD: 'OGNUSDT',
  SUSHIUSD: 'SUSHIUSDT',
  REPUSD: 'REPUSDT',
  CLVUSD: 'CLVUSDT',
  GRTUSD: 'GRTUSDT',
  REQUSD: 'REQUSDT',
  BATUSD: 'BATUSDT',
  OMGUSD: 'OMGUSDT',
  COTIUSD: 'COTIUSDT',
  RLCUSD: 'RLCUSDT',
  BNTUSD: 'BNTUSDT',
  MATICUSD: 'MATICUSDT',
  UNIUSD: 'UNIUSDT',
  DAIUSD: 'DAIUSDT',
  LTCUSD: 'LTCUSDT',
  SNXUSD: 'SNXUSDT',
  ETHUSD: 'ETHUSDT',
  TRIBEUSD: 'TRIBEUSDT',
  NKNUSD: 'NKNUSDT',
  LRCUSD: 'LRCUSDT',
  BTCUSD: 'BTCUSDT',
  ICPUSD: 'ICPUSDT',
  STORJUSD: 'STORJUSDT',
  NMRUSD: 'NMRUSDT',
  DOTUSD: 'DOTUSDT',
  CTSIUSD: 'CTSIUSDT',
  BCHUSD: 'BCHUSDT',
  SOLUSD: 'SOLUSDT',
  MKRUSD: 'MKRUSDT',
  MIRUSD: 'MIRUSDT',
  BONDUSD: 'BONDUSDT',
  FARMUSD: 'FARMUSDT',
  FETUSD: 'FETUSDT',
  ENJUSD: 'ENJUSDT',
  ATOMUSD: 'ATOMUSDT',
  SKLUSD: 'SKLUSDT',
  KNCUSD: 'KNCUSDT',
  '1INCHUSD': '1INCHUSDT',
  EOSUSD: 'EOSUSDT',
  ADAUSD: 'ADAUSDT',
  MANAUSD: 'MANAUSDT',
  ZECUSD: 'ZECUSDT',
  LINKUSD: 'LINKUSDT',
  MLNUSD: 'MLNUSDT',
  AAVEUSD: 'AAVEUSDT',
  KEEPUSD: 'KEEPUSDT',
  ORNUSD: 'ORNUSDT',
  LPTUSD: 'LPTUSDT',
  NUUSD: 'NUUSDT',
  YFIIUSD: 'YFIIUSDT',
  FILUSD: 'FILUSDT',
  USDCUSD: 'USDCUSDT'
}

var position = {exchange:name}

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global

async function getCurrentMarket() { try {
  const now = getTimeNow()
  const length = setup.candle.length
  const startTime = new Date(now-length*oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  const endTime = new Date(now-oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  var marketCache
  if (mock) {
    marketCache = await binancedata.readMarket(symbols.XBTUSD,60,startTime,endTime)
  }
  else {
    marketCache = await binancedata.getMarket(symbols.XBTUSD,60,startTime,endTime)
  }
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

async function init() { try {
  // var response = await createOrder()
  // debugger
} catch(e) {debugger} }

function getSignature(queryString,timestamp) { try {
  var what
  if (queryString && queryString.length) {
    what = queryString + '&'
  }
  else {
    what = ''
  }
  what += 'timestamp=' + timestamp
  var hmac = crypto.createHmac('sha256', exchange.binance.secret)
  var signature = hmac.update(what).digest('hex')
  return signature
} catch(e) {console.error(e);debugger} }

async function request(method,path,queryString) { try {
  debugger
  return new Promise((resolve,reject) => {
    queryString = queryString || ''
    const timestamp = new Date().getTime()
    const options = {
      method: method,
      hostname: 'api.binance.com',
      path: path + '?' + queryString + (queryString.length ? '&' : '') + 'timestamp=' + timestamp + '&signature=' + getSignature(queryString,timestamp),
      headers: {
        'X-MBX-APIKEY': exchange.binance.key,
      }
    }
    const req = https.request(options, function(response) {
        let data = ''
        response.on('data', (chunk) => {data += chunk})
        response.on('end', () => {
          let value = JSON.parse(data)
          resolve(value)
        })
      }
    )
    req.on('error', (e) => {
      console.error(e.message)
      debugger
    })
    req.end()
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function getAccount() { try {
  var response = await request('GET','/sapi/v1/accountSnapshot','type=SPOT')
  return response
} catch(e) {logger.error(e.stack||e);debugger} }

async function createOrder({symbol,side,type,size,price}) { try {
  symbol = symbols[symbol]
  // symbol = 'USDCUSDT'
  // side = 'SELL'
  // size = 88410
  // debugger
  // var response = await request('POST','/api/v3/order','symbol=USDCUSDT&side=SELL&type=LIMIT&timeInForce=GTC&quantity=132336&price=1')
  size = Math.round(size)
  var response = await request('POST','/api/v3/order','symbol=' + symbol + '&side=' + side + '&type=' + type + '&quantity=' + size)
  
  debugger
  return response
} catch(e) {console.error(e.stack||e);debugger} }

async function marketBuy(order) { try {
  order.side = 'BUY'
  order.type = 'MARKET'
  return await createOrder(order)
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrder({symbol,orderId}) { try {
  var response = await request('GET','/api/v3/order','symbol=' + symbols[symbol] + '&orderId=' + orderId)
  debugger
  return response
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrders({symbol}) { try {
  var response = await request('GET','/api/v3/allOrders','symbol=' + symbols[symbol])
  debugger
  return response
} catch(e) {console.error(e.stack||e);debugger} }

async function withdraw({coin,amount,address}) { try {
  console.log('withdraw')
  var response = await request('POST','/sapi/v1/capital/withdraw/apply','coin=' + coin + '&amount=' + amount + '&address=' + address + '&network=ETH')
  console.log(response)
  debugger
  return response
} catch(e) {console.error(e.stack||e);debugger} }

async function getCoinInfo() { try {
  var coins = await request('GET','/sapi/v1/capital/config/getall','')
  var USDC = coins.find(({coin}) => {
    return coin == 'USDC'
  })
  debugger
  return coins
} catch(e) {console.error(e.stack||e);debugger} }

async function getBook(symbol) { try {
  return new Promise((resolve,reject) => {
    const options = {
      hostname: 'api.binance.com',
      path: '/api/v3/depth?symbol=' + symbols[symbol]
    }
    https.get(options, function(response) {
        let data = ''
        response.on('data', (chunk) => {data += chunk})
        response.on('end', () => {
          let orders = JSON.parse(data)
          var book = {
            asks: [],
            bids: []
          }
          if (orders && orders.asks && orders.bids) {
            orders.asks.forEach(o => {
              book.asks.push({
                price: parseFloat(o[0]),
                size: parseFloat(o[1])
              })
            })
            orders.bids.forEach(o => {
              book.bids.push({
                price: parseFloat(o[0]),
                size: parseFloat(o[1])
              })
            })
          }
          else {
            debugger
          }
          return resolve(book)
        })
      }
    )
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function getProducts() {
  return new Promise((resolve,reject) => {
    const options = {
      hostname: 'api.binance.com',
      path: '/api/v3/exchangeInfo'
    }
    https.get(options, function(response) {
        let data = ''
        response.on('data', (chunk) => {data += chunk})
        response.on('end', () => {
          let exchangeInfo = JSON.parse(data)
          let symbols = []
          exchangeInfo.symbols.forEach(s => {
            if (s.quoteAsset == 'USDT') {
              symbols.push(s.baseAsset + 'USD')
            }
          })
          return resolve(symbols)
        })
      }
    )
  })
}

init()

module.exports = {
  name: name,
  init: init,
  getCurrentMarket: getCurrentMarket,
  getBook: getBook,
  getProducts: getProducts,
  createOrder: createOrder,
  marketBuy: marketBuy,
  getOrder: getOrder,
  getOrders: getOrders,
  withdraw: withdraw,
  getCoinInfo: getCoinInfo,
  symbols: symbols,
  position: position,
}