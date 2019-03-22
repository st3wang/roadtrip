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

function isInPositionForTooLong(signal) {
  if (signal && Math.abs(signal.lossDistancePercent) > 0.002) {
    var time = new Date().getTime()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    var tooLong = delta > (3500000) // 1hr
    // console.log('isInPositionForTooLong',tooLong,signal.timestamp)
    return tooLong
  }
}

async function checkPositionCallback(timestamp,positionSize,bid,ask,fundingTimestamp,fundingRate) { try {
  return await checkPosition(timestamp,positionSize,bid,ask,fundingTimestamp,fundingRate,entrySignal)
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrderSignalWithCurrentCandle(margin) {
  var timestamp = new Date().toISOString()
  var market = await bitmex.getMarketWithCurrentCandle(15,96)
  var closes = market.closes
  var lastPrice = closes[closes.length-1]
  if (!lastPrice) debugger
  var rsiSignal = await strategy.getSignal(closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)
  var conservativeCloses, conservativeRsiSignal
  
  console.log('getOrderSignalWithCurrentCandle rsiSignal', rsiSignal.prsi.toFixed(1),rsiSignal.rsi.toFixed(1),rsiSignal.condition)

  if (rsiSignal.condition == 'LONG') { 
    conservativeCloses = market.closes.slice(1)
    conservativeCloses.push(lastPrice-0.5)
    conservativeRsiSignal = await strategy.getSignal(closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)
  }
  else if (rsiSignal.condition == 'SHORT') {
    conservativeCloses = market.closes.slice(1)
    conservativeCloses.push(lastPrice+0.5)
    conservativeRsiSignal = await strategy.getSignal(closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)
  }

  if (conservativeRsiSignal) {
    console.log(timestamp, 'getOrderSignalWithCurrentCandle conservativeRsiSignal', conservativeRsiSignal.prsi.toFixed(1),conservativeRsiSignal.rsi.toFixed(1),conservativeRsiSignal.condition)
  }
  else {
    console.log(timestamp, 'getOrderSignalWithCurrentCandle conservativeRsiSignal null')
  }

  if (conservativeRsiSignal && conservativeRsiSignal.condition == rsiSignal.condition) {
    let orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,margin)
    console.log(timestamp, 'getOrderSignalWithCurrentCandle orderSignal', orderSignal.type,orderSignal.entryPrice,orderSignal.positionSizeBTC,orderSignal.stopLoss,orderSignal.takeProfit)
    return orderSignal
  }
}

async function getOrderSignal(margin) {
  var timestamp = new Date().toISOString()
  var market = await bitmex.getMarket(15,96)
  var closes = market.closes
  // var lastPrice = closes[closes.length-1]
  var rsiSignal = await strategy.getSignal(closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)
  
  console.log(timestamp, 'getOrderSignal rsiSignal',rsiSignal.prsi.toFixed(1),rsiSignal.rsi.toFixed(1),rsiSignal.condition)

  let orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,margin)
  console.log(timestamp, 'getOrderSignal orderSignal', orderSignal.type,orderSignal.entryPrice,orderSignal.positionSizeBTC,orderSignal.stopLoss,orderSignal.takeProfit)
  return orderSignal
}

async function checkPosition(timestamp,positionSize,bid,ask,fundingTimestamp,fundingRate,signal) { try {
  var action = {}
  if (positionSize > 0) {
    // LONG
    if (isInPositionForTooLong(signal) || (isFundingWindow(fundingTimestamp) && fundingRate > 0)) {
      action.exit = {price:ask}
    }
    else if (ask >= signal.takeProfitTrigger) {
      action.exit = {price:Math.max(signal.takeProfit,ask)}
    }
  } 
  else if (positionSize < 0) {
    // SHORT 
    if (isInPositionForTooLong(signal) || (isFundingWindow(fundingTimestamp) && fundingRate < 0)) {
      action.exit = {price:bid}
    }
    else if (bid <= signal.takeProfitTrigger) {
      action.exit = {price:Math.min(signal.takeProfit,bid)}
    }
  }
  else {
    let candleTimeOffset = bitmex.getCandleTimeOffset()
    console.log('candleTimeOffset',candleTimeOffset)
    let margin = await bitmex.getMargin()
    let newEntryOrder = bitmex.findNewLimitOrder(signal.entryPrice,signal.positionSizeUSD)
    
    let orderSignal
    if (candleTimeOffset >= 894000) {
      orderSignal = await getOrderSignalWithCurrentCandle(margin)
    }
    else if (candleTimeOffset <= 6000) {
      orderSignal = await getOrderSignal(margin)
    }

    if (orderSignal && (orderSignal.type == 'SHORT' || orderSignal.type == 'LONG')) {
      if (isFundingWindow(fundingTimestamp) &&
        ((orderSignal.positionSizeUSD > 0 && fundingRate > 0) || 
        (orderSignal.positionSizeUSD < 0 && fundingRate < 0))) {
          console.log('Funding ' + orderSignal.type + ' will have to pay. Do not enter.')
      }
      else {
        action.enter = {signal,orderSignal,margin}
      }
    }
    // log.writeInterval(rsiSignal,market,setup.bankroll,position,margin,orderSignal,orderSent)
    
    if (!action.enter && newEntryOrder) {
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
          action.cancel = {}
        }
      }
    }
  }

  var response
  if (action.enter) {
    let orderSent = await bitmex.enter(orderSignal,margin)
    if (orderSent) {
      entrySignal = orderSignal
      log.writeEntrySignal(orderSignal)
    }
  }
  else if (action.exit) {
    response = await bitmex.exit('',action.exit.price,-positionSize)
  }
  else if (action.cancel) {
    response = await bitmex.cancelAll()
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function next() { try {
  var position = bitmex.getPosition()
  var instrument = bitmex.getInstrument()
  checkPosition(new Date().toISOString(), position.currentQty, 
  instrument.bidPrice, instrument.askPrice, instrument.fundingTimestamp, instrument.fundingRate, entrySignal)
} catch(e) {console.error(e.stack||e);debugger} }

async function getMarketCsv() { try {
  var market = await bitmex.getMarketWithCurrentCandle(15,96)
  var rsis = await strategy.getRsi(market.closes,setup.rsi.length)
  var csv = 'Date,Open,High,Low,Close,Rsi\n'
  market.candles.forEach((candle,i) => {
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

function createInterval(candleDelay) {
  var now = new Date().getTime()
  var interval = 15*60000
  var startIn = interval-now%(interval) + candleDelay
  var startInSec = startIn % 60000
  var startInMin = (startIn - startInSec) / 60000
  console.log('next one in ' + startInMin + ':' + Math.floor(startInSec/1000) + ' minutes')
  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startIn)
}

async function start() { try {
  // var rsi1 = await strategy.getRsi([4000,4001,4002,4003,4004,4005,4006,4010,4011,4010],2)
  // var rsi2 = await strategy.getRsi([4000,4001,4002,4003,4004,4005,4006,4010,4011,4009],2)
  // debugger
  await log.init()
  entrySignal = log.readEntrySignal()
  await bitmex.init(checkPositionCallback)
  await server.init(getMarketCsv,getTradeCsv,getFundingCsv)

  next()
  createInterval(-5000)
  createInterval(0)
  createInterval(5000)
} catch(e) {console.error(e.stack||e);debugger} }

start()