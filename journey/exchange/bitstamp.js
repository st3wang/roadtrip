const bitstampdata = require('./bitstampdata')
const winston = require('winston')
const shoes = require('../shoes')
const {symbol,account,setup} = shoes
const oneCandleMs = setup.candle.interval*60000

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
    marketCache = await bitstampdata.readMarket('btcusd',60,startTime,endTime)
  }
  else {
    marketCache = await bitstampdata.getMarket('btcusd',60,startTime,endTime)
  }
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

async function init() { try {

} catch(e) {logger.error(e.stack||e);debugger} }

module.exports = {
  init: init,
  getCurrentMarket: getCurrentMarket,
}