const util = require('util')
var SwaggerClient = require("swagger-client")
var _ = require('lodash')
var BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
var padStart = require('string.prototype.padstart');
var talib = require('talib');
const talibExecute = util.promisify(talib.execute)
const shoes = require('./shoes');

async function initClient() {
  var client = await new SwaggerClient({
    // Switch this to `www.bitmex.com` when you're ready to try it out for real.
    // Don't forget the `www`!
    url: 'https://testnet.bitmex.com/api/explorer/swagger.json',
    usePromise: true
  })
  // Comment out if you're not requesting any user data.
  client.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(shoes.key, shoes.secret));
  return client
}

function pad2(v) {
  return padStart(v,2,'0')
}

function getUTCTimeString(ms) {
  var local = new Date(ms)
  return local.getUTCFullYear() + '-' + pad2(local.getUTCMonth()+1) + '-' + pad2(local.getUTCDate()) + 'T' +
    pad2(local.getUTCHours()) + ':' + pad2(local.getUTCMinutes()) + ':00.000Z'
}

function getBucketTimes(length,interval,binSize) {
  var current = new Date()
  var currentMS = current.getTime()
  var offset = (length * 60000) + (currentMS % (interval * 60000))
  var bitMexOffset = binSize * 60000 // bitmet bucket time is one bucket ahead
  offset -= bitMexOffset
  var offsetIncrement = 8*60*60000
  var end = offsetIncrement - bitMexOffset
  var buckets = []
  for (; offset > end; offset-=offsetIncrement) {
    buckets.push({
      startTime: getUTCTimeString(currentMS - offset),
      endTime: getUTCTimeString(currentMS - (offset-offsetIncrement+1))
    })
  }
  return buckets
}

async function getRsi(data,length) {
  var result = await talibExecute({
    name: "RSI",
    inReal: data,
    startIdx: 0,
    endIdx: data.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
}

async function getRsiSignal(closes,rsiLength,rsiOverbought,rsiOversold) {
  var rsis = await getRsi(closes,rsiLength)
  var len = closes.length
  var last0 = len - 1
  var last1 = len - 2
  var rsi = rsis[last0]
  var prsi = rsis[last1]
  var close = closes[last0]
  var shortCondition = prsi > rsiOverbought && rsi <= rsiOverbought 
  if (shortCondition) {
    return 'SHORT'
  }
  else {
    var longCondition = prsi < rsiOversold && rsi >= rsiOversold 
    if (longCondition) {
      return 'LONG'
    }
  }
}

async function getCurrentMarket(client,length,interval) {
  let binSize = 5
  let pages = getBucketTimes(length,interval,binSize)
  await Promise.all(pages.map(async (page,i) => {
    let response = await client.Trade.Trade_getBucketed({symbol: 'XBTUSD', binSize: binSize+'m', 
      startTime:page.startTime,endTime:page.endTime})
      .catch(error => {
        console.log(error)
        debugger
      })
    page.buckets = JSON.parse(response.data.toString());
  }))
  let buckets = pages.reduce((a,c) => a.concat(c.buckets),[])
  let increment = interval/binSize
  var candles = []
  var closes = []
  for (var i = 0; i < buckets.length; i+=increment) {
    let time = buckets[i].timestamp
    let close = buckets[i+increment-1].close
    candles.push({
      time: time,
      close: close
    })
    closes.push(close)
  }
  return {
    candles:candles,
    closes:closes
  }
}

async function start() {
  var client = await initClient()
  async function next() {
    var market = await getCurrentMarket(client,24*60,15)
    var signal = await getRsiSignal(market.closes,11,55,25)
    console.log(signal,new Date().toUTCString())
  }
  next()
  setInterval(next,15*60000)
}

start()
