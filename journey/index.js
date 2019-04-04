const log = require('./log')
const winston = require('winston')
const path = require('path')
global.logDir = path.resolve(__dirname, 'log')

// const l = require('./logger')
const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')
const shoes = require('./shoes')
const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000
const candleLengthMS = setup.candle.interval*setup.candle.length*60000

global.bitmex = bitmex
global.log = log

// const { createLogger, format, transports } = require('winston');
// const { combine, timestamp, label, printf } = format;
const colorizer = winston.format.colorize();

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date().toISOString()
  return info;
});

function conditionColor(condition) {
  return (condition == 'LONG' ? '\x1b[36m' : condition == 'SHORT' ? '\x1b[35m' : '') + condition + '\x1b[39m'
}

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
          let {timestamp,level,message} = info
          let prefix = timestamp.substring(5).replace(/[T,Z]/g,' ')+'['+colorizer.colorize(level,'bmx')+'] '
          let line = (typeof message == 'string' ? message : JSON.stringify(message)) + ' '
          switch(message) {
            case 'checkPosition': {
              let {caller,walletBalance,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal
              let lossDistancePercentString, positionSizeString, lastPriceString
              walletBalance /= 100000000
              if (positionSize > 0) {
                positionSizeString = '\x1b[36m' + positionSize + '\x1b[39m'
                lastPriceString = (lastPrice >= entryPrice ? '\x1b[32m' : '\x1b[31m') + lastPrice.toFixed(1) + '\x1b[39m'
              }
              else if (positionSize < 0) {
                positionSizeString = '\x1b[35m' + positionSize + '\x1b[39m'
                lastPriceString = (lastPrice <= entryPrice ? '\x1b[32m' : '\x1b[31m') + lastPrice.toFixed(1) + '\x1b[39m'
              }
              else {
                positionSizeString = positionSize
                lastPriceString = lastPrice.toFixed(1)
              }
              lossDistancePercentString = Math.abs(lossDistancePercent) < 0.002 ? lossDistancePercent.toFixed(4) : ('\x1b[34m' + lossDistancePercent.toFixed(4) + '\x1b[39m')
              let now = new Date().getTime()
              let candlesInTrade = ((now - new Date(timestamp||null).getTime()) / oneCandleMS)
              candlesInTrade = (candlesInTrade >= setup.candle.inTradeMax || (Math.abs(lossDistancePercent) >= 0.002 && candlesInTrade >=3)) ? ('\x1b[33m' + candlesInTrade.toFixed(1) + '\x1b[39m') : candlesInTrade.toFixed(1)
              let candlesTillFunding = ((new Date(fundingTimestamp||null).getTime() - now)/oneCandleMS)
              candlesTillFunding = (candlesTillFunding > 1 ? candlesTillFunding.toFixed(1) : ('\x1b[33m' + candlesTillFunding.toFixed(1) + '\x1b[39m'))
              let payFunding = fundingRate*positionSize/lastPrice // /walletBalance
              payFunding = (payFunding > 0 ? '\x1b[31m' : payFunding < 0 ? '\x1b[32m' : '') + payFunding.toFixed(5) + '\x1b[39m'
              line += caller + ' W:'+walletBalance.toFixed(4)+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' T:'+takeProfit.toFixed(1)+
                ' D:'+lossDistancePercentString+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
            } break
            case 'enterSignal': {
              let {rsiSignal,conservativeRsiSignal,orderSignal} = splat[0]
              if (rsiSignal) {
                let {condition,prsi=NaN,rsi=NaN} = rsiSignal
                line += conditionColor(condition)+' '+prsi.toFixed(1)+' '+rsi.toFixed(1)
              }
              if (conservativeRsiSignal) {
                let {condition,prsi=NaN,rsi=NaN} = conservativeRsiSignal
                line += ' '+conditionColor(condition)+' '+prsi.toFixed(1)+' '+rsi.toFixed(1)
              }
              if (orderSignal) {
                let {type,entryPrice=NaN,positionSizeUSD,lossDistance=NaN,riskAmountUSD=NaN} = orderSignal
                line += ' '+conditionColor(type)+' '+entryPrice.toFixed(1)+' '+positionSizeUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)
              }
            } break
            case 'ENTER': {
              let {positionSizeUSD,entryPrice} = splat[0].signal
              line = '\x1b[34m'+line+'\x1b[39m'+positionSizeUSD+' '+entryPrice
            } break
            case 'EXIT':
            case 'CANCEL': {
              line = '\x1b[34m'+line+'\x1b[39m'+JSON.stringify(splat)
            }
            default: {
              line += (splat ? JSON.stringify(splat) : '')
            }
          }
          switch(level) {
            case 'error': {
              line = '\x1b[31m' + line + '\x1b[39m'
            } break
            case 'warn': {
              line = '\x1b[33m' + line + '\x1b[39m'
            } break
          }
          return prefix+line
        })
      ),
    }),
    new winston.transports.File({filename:global.logDir+'/'+'combined.log',
      level:'debug',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    }),
    new winston.transports.File({filename:global.logDir+'/'+'warn.log',
      level:'warn',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    })
  ]
})

