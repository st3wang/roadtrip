const log = require('./log')
const winston = require('winston')
const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')
const shoes = require('./shoes')
const setup = shoes.setup

global.bitmex = bitmex
global.log = log

// const { createLogger, format, transports } = require('winston');
// const { combine, timestamp, label, printf } = format;
const colorizer = winston.format.colorize();

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date().toISOString()
  return info;
});

const logger = winston.createLogger({
  format: winston.format.label({label:'index'}),
  transports: [
    new winston.transports.Console({
      level:shoes.log.level||'info',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.prettyPrint(),
        winston.format.printf(info => {
          let splat = info[Symbol.for('splat')]
          let log = `${info.timestamp} [` + colorizer.colorize(info.level,`${info.label}`) + `] ${info.message} `
          switch(info.message) {
            case 'checkPosition':
              let {walletBalance,entryPrice,lastPrice,positionSize,signal} = splat[0]
              if (positionSize > 0) {
                positionSize = '\x1b[36;1m' + positionSize + '\x1b[39m'
                lastPrice = (lastPrice >= entryPrice ? '\x1b[32;1m' : '\x1b[31;1m') + (lastPrice?lastPrice.toFixed(1):lastPrice) + '\x1b[39m'
              }
              else if (positionSize < 0) {
                positionSize = '\x1b[35;1m' + positionSize + '\x1b[39m'
                lastPrice = (lastPrice <= entryPrice ? '\x1b[32;1m' : '\x1b[31;1m') + (lastPrice?lastPrice.toFixed(1):lastPrice) + '\x1b[39m'
              }
              else {
                lastPrice = (lastPrice?lastPrice.toFixed(1):lastPrice) 
              }
              log += 'W:'+(walletBalance?(walletBalance/100000000).toFixed(5):walletBalance)+' L:'+lastPrice+' P:'+positionSize+
                ' E:'+(signal.entryPrice?signal.entryPrice.toFixed(1):signal.entryPrice)+' S:'+(signal.stopLoss?signal.stopLoss.toFixed(1):signal.stopLoss)+' T:'+(signal.takeProfit?signal.takeProfit.toFixed(1):signal.takeProfit)
              break
            case 'enterSignal':
              let {rsiSignal,conservativeRsiSignal,orderSignal} = splat[0]
              if (rsiSignal) {
                log += rsiSignal.condition+' '+rsiSignal.prsi.toFixed(1)+' '+rsiSignal.rsi.toFixed(1)
              }
              if (conservativeRsiSignal) {
                log += ' '+conservativeRsiSignal.condition+' '+conservativeRsiSignal.prsi.toFixed(1)+' '+conservativeRsiSignal.rsi.toFixed(1)
              }
              if (orderSignal) {
                log += ' '+orderSignal.type+' '+(orderSignal.entryPrice?orderSignal.entryPrice.toFixed(1):orderSignal.entryPrice)+' '+orderSignal.positionSizeUSD+' '+(orderSignal.lossDistance?orderSignal.lossDistance.toFixed(1):orderSignal.lossDistance)
              }
              break
            default:
              log += (splat ? `${JSON.stringify(splat)}` : '')
          }
          return log
        })
      ),
    }),
    new winston.transports.File({filename:'combined.log',
      level:'debug',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    })
  ]
});

var entrySignal

logger.info('setup', setup)

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

var cutOffTimeForAll = 4*60*60000
var cutOffTimeForLargeTrade = 59*60000

function isInPositionForTooLong(signal) {
  if (signal) {
    var time = new Date().getTime()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    return (delta > cutOffTimeForAll || 
      (delta > cutOffTimeForLargeTrade && Math.abs(signal.lossDistancePercent) > 0.002))
  }
}

async function checkPositionCallback(params) { try {
  params.signal = entrySignal
  return await checkPosition(params)
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrderSignalWithCurrentCandle(availableMargin) {
  var market = await bitmex.getMarketWithCurrentCandle(15,96)
  var closes = market.closes
  var lastPrice = closes[closes.length-1]
  if (!lastPrice) debugger
  var rsiSignal = await strategy.getSignal(closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)
  var conservativeCloses, conservativeRsiSignal, orderSignal
  
  // logger.verbose('getOrderSignalWithCurrentCandle rsiSignal', rsiSignal)

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

  // if (conservativeRsiSignal) {
  //   logger.verbose('getOrderSignalWithCurrentCandle conservativeRsiSignal', conservativeRsiSignal)
  // }
  // else {
  //   logger.verbose('getOrderSignalWithCurrentCandle conservativeRsiSignal null')
  // }

  if (conservativeRsiSignal && conservativeRsiSignal.condition == rsiSignal.condition) {
    orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,availableMargin)
    // logger.verbose('getOrderSignalWithCurrentCandle orderSignal', orderSignal)
  }
  return {rsiSignal:rsiSignal,conservativeRsiSignal:conservativeRsiSignal,orderSignal:orderSignal}
}

async function getOrderSignal(availableMargin) {
  var market = await bitmex.getMarket(15,96)
  var closes = market.closes
  // var lastPrice = closes[closes.length-1]
  var rsiSignal = await strategy.getSignal(closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)
  
  // logger.verbose('getOrderSignal rsiSignal',rsiSignal)

  let orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,availableMargin)
  // logger.verbose('getOrderSignal orderSignal',orderSignal)
  return {rsiSignal:rsiSignal,orderSignal:orderSignal}
}

