const util = require('util')
const fs = require('fs')
const ymdHelper = require('./ymdHelper')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}

async function getMarket(exchange,interval,startYmd,endYmd) { try {
  console.log('getMarket',startYmd,endYmd,interval)
  var opens = [], highs = [], lows = [], closes = []
  for (var ymd = startYmd; ymd <= endYmd; ymd = ymdHelper.nextDay(ymd)) {
    var path = 'data/' + exchange + '/candle/' + interval + '/' + ymd + '.json'
    var marketString = await readFile(path,readFileOptions)
    var market = JSON.parse(marketString)
    opens = opens.concat(market.opens)
    highs = highs.concat(market.highs)
    lows = lows.concat(market.lows)
    closes = closes.concat(market.closes)
  }
  var rsis = []
  var market = {
    opens:opens, highs:highs, lows:lows, closes:closes, rsis:rsis
  }
  fillMarketNull(market)
  return market
} catch(e) {console.error(e.stack||e);debugger} }

function fillMarketNull(market) { try {
  var closes = market.closes
  var len = closes.length
  for (var i = 0; i < len; i++) {
    if (closes[i] == null) {
      closes[i] = closes[i-1]
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  getMarket: getMarket
}