const entrySignalTable = winston.createLogger({
  transports: [
    new winston.transports.File({filename:'entry_signal_table.log',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    })
  ]
})

var entrySignal

logger.info('setup', setup)

var fundingWindowTime = setup.candle.fundingWindow*setup.candle.interval*60000

function isFundingWindow(fundingTimestamp) {
  var fundingTime = new Date(fundingTimestamp).getTime()
  var checkFundingPositionTime = fundingTime - fundingWindowTime //1800000
  var now = new Date().getTime()
  return (now > checkFundingPositionTime)
}

var cutOffTimeForAll = setup.candle.inTradeMax*60000
var cutOffTimeForLargeTrade = 59*60000

function isInPositionForTooLong(signal) {
  if (signal) {
    var time = new Date().getTime()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    return (delta > cutOffTimeForAll)
     //|| (delta > cutOffTimeForLargeTrade && Math.abs(signal.lossDistancePercent) >= 0.002))
  }
}

async function getOrderSignalWithCurrentCandle(availableMargin) {
  var market = await bitmex.getMarketWithCurrentCandle()
  var closes = market.closes
  var lastPrice = closes[closes.length-1]
  var rsiSignal = await strategy.getSignal(closes,setup.rsi)
  var conservativeCloses, conservativeRsiSignal, orderSignal
  
  // logger.verbose('getOrderSignalWithCurrentCandle rsiSignal', rsiSignal)

  if (rsiSignal.condition == 'LONG') { 
    conservativeCloses = market.closes.slice(1)
    conservativeCloses.push(lastPrice-0.5)
    conservativeRsiSignal = await strategy.getSignal(closes,setup.rsi)
  }
  else if (rsiSignal.condition == 'SHORT') {
    conservativeCloses = market.closes.slice(1)
    conservativeCloses.push(lastPrice+0.5)
    conservativeRsiSignal = await strategy.getSignal(closes,setup.rsi)
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
  var market = await bitmex.getMarket()
  var closes = market.closes
  // var lastPrice = closes[closes.length-1]
  var rsiSignal = await strategy.getSignal(closes,setup.rsi)
  
  // logger.verbose('getOrderSignal rsiSignal',rsiSignal)

  let orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,availableMargin)
  // logger.verbose('getOrderSignal orderSignal',orderSignal)
  return {rsiSignal:rsiSignal,orderSignal:orderSignal}
}

function getFee(size,rate,risk) {
  var pay = size*rate
  return {
    isLarge: pay > risk/2,
    pay: pay
  }
}

function exitTooLong({positionSize,signal}) {
  if (positionSize != 0 && isInPositionForTooLong(signal)) {
    return {reason:'toolong'}
  }
  // var exit
  // if (positionSize > 0) {
  //   if (isInPositionForTooLong(signal)) exit = {price:ask,reason:'toolong'}
  // }
  // else if (positionSize < 0) {
  //   if (isInPositionForTooLong(signal)) exit = {price:bid,reason:'toolong'}
  // }
  // return exit
}

function exitFunding({positionSize,fundingTimestamp,fundingRate,signal}) {
  var fee = getFee(positionSize,fundingRate,signal.riskAmountUSD)
  if (fee.isLarge && isFundingWindow(fundingTimestamp)) {
    return {reason:'funding',pay:fee.pay,risk:signal.riskAmountUSD}
  }

  // if (positionSize > 0 && fundingRate > 0) {
  //   if (isFundingWindow(fundingTimestamp)) exit = {price:ask,reason:'funding'}
  // } 
  // else if (positionSize < 0 && fundingRate < 0) {
  //   if (isFundingWindow(fundingTimestamp)) exit = {price:bid,reason:'funding'}
  // }
  // return exit
}

