
const winston = require('winston')
const shoes = require('../shoes')
const {symbol,account,setup} = shoes
const oneCandleMs = setup.candle.interval*60000
const oneCandleEndMs = oneCandleMs-1
const oneDayMS = 24*60*60000

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

var currentCandle

const {getTimeNow, isoTimestamp, colorizer} = global

async function getCurrentMarket() { try {
} catch(e) {logger.error(e.stack||e);debugger} }

async function getCurrentCandle() {
  return currentCandle
}

async function init(sp,checkPositionCb) { try {

} catch(e) {logger.error(e.stack||e);debugger} }

module.exports = {
  init: init,
  getCurrentMarket: getCurrentMarket,
  getCurrentCandle : getCurrentCandle
}