function exitFunding({positionSize,bid,ask,fundingTimestamp,fundingRate}) {
  var exit 
  if (positionSize > 0 && fundingRate > 0) {
    if (isFundingWindow(fundingTimestamp)) exit = {price:ask,reason:'funding'}
  } 
  else if (positionSize < 0 && fundingRate < 0) {
    if (isFundingWindow(fundingTimestamp)) exit = {price:bid,reason:'funding'}
  }
  return exit
}

function exitTooLong({positionSize,bid,ask,signal}) {
  var exit
  if (positionSize > 0) {
    if (isInPositionForTooLong(signal)) exit = {price:ask,reason:'toolong'}
  }
  else if (positionSize < 0) {
    if (isInPositionForTooLong(signal)) exit = {price:bid,reason:'toolong'}
  }
  return exit
}

function exitTarget({positionSize,bid,ask,signal}) {
  var {takeProfitTrigger,takeProfit} = signal
  var exit
  if (positionSize > 0) {
    if (ask >= takeProfitTrigger) exit = {price:Math.max(takeProfit,ask),reason:'target'}
  } 
  else if (positionSize < 0) {
    if (bid <= takeProfitTrigger) exit = {price:Math.min(takeProfit,bid),reason:'target'}
  }
  return exit
}

function cancelOrder(params) {
  var {positionSize,signal} = params
  
  if (positionSize != 0) return

  var cancel
  let newEntryOrder = bitmex.findNewLimitOrder(signal.entryPrice,signal.positionSizeUSD)
  if (newEntryOrder) {
    let exit
    params.signal = Object.assign({},signal)
    params.signal.takeProfitTrigger = params.signal.takeProfit

    if (exit = (exitTooLong(params) || exitFunding(params) || exitTarget(params))) {
      cancel = {reason:exit.reason}
    }
  }
  return cancel
}

async function enterSignal({positionSize,fundingTimestamp,fundingRate,availableMargin}) { try {
  if (positionSize != 0) return

  var enter
  let candleTimeOffset = bitmex.getCandleTimeOffset()
  
  let signals, orderSignal
  if (candleTimeOffset >= 894000) {
    signals = await getOrderSignalWithCurrentCandle(availableMargin)
    orderSignal = signals.orderSignal
    logger.info('enterSignal',signals)
  }
  else if (candleTimeOffset <= 6000) {
    signals = await getOrderSignal(availableMargin)
    orderSignal = signals.orderSignal
    logger.info('enterSignal',signals)
  }

  if (orderSignal && (orderSignal.type == 'SHORT' || orderSignal.type == 'LONG')) {
    if (isFundingWindow(fundingTimestamp) &&
      ((orderSignal.positionSizeUSD > 0 && fundingRate > 0) || 
      (orderSignal.positionSizeUSD < 0 && fundingRate < 0))) {
        logger.info('Funding ' + orderSignal.type + ' will have to pay. Do not enter.')
    }
    else {
      enter = {signal:orderSignal}
    }
  }
  return enter
} catch(e) {console.error(e.stack||e);debugger} }

async function checkPosition(params) { try {
  logger.info('checkPosition',params)

  var exit, cancel, enter
  if (exit = exitTooLong(params) || exitFunding(params) || exitTarget(params)) {
    logger.info('EXIT',exit)
    response = await bitmex.exit('',exit.price,-params.positionSize)
  }
  else {
    if (cancel = cancelOrder(params)) {
      logger.info('CANCEL',cancel)
      response = await bitmex.cancelAll()
    }
    if (enter = await enterSignal(params)) {
      logger.info('ENTER',enter)
      let orderSent = await bitmex.enter(enter.signal)
      if (orderSent) {
        entrySignal = enter.signal
        log.writeEntrySignal(enter.signal)
        log.writeOrderSignal(setup.bankroll,enter.signal)
      }
    }
  }
  // log.writeInterval(rsiSignal,market,setup.bankroll,position,margin,orderSignal,orderSent)
} catch(e) {console.error(e.stack||e);debugger} }

async function next() { try {
  checkPosition(bitmex.checkPositionParams)
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
  logger.info('next one in ' + startInMin + ':' + Math.floor(startInSec/1000) + ' minutes')
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
  createInterval(500)
  createInterval(5000)
} catch(e) {console.error(e.stack||e);debugger} }

start()