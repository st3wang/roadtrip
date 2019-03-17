const sheets = require('./sheets')
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
  // TODO: move position logic from strategy.js to bitmex.js
  let position = bitmex.getPosition()
  let margin = await bitmex.getMargin()
  let market = await bitmex.getMarket(15,96) // one day of 15 minutes candles
  let rsiSignal = await strategy.getSignal(market.closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)

  // if (shoes.test) {
  //   rsiSignal.condition = 'LONG'
  //   position.currentQty = 0
  // }
  
  var order = await strategy.getOrder(rsiSignal,market,setup.bankroll,position,margin)
  var orderSent = false

  // if (shoes.test) {
  //   debugger
  //   var distance = 0.5
  //   order.type = 'SHORT'
  //   order.entryPrice = 3718.5
  //   order.leverage = 1
  //   if (order.type == 'LONG') {
  //     order.stopLoss = order.entryPrice - distance
  //     order.stopMarketTrigger = order.entryPrice - distance*4
  //     order.takeProfit = order.entryPrice + distance
  //     order.positionSizeUSD = 1
  //   }
  //   else {
  //     order.stopLoss = order.entryPrice + distance
  //     order.stopMarketTrigger = order.entryPrice + distance*4
  //     order.takeProfit = order.entryPrice - distance
  //     order.positionSizeUSD = -1
  //   }
  //   order.stopLossTrigger = order.stopLoss
  //   order.takeProfitTrigger = order.takeProfit
  // }

  if (order.type == 'SHORT' || order.type == 'LONG') {
    orderSent = await bitmex.enter(order,margin)
  }
  log.writeInterval(rsiSignal,market,setup.bankroll,position,margin,order,orderSent)
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
    var entryOrderRecord = log.findEntryOrder(entryOrder.price,entryOrder.orderQty*(entryOrder.side=='Buy'?1:-1))
    var stopLoss = 0
    var takeProfit = 0 
    var stopMarket = 0 
    if (entryOrderRecord) {
      stopLoss = entryOrderRecord.stopLoss
      takeProfit = entryOrderRecord.takeProfit
      stopMarket = entryOrderRecord.stopMarket
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
  var delay = 0 // delay after candle close
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