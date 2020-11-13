const coinbasedata = require('./coinbasedata')
const winston = require('winston')
const shoes = require('../shoes')
const {symbol,account,setup} = shoes
const oneCandleMs = setup.candle.interval*60000
const name = 'coinbase'
const symbols = {
  XBTUSD: 'BTC-USD'
}

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

async function init() { try {

} catch(e) {logger.error(e.stack||e);debugger} }

module.exports = {
  name: name,
  init: init,
  getCurrentMarket: getCurrentMarket,
  symbols: symbols
}