function exitTargetTrigger({positionSize,bid,ask,signal}) {
  var {takeProfitTrigger,takeProfit} = signal
  var exit
  if (positionSize > 0) {
    if (ask >= takeProfitTrigger) {
      // logger.debug('exitTargetTrigger',positionSize,bid,ask,signal)
      exit = {type:'Limit',price:Math.max(takeProfit,ask),execInst:'ParticipateDoNotInitiate,ReduceOnly',reason:'targettrigger'}
    }
  } 
  else if (positionSize < 0) {
    if (bid <= takeProfitTrigger) {
      // logger.debug('exitTargetTrigger',positionSize,bid,ask,signal)
      exit = {type:'Limit',price:Math.min(takeProfit,bid),execInst:'ParticipateDoNotInitiate,ReduceOnly',reason:'targettrigger'}
    }
  }
  return exit
}

function exitTarget({positionSize,bid,ask,signal}) {
  var {takeProfit} = signal
  if (positionSize > 0) {
    if (ask >= takeProfit) return {price:Math.max(takeProfit,ask),reason:'target'}
  } 
  else if (positionSize < 0) {
    if (bid <= takeProfit) return {price:Math.min(takeProfit,bid),reason:'target'}
  }
}

function exitStopTrigger({positionSize,bid,ask,signal}) {
  var {stopLossTrigger,stopLoss} = signal
  if (positionSize > 0) {
    if (ask <= stopLossTrigger) {
      // logger.warn('exitStopTrigger',positionSize,bid,ask,signal)
      return {type:'Stop',price:stopLoss,execInst:'LastPrice,ReduceOnly',reason:'stoptrigger'}
    }
  } 
  else if (positionSize < 0) {
    if (bid >= stopLossTrigger) {
      // logger.warn('exitStopTrigger',positionSize,bid,ask,signal)
      return {type:'Stop',price:stopLoss,execInst:'LastPrice,ReduceOnly',reason:'stoptrigger'}
    }
  }
}

function exitStop({positionSize,bid,ask,signal}) {
  var {stopLoss} = signal
  if (positionSize > 0) {
    if (ask <= stopLoss) return {price:stopLoss,reason:'stop'}
  } 
  else if (positionSize < 0) {
    if (bid >= stopLoss) return {price:stopLoss,reason:'stop'}
  }
}

function cancelOrder(params) {
  var {positionSize,signal} = params
  
  if (positionSize != 0) return

  let cancelParams = Object.assign({},params)
  cancelParams.positionSize = signal.positionSizeUSD
  return (exitTooLong(cancelParams) || exitFunding(cancelParams) || exitTarget(cancelParams) || exitStop(cancelParams))
}

