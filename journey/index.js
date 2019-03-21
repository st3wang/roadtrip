const log = require('./log')
const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')
const shoes = require('./shoes')
const setup = shoes.setup

global.bitmex = bitmex
global.log = log

var entrySignal

console.log('setup', JSON.stringify(setup))
function testCheckPosition() {
  var interval = 500
  var order = {
    entryPrice: 3900,
    positionSizeUSD: 1000,
    stopLossTrigger: 3860.5,
    stopLoss: 3860,
    takeProfitTrigger: 4000.5,
    takeProfit: 40001
  }
  var testArgs1 = [
    [order.positionSizeUSD,order.entryPrice,order.entryPrice+0.5,order],
    [order.positionSizeUSD,order.entryPrice+1,order.entryPrice+1.5,order],
    [order.positionSizeUSD,order.stopLoss,order.stopLoss+0.5,order],
    [order.positionSizeUSD,order.stopLoss,order.stopLoss+0.5,order],
    [order.positionSizeUSD,order.stopLoss+1,order.stopLoss+1.5,order],
    // [order.positionSizeUSD,order.stopLoss-2,order.stopLoss-1.5,order]
  ]
  testArgs1.forEach((args,i) => {
    setTimeout(() => {
      checkPosition.apply(this, args);
    }, interval*(i+1))
  })
}

function isFundingWindow(fundingTimestamp) {
  var fundingTime = new Date(fundingTimestamp).getTime()
  var checkFundingPositionTime = fundingTime - 1800000
  var now = new Date().getTime()
  return (now > checkFundingPositionTime)
}

function isInPositionTooLong(timestamp,signal) {
  if (Math.abs(signal.lossDistancePercent) > 0.002) {
    var time = new Date(timestamp).getTime()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    var tooLong = delta > (3000000)
    console.log('isInPositionTooLong',tooLong)
    return tooLong
  }
}

async function checkPositionCallback(timestamp,candleTimeOffset,positionSize,bid,ask,fundingTimestamp,fundingRate) { try {
  return await checkPosition(timestamp,candleTimeOffset,positionSize,bid,ask,fundingTimestamp,fundingRate,entrySignal)
} catch(e) {console.error(e.stack||e);debugger} }

async function checkPosition(timestamp,candleTimeOffset,positionSize,bid,ask,fundingTimestamp,fundingRate,signal) { try {
  console.log('checkPosition')
  var action = {}
  if (positionSize > 0) {
    // LONG
    if (isInPositionTooLong(timestamp,signal) || (isFundingWindow(fundingTimestamp) && fundingRate > 0)) {
      action.exit = {price:ask}
    }
    else if (ask >= signal.takeProfitTrigger) {
      action.exit = {price:signal.takeProfit}
    }
  } 
  else if (positionSize < 0) {
    // SHORT 
    if (isInPositionTooLong(timestamp,signal) || (isFundingWindow(fundingTimestamp) && fundingRate < 0)) {
      action.exit = {price:bid}
    }
    else if (bid <= signal.takeProfitTrigger) {
      action.exit = {price:signal.takeProfit}
    }
  }
  else {
    var newEntryOrder = bitmex.findNewLimitOrder(signal.entryPrice,signal.positionSizeUSD)
    if (newEntryOrder) {
      // Check our ourder in the orderbook. Cancel the order if it has reached the target.
      if (signal.positionSizeUSD > 0) {
        // LONG
        if (isFundingWindow(fundingTimestamp) && fundingRate > 0) {
          console.log('New LONG will have to pay. Cancel trade.')
          action.cancel = {}
        }
        else if (ask >= signal.takeProfit) {
          console.log('Missed LONG trade. Cancel trade.', bid, ask, JSON.stringify(newEntryOrder), signal)
          action.cancel = {}
        }
      }
      else {
        // SHORT
        if (isFundingWindow(fundingTimestamp) && fundingRate < 0) {
          console.log('New SHORT will have to pay. Cancel trade.')
          action.cancel = {}
        }
        else if (bid <= signal.takeProfit) {
          console.log('Missed SHORT trade', bid, ask, JSON.stringify(newEntryOrder), signal)
          await bitmex.cancelAll()
        }
      }
    }
  }

  var response
  if (action.exit) {
    response = await bitmex.exit('',action.exit.price,-positionSize)
  }
  else if (action.cancel) {
    response = await bitmex.cancelAll()
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function next() { try {
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
    let instrument = bitmex.getInstrument()

    if (position.currentQty != 0) {
      console.log('Already in a position',position.currentQty)
    }
    else if (isFundingWindow(instrument.fundingTimestamp) &&
      ((signal.positionSizeUSD > 0 && instrument.fundingRate > 0) || 
      (signal.positionSizeUSD < 0 && instrument.fundingRate < 0))) {
        console.log('Funding ' + signal.type + ' will have to pay. Do not enter.',
          JSON.stringify(fundingStopLoss))
    }
    else {
      orderSent = await bitmex.enter(signal,margin)
    }
  }
  if (orderSent) {
    entrySignal = signal
    log.writeEntrySignal(signal)
  }
  log.writeInterval(rsiSignal,market,setup.bankroll,position,margin,signal,orderSent)
} catch(e) {console.error(e.stack||e);debugger} }

async function getMarketCsv() { try {
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
} catch(e) {console.error(e.stack||e);debugger} }

function getOrderCsv(order,execution,stopLoss,takeProfit,stopMarket) {
  var status = order.ordStatus.toUpperCase()
  var side = execution=='ENTER'?(order.side=='Buy'?'LONG':'SHORT'):(order.side=='Buy'?'SHORT':'LONG')

  return order.timestamp+','+
    execution+'-'+side+'-'+status+','+
    (order.price||order.stopPx)+','+order.orderQty+','+stopLoss+','+takeProfit+','+stopMarket+'\n'
}

async function getTradeCsv() { try {
  var yesterday = new Date().getTime() - (24*60*60000)
  var orders = await bitmex.getOrders(yesterday)
  var csv = 'Date,Type,Price,Quantity,StopLoss,TakeProfit,StopMarket\n'
  for (var i = 0; i < orders.length; i++) {
    var entryOrder = orders[i]
    var signal = log.findEntrySignal(entryOrder.timestamp,entryOrder.price,entryOrder.orderQty*(entryOrder.side=='Buy'?1:-1))
    var stopLoss = 0
    var takeProfit = 0 
    var stopMarket = 0 
    if (signal) {
      stopLoss = signal.stopLoss
      takeProfit = signal.takeProfit
      stopMarket = signal.stopMarket
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
} catch(e) {console.error(e.stack||e);debugger} }

async function getFundingCsv() { try {
  var csv = 'Date,Rate\n'
  var fundings = await bitmex.getFundingHistory()
  fundings.push(bitmex.getNextFunding())
  fundings.forEach(funding => {
    csv += funding.timestamp+','+funding.fundingRate+'\n'
  })
  return csv
} catch(e) {console.error(e.stack||e);debugger} }

async function start() { try {
  await log.init()
  entrySignal = log.readEntrySignal()
  await bitmex.init(checkPositionCallback)
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
} catch(e) {console.error(e.stack||e);debugger} }

start()