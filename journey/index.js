const log = require('./log')
const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')
const shoes = require('./shoes')
const setup = shoes.setup

global.bitmex = bitmex
global.log = log

console.log('setup', JSON.stringify(setup))

async function next() {
  let position = bitmex.getPosition()
  let margin = await bitmex.getMargin()
  let market = await bitmex.getMarket(15,96) // one day of 15 minutes candles
  let rsiSignal = await strategy.getSignal(market.closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)

  // if (shoes.test) {
  //   rsiSignal.condition = 'LONG'
  //   position.currentQty = 0
  // }
  
  var signal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,margin)
  var orderSent = false

  // if (shoes.test) {
  //   debugger
  //   var distance = 0.5
  //   signal.type = 'SHORT'
  //   signal.entryPrice = 3718.5
  //   signal.leverage = 1
  //   if (signal.type == 'LONG') {
  //     signal.stopLoss = signal.entryPrice - distance
  //     signal.stopMarketTrigger = signal.entryPrice - distance*4
  //     signal.takeProfit = signal.entryPrice + distance
  //     signal.positionSizeUSD = 1
  //   }
  //   else {
  //     signal.stopLoss = signal.entryPrice + distance
  //     signal.stopMarketTrigger = signal.entryPrice + distance*4
  //     signal.takeProfit = signal.entryPrice - distance
  //     signal.positionSizeUSD = -1
  //   }
  //   signal.stopLossTrigger = signal.stopLoss
  //   signal.takeProfitTrigger = signal.takeProfit
  // }

  if (signal.type == 'SHORT' || signal.type == 'LONG') {
    orderSent = await bitmex.enter(signal,margin)
  }
  log.writeInterval(rsiSignal,market,setup.bankroll,position,margin,signal,orderSent)
}

async function getMarketCsv() {
  var market = await bitmex.getMarket(15,96)
  var currentCandle = await bitmex.getCurrentCandle()
  var candles = market.candles.slice(1)
  var closes = market.closes.slice(1)
  candles.push(currentCandle)
  closes.push(currentCandle.close)

  var rsis = await strategy.getRsi(closes,setup.rsi.length)
  var csv = 'Date,Open,High,Low,Close,Rsi\n'
  candles.forEach((candle,i) => {
    csv += //new Date(candle.time).toUTCString()
    candle.time+','+candle.open+','+candle.high+','+candle.low+','+candle.close+','+rsis[i]+'\n'
  })
  return csv
}

function getOrderCsv(order,execution,stopLoss,takeProfit,stopMarket) {
  var status = order.ordStatus.toUpperCase()
  var side = execution=='ENTER'?(order.side=='Buy'?'LONG':'SHORT'):(order.side=='Buy'?'SHORT':'LONG')

  return order.timestamp+','+
    execution+'-'+side+'-'+status+','+
    (order.price||order.stopPx)+','+order.orderQty+','+stopLoss+','+takeProfit+','+stopMarket+'\n'
}

async function getTradeCsv() {
  var yesterday = new Date().getTime() - (24*60*60000)
  var orders = await bitmex.getOrders(yesterday)
  var csv = 'Date,Type,Price,Quantity,StopLoss,TakeProfit,StopMarket\n'
  for (var i = 0; i < orders.length; i++) {
    var entryOrder = orders[i]
    var entrySignal = log.findEntrySignal(entryOrder.timestamp,entryOrder.price,entryOrder.orderQty*(entryOrder.side=='Buy'?1:-1))
    var stopLoss = 0
    var takeProfit = 0 
    var stopMarket = 0 
    if (entrySignal) {
      stopLoss = entrySignal.stopLoss
      takeProfit = entrySignal.takeProfit
      stopMarket = entrySignal.stopMarket
    }
    csv += getOrderCsv(entryOrder,'ENTER',stopLoss,takeProfit,stopMarket)

    var exitOrder = orders[i+1]
    while (exitOrder && exitOrder.orderQty === entryOrder.orderQty && exitOrder.side !== entryOrder.side) {
      csv += getOrderCsv(exitOrder,'EXIT',stopLoss,takeProfit,stopMarket)
      i++
      exitOrder = orders[i+1]
    }
  }
  return csv
}

async function getFundingCsv() {
  var csv = 'Date,Rate\n'
  var fundings = await bitmex.getFundingHistory()
  fundings.push(bitmex.getNextFunding())
  fundings.forEach(funding => {
    csv += funding.timestamp+','+funding.fundingRate+'\n'
  })
  return csv
}

async function start() {
  await log.init()
  await bitmex.init(log.writeExit)
  await server.init(getMarketCsv,getTradeCsv,getFundingCsv)

  next()
  var now = new Date().getTime()
  var interval = 15*60000
  var delay = 3000 // delay after candle close
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