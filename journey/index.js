const sheets = require('./sheets')
const log = require('./log')
const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')

async function next() {
  let position = await bitmex.getPosition()
  let margin = await bitmex.getMargin()
  let market = await bitmex.getMarket(15,96) // one day of 15 minutes candles
  let rsiSignal = await strategy.getSignal(market.closes,11,70,35)
  let bankroll = {
    capitalUSD: 1000,
    riskPerTradePercent: 0.01,
    profitFactor: 1.69,
    stopMarketFactor: 1.30,
    stopLossLookBack: 2,
    minimumStopLoss: 0.001
  }

  // test
  // rsiSignal.condition = 'LONG'
  // position.currentQty = 0
  
  var order = strategy.getOrder(rsiSignal,market,bankroll,position,margin)
  var orderSent = false
  if (order.type == 'SHORT' || order.type == 'LONG') {
    orderSent = await bitmex.enter(order,margin)
  }
  log.writeInterval(rsiSignal,market,bankroll,position,margin,order,orderSent)
}

async function start() {
  await log.init()
  await bitmex.init(log.writeExit)
  await server.init(getMarketCsv,getTradeCsv)

  next()
  var now = new Date().getTime()
  var interval = 15*60000
  var delay = 15000 // bitmex bucket data delay. it will be faster with WS
  var startIn = interval-now%(interval) + delay
  var startInSec = startIn % 60000
  var startInMin = (startIn - startInSec) / 60000
  console.log('next one in ' + startInMin + ':' + Math.floor(startInSec/1000) + ' minutes')
  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startIn)
}

async function getMarketCsv() {
  var market = await bitmex.getMarket(15,96)
  var csv = 'Date,Open,High,Low,Close,Volume\n'
  market.candles.forEach(candle => {
    csv += //new Date(candle.time).toUTCString()
    candle.time+','+candle.open+','+candle.high+','+candle.low+','+candle.close+',0\n'
  })
  return csv
}

async function getTradeCsv() {
  var trades = await sheets.getTrades()
  var csv = 'Date,Type,Price,Quantity\n'
  trades.forEach(t => {
    // { date: data[2].date, type: "buy", price: data[2].low, quantity: 1000 }
    csv += //new Date(t[0]).toUTCString()
    t[0]+','+'buy'+','+t[5]+','+t[18]+'\n'
    if (t[9].length > 0) {
      csv += //new Date(t[9]).toUTCString()
      t[9]+','+'sell'+','+t[10]+','+t[18]+'\n'
    }
  })
  return csv
}

start()