const log = require('./log')
const winston = require('winston')
// const l = require('./logger')
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
          let {timestamp,level,label,message} = info
          let log = timestamp.replace(/[T,Z]/g,' ')+'['+colorizer.colorize(level,label)+'] '+message+' '
          switch(info.message) {
            case 'checkPosition': {
              let {caller,walletBalance,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal
              let positionSizeString, lastPriceString
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
              let now = new Date().getTime()
              let candlesInTrade = ((now - new Date(timestamp||null).getTime()) / 900000).toFixed(1)
              let candlesTillFunding = ((new Date(fundingTimestamp||null).getTime() - now)/900000).toFixed(1)
              let payFunding = fundingRate*positionSize/lastPrice/walletBalance
              payFunding = (payFunding > 0 ? '\x1b[31m' : payFunding < 0 ? '\x1b[32m' : '') + payFunding.toFixed(5) + '\x1b[39m'
              log += caller + ' W:'+walletBalance.toFixed(4)+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' T:'+takeProfit.toFixed(1)+
                ' D:'+lossDistancePercent.toFixed(4)+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
            } break
            case 'enterSignal': {
              let {rsiSignal,conservativeRsiSignal,orderSignal} = splat[0]
              if (rsiSignal) {
                let {condition,prsi=NaN,rsi=NaN} = rsiSignal
                log += conditionColor(condition)+' '+prsi.toFixed(1)+' '+rsi.toFixed(1)
              }
              if (conservativeRsiSignal) {
                let {condition,prsi=NaN,rsi=NaN} = conservativeRsiSignal
                log += ' '+conditionColor(condition)+' '+prsi.toFixed(1)+' '+rsi.toFixed(1)
              }
              if (orderSignal) {
                let {type,entryPrice=NaN,positionSizeUSD,lossDistance=NaN} = orderSignal
                log += ' '+conditionColor(type)+' '+entryPrice.toFixed(1)+' '+positionSizeUSD+' '+lossDistance.toFixed(1)
              }
            } break
            case 'ENTER': {
              let {positionSizeUSD,entryPrice} = splat[0].signal
              log += positionSizeUSD+' '+entryPrice
            } break
            default: {
              log += (splat ? `${JSON.stringify(splat)}` : '')
            }
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

async function getOrderSignalWithCurrentCandle(availableMargin) {
  var market = await bitmex.getMarketWithCurrentCandle(15,96)
  var closes = market.closes
  var lastPrice = closes[closes.length-1]
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

function exitTargetTrigger({positionSize,bid,ask,signal}) {
  var {takeProfitTrigger,takeProfit} = signal
  var exit
  if (positionSize > 0) {
    if (ask >= takeProfitTrigger) {
      logger.info('exitTargetTrigger',positionSize,bid,ask,signal)
      exit = {price:Math.max(takeProfit,ask),reason:'targettrigger'}
    }
  } 
  else if (positionSize < 0) {
    if (bid <= takeProfitTrigger) {
      logger.info('exitTargetTrigger',positionSize,bid,ask,signal)
      exit = {price:Math.min(takeProfit,bid),reason:'targettrigger'}
    }
  }
  return exit
}

function exitTarget({bid,ask,signal}) {
  var {positionSizeUSD,takeProfit} = signal
  var exit
  if (positionSizeUSD > 0) {
    if (ask >= takeProfit) exit = {price:Math.max(takeProfit,ask),reason:'target'}
  } 
  else if (positionSizeUSD < 0) {
    if (bid <= takeProfit) exit = {price:Math.min(takeProfit,bid),reason:'target'}
  }
  return exit
}

function exitStop({bid,ask,signal}) {
  var {positionSizeUSD,stopMarketTrigger} = signal
  positionSize = 1
  var exit
  if (positionSizeUSD > 0) {
    if (ask <= stopMarketTrigger) exit = {price:Math.min(stopMarketTrigger,ask),reason:'stop'}
  } 
  else if (positionSizeUSD < 0) {
    if (bid >= stopMarketTrigger) exit = {price:Math.max(stopMarketTrigger,bid),reason:'stop'}
  }
  return exit
}

function cancelOrder(params) {
  var {positionSize,signal} = params
  
  if (positionSize != 0) return

  var cancel
  let newEntryOrder = bitmex.findNewLimitOrder(signal.entryPrice,signal.positionSizeUSD,'ParticipateDoNotInitiate')
  if (newEntryOrder) {
    let exit
    let cancelParams = Object.assign({},params)
    cancelParams.positionSize = signal.positionSizeUSD
    if (exit = (exitTooLong(cancelParams) || exitFunding(cancelParams) || exitTarget(cancelParams) || exitStop(cancelParams))) {
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
  if (candleTimeOffset >= 888000) {
    signals = await getOrderSignalWithCurrentCandle(availableMargin)
    orderSignal = signals.orderSignal
    logger.info('enterSignal',signals)
  }
  else if (candleTimeOffset <= 12000) {
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
} catch(e) {console.error(e.stack||e);debugger} }

async function checkPositionCallback(params) { try {
  params.signal = entrySignal
  return await checkPosition(params)
} catch(e) {console.error(e.stack||e);debugger} }

async function checkEntry(params) { try {
  var cancel, enter
  if (cancel = cancelOrder(params)) {
    logger.info('CANCEL',cancel)
    response = await bitmex.cancelAll()
  }
  if (enter = await enterSignal(params)) {
    if (bitmex.findNewLimitOrder(enter.signal.entryPrice,enter.signal.positionSizeUSD,'ParticipateDoNotInitiate')) {
      logger.info('ENTRY ORDER EXISTS')
    }
    else {
      logger.info('ENTER',enter)
      let orderSent = await bitmex.enter(enter.signal)
      if (orderSent) {
        entrySignal = enter.signal
        entrySignalTable.info('entry',entrySignal)
        log.writeEntrySignal(entrySignal) // current trade
        log.writeOrderSignal(setup.bankroll,entrySignal) // trade
      }
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function checkExit(params) { try {
  var exit
  if (exit = exitTooLong(params) || exitFunding(params) || exitTargetTrigger(params)) {
    if (exit.reason == 'targettrigger' && bitmex.findNewLimitOrder(exit.price,-params.positionSize,'ParticipateDoNotInitiate,ReduceOnly')) {
      logger.info('EXIT ORDER EXISTS')
    }
    else {
      logger.info('EXIT',exit)
      response = await bitmex.exit('',exit.price,-params.positionSize)
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function checkPosition(params) { try {
  logger.info('checkPosition',params)
  if (!(await checkExit(params))) {
    await checkEntry(params)
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function next() { try {
  bitmex.checkPositionParams.caller = 'interval'
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
  createInterval(-5*60000)
  createInterval(-2*60000)
  createInterval(-60000)
  createInterval(-30000)
  createInterval(-20000)
  createInterval(-15000)
  createInterval(-10000)
  createInterval(-5000)
  createInterval(200)
  createInterval(5000)
  createInterval(10000)
  createInterval(15000)
  createInterval(20000)
  createInterval(30000)
  createInterval(60000)
  createInterval(2*60000)
  createInterval(5*60000)
} catch(e) {console.error(e.stack||e);debugger} }

start()