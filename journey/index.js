const log = require('./log')
const bitmex = require('./bitmex')
const strategy = require('./strategy')

async function next() {
  let position = await bitmex.getPosition()
  let margin = await bitmex.getMargin()
  let market = await bitmex.getMarket(24*60,15)
  let rsiSignal = await strategy.getSignal(market.closes,11,57,35)
  let bankroll = {
    capitalUSD: 1000,
    riskPerTradePercent: 0.01,
    profitFactor: 1.69,
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

start()