async function enterSignal({positionSize,fundingTimestamp,fundingRate,availableMargin}) { try {
  if (positionSize != 0) return

  var enter
  let candleTimeOffset = bitmex.getCandleTimeOffset()

  let signals, orderSignal
  if (candleTimeOffset >= setup.candle.signalTimeOffsetMax) {
    signals = await getOrderSignalWithCurrentCandle(availableMargin)
    orderSignal = signals.orderSignal
    logger.info('enterSignal',signals)
  }
  else if (candleTimeOffset <= setup.candle.signalTimeOffsetMin) {
    signals = await getOrderSignal(availableMargin)
    orderSignal = signals.orderSignal
    logger.info('enterSignal',signals)
  }

  if (orderSignal && (orderSignal.type == 'SHORT' || orderSignal.type == 'LONG') && 
    orderSignal.entryPrice && orderSignal.positionSizeUSD) {
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
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPositionCallback(params) { try {
  params.signal = entrySignal
  return await checkPosition(params)
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkEntry(params) { try {
  if (params.positionSize != 0) return
  
  var {signal} = params
  var cancel, enter
  let existingEntryOrder = bitmex.findNewLimitOrder(signal.entryPrice,signal.positionSizeUSD,'ParticipateDoNotInitiate')  
  if (existingEntryOrder && (cancel = cancelOrder(params))) {
    logger.warn('CANCEL',cancel)
    await bitmex.cancelAll()
    existingEntryOrder = null
  }
  if (!existingEntryOrder && (enter = await enterSignal(params))) {
    if (bitmex.findNewOrFilledOrder('Limit',enter.signal.entryPrice,enter.signal.positionSizeUSD,'ParticipateDoNotInitiate')) {
      logger.info('ENTRY ORDER EXISTS')
    }
    else {
      logger.info('ENTER',enter)
      let orderSent = await bitmex.orderEnter(enter.signal)
      if (orderSent) {
        entrySignal = enter.signal
        entrySignalTable.info('entry',entrySignal)
        log.writeEntrySignal(entrySignal) // current trade
        log.writeOrderSignal(setup.bankroll,entrySignal) // trade
      }
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(params) { try {
  let {positionSize,bid,ask} = params
  if (positionSize == 0) return

  var exit = exitTooLong(params) || exitFunding(params) || exitTargetTrigger(params) || exitStopTrigger(params)
  if (exit) {
    exit.price = exit.price || (positionSize < 0 ? bid : ask)
    exit.type = exit.type || 'Limit'
    exit.execInst = exit.execInst || 'ParticipateDoNotInitiate,ReduceOnly'
    let existingOrder = bitmex.findNewOrFilledOrder(exit.type,exit.price,-params.positionSize,exit.execInst)
    if (existingOrder) {
      logger.debug('EXIT EXISTING ORDER',exit)
      return existingOrder
    }

    logger.info('EXIT',exit)
    if (exit.reason == 'stoptrigger') {
      return await bitmex.orderStopMarketRetry(exit.price,-params.positionSize)
    }
    else {
      return await bitmex.orderExit('',exit.price,-params.positionSize)
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPosition(params) { try {
  logger.info('checkPosition',params)
  if (!(await checkExit(params))) {
    await checkEntry(params)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function next() { try {
  bitmex.checkPositionParams.caller = 'interval'
  bitmex.checkPositionParams.signal = entrySignal
  checkPosition(bitmex.checkPositionParams)
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarketCsv() { try {
  var market = await bitmex.getMarketWithCurrentCandle()
  var rsis = await strategy.getRsi(market.closes,setup.rsi.length)
  var csv = 'Date,Open,High,Low,Close,Rsi\n'
  market.candles.forEach((candle,i) => {
    csv += //new Date(candle.time).toUTCString()
    candle.time+','+candle.open+','+candle.high+','+candle.low+','+candle.close+','+rsis[i]+'\n'
  })
  return csv
} catch(e) {logger.error(e.stack||e);debugger} }

function getOrderCsv(order,execution,stopLoss,takeProfit,stopMarket) {
  var status = order.ordStatus.toUpperCase()
  var side = execution=='ENTER'?(order.side=='Buy'?'LONG':'SHORT'):(order.side=='Buy'?'SHORT':'LONG')

  return order.timestamp+','+
    execution+'-'+side+'-'+status+','+
    (order.price||order.stopPx)+','+order.orderQty+','+stopLoss+','+takeProfit+','+stopMarket+'\n'
}

async function getTradeCsv() { try {
  var yesterday = new Date().getTime() - (candleLengthMS)
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
} catch(e) {logger.error(e.stack||e);debugger} }

async function getFundingCsv() { try {
  var csv = 'Date,Rate\n'
  var fundings = await bitmex.getFundingHistory()
  fundings.push(bitmex.getNextFunding())
  fundings.forEach(funding => {
    csv += funding.timestamp+','+funding.fundingRate+'\n'
  })
  return csv
} catch(e) {logger.error(e.stack||e);debugger} }

function createInterval(candleDelay) {
  var now = new Date().getTime()
  var interval = setup.candle.interval*60000
  var startsIn = ((interval*2)-now%(interval) + candleDelay) % interval
  var startsInSec = startsIn % 60000
  var startsInMin = (startsIn - startsInSec) / 60000
  logger.info('createInterval ' + candleDelay + ' starts in ' + startsInMin + ':' + Math.floor(startsInSec/1000) + ' minutes')

  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startsIn)
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
  // createInterval(-5000*2**6)
  // createInterval(-5000*2**5)
  // createInterval(-5000*2**4)
  // createInterval(-5000*2**3)
  createInterval(-5000*2**2)
  createInterval(-5000*2**1)
  createInterval(-5000*2**0)
  createInterval(200)
  createInterval(5000*2**0)
  createInterval(5000*2**1)
  createInterval(5000*2**2)
  // createInterval(5000*2**3)
  // createInterval(5000*2**4)
  // createInterval(5000*2**5)
  // createInterval(5000*2**6)
} catch(e) {logger.error(e.stack||e);debugger} }

start()