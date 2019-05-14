const fs = require('fs')
const fsR = require('fs-reverse')
const { Writable } = require('stream');
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const winston = require('winston')
const path = require('path')

const shoes = require('./shoes')
global.logDir = path.resolve(__dirname, 'log/'+shoes.symbol)

var mock
if (shoes.mock) mock = require('./mock.js')

const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')
const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000

global.bitmex = bitmex

const entrySignalFilePath = global.logDir + '/entry_signal.json'
const entrySignalTableFilePath = global.logDir + '/entry_signal_table.log'

const colorizer = winston.format.colorize()

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date(getTimeNow()).toISOString()
  return info;
})

function getTimeNow() {
  return new Date().getTime()
}

var lastCheckPositionTime = getTimeNow()

function conditionColor(condition) {
  return (condition == 'LONG' ? '\x1b[36m' : condition == 'SHORT' ? '\x1b[35m' : '') + condition + '\x1b[39m'
}

const logger = winston.createLogger({
  format: winston.format.label({label:'index'}),
  transports: [
    new winston.transports.Console({
      level: shoes.log.level || 'info',
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
              lossDistancePercentString = Math.abs(lossDistancePercent) < 0.002 ? lossDistancePercent.toFixed(4) : ('\x1b[34;1m' + lossDistancePercent.toFixed(4) + '\x1b[39m')
              let now = getTimeNow()
              let candlesInTrade = ((now - new Date(timestamp||null).getTime()) / oneCandleMS)
              candlesInTrade = (candlesInTrade >= setup.candle.inTradeMax || (Math.abs(lossDistancePercent) >= 0.002 && candlesInTrade >=3)) ? ('\x1b[33m' + candlesInTrade.toFixed(1) + '\x1b[39m') : candlesInTrade.toFixed(1)
              let candlesTillFunding = ((new Date(fundingTimestamp||null).getTime() - now)/oneCandleMS)
              candlesTillFunding = (candlesTillFunding > 1 ? candlesTillFunding.toFixed(1) : ('\x1b[33m' + candlesTillFunding.toFixed(1) + '\x1b[39m'))
              let payFunding = fundingRate*positionSize/lastPrice
              payFunding = (payFunding > 0 ? '\x1b[31m' : payFunding < 0 ? '\x1b[32m' : '') + payFunding.toFixed(5) + '\x1b[39m'
              line += caller + ' B:'+walletBalance.toFixed(4)+' P:'+positionSizeString+' L:'+lastPriceString+
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
                let {type,entryPrice=NaN,orderQtyUSD,lossDistance=NaN,riskAmountUSD=NaN} = orderSignal
                line += ' '+conditionColor(type)+' '+entryPrice.toFixed(1)+' '+orderQtyUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)
              }
            } break
            case 'ENTER SIGNAL': 
            case 'ENTER ORDER': {
              let {orderQtyUSD,entryPrice} = splat[0]
              line =  (orderQtyUSD>0?'\x1b[36m':'\x1b[35m')+line+'\x1b[39m'+orderQtyUSD+' '+entryPrice
            } break
            // case 'EXIT ORDER': {
            //   let {side,price} = splat[0].exitOrders[0]
            //   line = (side>0?'\x1b[36m':'\x1b[35m')+line+'\x1b[39m'+size+' '+price
            // } break
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
    new winston.transports.File({filename:entrySignalTableFilePath,
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    })
  ]
})

var entrySignal, exitCandleTime

logger.info('shoes', shoes)

var fundingWindowTime = setup.candle.fundingWindow * oneCandleMS

function isFundingWindow(fundingTimestamp) {
  var fundingTime = new Date(fundingTimestamp).getTime()
  var checkFundingPositionTime = fundingTime - fundingWindowTime //1800000
  var now = getTimeNow()
  return (now > checkFundingPositionTime)
}

var cutOffTimeForAll = setup.candle.inTradeMax*60000
var cutOffTimeForLargeTrade = 59*60000

function isInPositionForTooLong(signal) {
  if (signal) {
    var time = getTimeNow()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    return (delta > cutOffTimeForAll)
     //|| (delta > cutOffTimeForLargeTrade && Math.abs(signal.lossDistancePercent) >= 0.002))
  }
}

async function getOrderSignalWithCurrentCandle(walletBalance) {
  var market = await bitmex.getCurrentMarketWithCurrentCandle()
  var closes = market.closes
  var lastPrice = closes[closes.length-1]
  var rsiSignal = await strategy.getSignal(closes,setup.rsi)
  var conservativeCloses, conservativeRsiSignal, orderSignal
  
  // logger.verbose('getOrderSignalWithCurrentCandle rsiSignal', rsiSignal)

  if (rsiSignal.condition == 'LONG') { 
    conservativeCloses = market.closes.slice(1)
    conservativeCloses.push(lastPrice-setup.bankroll.tick)
    conservativeRsiSignal = await strategy.getSignal(closes,setup.rsi)
  }
  else if (rsiSignal.condition == 'SHORT') {
    conservativeCloses = market.closes.slice(1)
    conservativeCloses.push(lastPrice+setup.bankroll.tick)
    conservativeRsiSignal = await strategy.getSignal(closes,setup.rsi)
  }

  // if (conservativeRsiSignal) {
  //   logger.verbose('getOrderSignalWithCurrentCandle conservativeRsiSignal', conservativeRsiSignal)
  // }
  // else {
  //   logger.verbose('getOrderSignalWithCurrentCandle conservativeRsiSignal null')
  // }

  if (conservativeRsiSignal && conservativeRsiSignal.condition == rsiSignal.condition) {
    orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,walletBalance)
    // logger.verbose('getOrderSignalWithCurrentCandle orderSignal', orderSignal)
  }
  return {rsiSignal:rsiSignal,conservativeRsiSignal:conservativeRsiSignal,orderSignal:orderSignal}
}

async function getOrderSignal(walletBalance) {
  var market = await bitmex.getCurrentMarket()
  var closes = market.closes
  // var lastPrice = closes[closes.length-1]
  var rsiSignal = await strategy.getSignal(closes,setup.rsi)
  
  // logger.verbose('getOrderSignal rsiSignal',rsiSignal)

  let orderSignal = await strategy.getOrderSignal(rsiSignal,market,setup.bankroll,walletBalance)
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
}

function exitFunding({positionSize,fundingTimestamp,fundingRate,signal}) {
  var fee = getFee(positionSize,fundingRate,signal.riskAmountUSD)
  if (fee.isLarge && isFundingWindow(fundingTimestamp)) {
    return {reason:'funding',pay:fee.pay,risk:signal.riskAmountUSD}
  }
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
  cancelParams.positionSize = signal.orderQtyUSD
  return (exitTooLong(cancelParams) || exitFunding(cancelParams) || exitTarget(cancelParams) || exitStop(cancelParams))
}

async function enterSignal({positionSize,fundingTimestamp,fundingRate,walletBalance}) { try {
  if (positionSize != 0) return

  var enter
  let candleTimeOffset = bitmex.getCandleTimeOffset()

  let signals, orderSignal
  // if (candleTimeOffset >= setup.candle.signalTimeOffsetMax) {
  //   signals = await getOrderSignalWithCurrentCandle(walletBalance)
  //   orderSignal = signals.orderSignal
  //   if (!mock) {
  //     logger.debug('enterSignal',signals)
  //   }
  // }
  // else 
  if (candleTimeOffset >= 5000 && candleTimeOffset <= 15000) {
    // let testTime = new Date('2019-05-08T04:41:00.000Z').getTime()
    // console.log(new Date(getTimeNow()).toISOString())
    // if (getTimeNow() > testTime) {
    //   debugger
    // }
    signals = await getOrderSignal(walletBalance)
    orderSignal = signals.orderSignal
    if (!mock) {
      logger.debug('enterSignal',signals)
    }
  }

  if (orderSignal && (orderSignal.type == 'SHORT' || orderSignal.type == 'LONG') && 
    orderSignal.entryPrice && orderSignal.orderQtyUSD) {
    if (isFundingWindow(fundingTimestamp) &&
      ((orderSignal.orderQtyUSD > 0 && fundingRate > 0) || 
      (orderSignal.orderQtyUSD < 0 && fundingRate < 0))) {
        logger.info('Funding ' + orderSignal.type + ' will have to pay. Do not enter.')
    }
    else {
      if (!mock) {
        logger.info('enterSignal',signals)
      }
      enter = {type:'Limit',price:orderSignal.entryPrice,size:orderSignal.positionSize,execInst:'ParticipateDoNotInitiate',signal:orderSignal}
    }
  }
  return enter
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPositionCallback(params) { try {
  params.signal = entrySignal
  return await checkPosition(params)
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkEntry(params) { try {
  var {positionSize,signal} = params
  var newEntryOrders = bitmex.findOrders(/New/,signal.entryOrders)

  if (newEntryOrders.length > 0) {
    let cancel = cancelOrder(params)
    if (cancel) {
      logger.info('CANCEL ORDER',cancel)
      await bitmex.cancelOrders(newEntryOrders)
      newEntryOrders = []
      resetEntrySignal()
    }
  }

  if (entrySignal.timestamp) {
    let now = getTimeNow()
    if (now > (entrySignal.time + 60000)) {
      let {open,close} = await bitmex.getLastCandle()
      // console.log(entrySignal.type, entrySignal.entryPrice, lastCandle.close)
      if ((entrySignal.type == 'LONG' && close > entrySignal.entryPrice && close > open) ||
        (entrySignal.type == 'SHORT' && close < entrySignal.entryPrice && close < open)) {
          let {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal)
          let existingEntryOrders = bitmex.findOrders(/New|Fill/,entryOrders)
          if (existingEntryOrders.length > 0) {
            // logger.info('ENTRY ORDER EXISTS')
          }
          else {
            logger.info('ENTER ORDER',entrySignal)
            let response = await bitmex.order(entryOrders.concat(closeOrders),true)
            if (response.status == 200) {
              fs.writeFileSync(entrySignalFilePath,JSON.stringify(entrySignal,null,2),writeFileOptions)
              entrySignal.entryOrders = entryOrders
              entrySignal.closeOrders = closeOrders
              entrySignal.takeProfitOrders = takeProfitOrders
            }
          }
      }
      else {
        let cancel = cancelOrder(params)
        if (cancel) {
          logger.info('CANCEL SIGNAL',cancel)
          resetEntrySignal()
        }
      }
    }
  }
  else {
    let now = getTimeNow()
    if (!exitCandleTime || now > (exitCandleTime + oneCandleMS)) {
      let enter = (await enterSignal(params))
      if (enter) {
        entrySignal = enter.signal
        entrySignalTable.info('entry',entrySignal)
        entrySignal.time = new Date(entrySignal.timestamp).getTime()
        logger.info('ENTER SIGNAL',entrySignal)
      }
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(params) { try {
  var {positionSize,bid,ask,lastPrice,signal} = params
  if (positionSize == 0 || !lastPrice) return

  var {entryPrice,entryOrders,takeProfitOrders,closeOrders} = signal

  var exit = exitTooLong(params) || exitFunding(params)
  if (exit) {
    let exitOrders = [{
      price: (positionSize < 0 ? bid : ask),
      side: (positionSize < 0 ? 'Buy' : 'Sell'),
      ordType: 'Limit',
      execInst: 'Close,ParticipateDoNotInitiate'
    }]
    exit.exitOrders = exitOrders

    var existingExitOrders = bitmex.findOrders(/New/,exitOrders)
    if (existingExitOrders.length == 1) {
      // logger.debug('EXIT EXISTING ORDER',exit)
      return existingExitOrders
    }

    logger.info('CLOSE ORDER', exit)
    var response = await bitmex.order(exitOrders,true)
    return response
  }
  else if ((positionSize > 0 && lastPrice > entryPrice) || (positionSize < 0 && lastPrice < entryPrice)) {
    let [takeProfitOrder,takeHalfProfitOrder] = takeProfitOrders
  
    let orders = []
    let exitOrderQty = -bitmex.getCumQty(entryOrders,signal.timestamp)
    let halfExitOrderQty = exitOrderQty/2
  
    // total takeProfit orderQty
    takeProfitOrder.orderQty = Math.round(halfExitOrderQty)
    takeHalfProfitOrder.orderQty = exitOrderQty - takeProfitOrder.orderQty
  
    // find orders based on the total qty
    let takeProfitCumQty = bitmex.getCumQty([takeProfitOrder],signal.timestamp)
    let takeHalfProfitCumQty = bitmex.getCumQty([takeHalfProfitOrder],signal.timestamp)
  
    // subtract filled qty
    takeProfitOrder.orderQty -= takeProfitCumQty
    takeHalfProfitOrder.orderQty -= takeHalfProfitCumQty
  
    // submit orders if there is any remaining qty
    if (takeProfitOrder.orderQty != 0) orders.push(takeProfitOrder)
    if (takeHalfProfitOrder.orderQty != 0) orders.push(takeHalfProfitOrder)

    let existingTakeProfitOrders = bitmex.findOrders(/New/,orders)
    if (existingTakeProfitOrders.length != orders.length) {
      let tooSmall = bitmex.ordersTooSmall(orders) 
      if (tooSmall.length > 0) {
        if (orders.length > 1) {
          orders[0].orderQty += orders[1].orderQty
          orders.pop()
          existingTakeProfitOrders = bitmex.findOrders(/New/,orders)
          if (existingTakeProfitOrders.length == 1) {
            return
          }
        }
        else {
          logger.info('order tooSmall', orders)
          return
        }
      }
      await bitmex.order(orders)
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

var checking = false, recheckWhenDone = false

async function checkPosition(params) { try {
  const {walletBalance,lastPositionSize,positionSize,caller,signal} = params
  // var date = new Date(getTimeNow())
  // var m = date.getMinutes()
  // if (m == 20) {
  //   console.log(params.lastPrice)
  // }
  // else if (m > 20) {
  //   debugger
  // }
  if (!mock) {
    logger.info('checkPosition',params)
  }
  switch(caller) {
    case 'position': {
      if (lastPositionSize == 0) {
        logger.info('ENTER POSITION', walletBalance)
      }
      else if (positionSize == 0) {
        logger.info('EXIT POSITION', walletBalance)
        resetEntrySignal()
      }
    } break;
    // case 'interval': {
    //   let now = getTimeNow()
    //   let date = new Date(now)
    //   let ms = date.getMilliseconds()
    //   if (ms != 0) debugger
    //   if (now - lastIntervalTime != 60000) {
    //     console.log('last', new Date(lastIntervalTime).toISOString())
    //     console.log('now', new Date(now).toISOString())
    //     debugger
    //   }
    //   lastIntervalTime = now
    // } break;
  }
  if (checking) {
    recheckWhenDone = true
    return
  }
  checking = true
  lastCheckPositionTime = getTimeNow()

  if (params.positionSize == 0) {
    await checkEntry(params)
  }
  else {
    await checkExit(params)
  }

  if (recheckWhenDone) {
    setTimeout(next,50)
    recheckWhenDone = false
  }
  checking = false
} catch(e) {logger.error(e.stack||e);debugger} }

async function next() { try {
  var now = getTimeNow()
  if (now-lastCheckPositionTime > 2500) {
    bitmex.getCurrentMarket() // to start a new candle if necessary
    bitmex.checkPositionParams.caller = 'interval'
    bitmex.checkPositionParams.signal = entrySignal
    checkPosition(bitmex.checkPositionParams)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarketJson(sp) { try {
  var market = await bitmex.getMarket(sp)
  return JSON.stringify(market)
} catch(e) {logger.error(e.stack||e);debugger} }

async function getTradeSignals({startTime,endTime}) { try {
  return new Promise((resolve,reject) => {
    var startTimeMs = new Date(startTime).getTime()
    var endTimeMs = new Date(endTime).getTime()
    var signals = []
    var stream = fsR(entrySignalTableFilePath, {})
    const outStream = new Writable({
      write(chunk, encoding, callback) {
        let str = chunk.toString()
        if (str && str.length > 0) {
          let signal = JSON.parse(str)
          let signalTime = new Date(signal.timestamp).getTime()
          if (signalTime >= startTimeMs && signalTime <= endTimeMs) {
            var {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(signal)
            signal.entryOrders = entryOrders
            signal.closeOrders = closeOrders
            signal.takeProfitOrders = takeProfitOrders
            signals.unshift(signal)
          }
          else {
            stream.destroy()
            resolve(signals)
          }
        }
        callback()
      }
    })
    stream.pipe(outStream)
    stream.on('finish', () => {
      resolve(signals)
    })
    stream.on('end', () => {
      resolve(signals)
    })
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function getTradeJson(sp) { try {
  var cachePath = getSignalPath(sp)

  if (mock) {
    // if (fs.existsSync(cachePath)) {
    //   return fs.readFileSync(cachePath)
    // }
    await mock.init(sp)
    resetEntrySignal()
    await bitmex.init(checkPositionCallback)
    await mock.start()
  }

  var [orders,signals] = await Promise.all([
    bitmex.getOrders(sp),
    getTradeSignals(sp)
  ])
  orders = orders.filter(o => {
    return o.stopPx != 1
  })
  var trades = []
  var timeOffset = 1000 // bitmex time and server time are not the same
  signals.forEach((signal,i) => {
    let {timestamp} = signal
    let startTime = new Date(timestamp).getTime() - timeOffset
    let endTime = (signals[i+1] ? new Date(signals[i+1].timestamp) : new Date()).getTime() - timeOffset
    signal.ords = orders.filter(({timestamp}) => {
      let t = new Date(timestamp).getTime()
      return (t >= startTime && t < endTime)
    })
  })
  signals.forEach(({ords,timestamp,capitalBTC,type,orderQtyUSD,entryPrice,stopLoss,stopMarket,takeProfit,takeHalfProfit,entryOrders,closeOrders,takeProfitOrders},i) => {
    let trade = {
      timestamp, capitalBTC, type, orderQtyUSD, entryPrice, stopLoss, stopMarket, takeProfit, takeHalfProfit,
      entryOrders: bitmex.findOrders(/.+/,entryOrders,ords),
      closeOrders: bitmex.findOrders(/.+/,closeOrders,ords),
      takeProfitOrders: bitmex.findOrders(/.+/,takeProfitOrders,ords),
    }
    let foundOrders = trade.entryOrders.concat(trade.closeOrders).concat(trade.takeProfitOrders)
    trade.otherOrders = ords.filter((e) => {
      return foundOrders.indexOf(e) < 0
    })
    trades.push(trade)
  })
  
  let walletHistory = await bitmex.getWalletHistory()
  let tradeJSON = JSON.stringify({trades:trades,orders:orders,walletHistory:walletHistory})
  fs.writeFileSync(cachePath,tradeJSON,writeFileOptions)

  return tradeJSON
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
  var now = getTimeNow()
  var interval = oneCandleMS
  var startsIn = ((interval*2)-now%(interval) + candleDelay) % interval
  var startsInSec = startsIn % 60000
  var startsInMin = (startsIn - startsInSec) / 60000
  console.log('createInterval ' + candleDelay + ' starts in ' + startsInMin + ':' + Math.floor(startsInSec/1000) + ' minutes')
  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startsIn)
}

function getEntryExitOrders({orderQtyUSD,entryPrice,stopLoss,stopMarket,takeProfit,takeHalfProfit,scaleInOrders}) {
  var entrySide, exitSide
  if (orderQtyUSD > 0) {
    entrySide = 'Buy'
    exitSide = 'Sell'
  }
  else {
    entrySide = 'Sell'
    exitSide = 'Buy'
  }

  var entryOrders
  if (scaleInOrders && scaleInOrders.length > 0) {
    entryOrders = scaleInOrders.map(o => {
      return {
        price: o.price,
        side: entrySide,
        orderQty: o.size,
        ordType: 'Limit',
        execInst: 'ParticipateDoNotInitiate'
      }
    })
  }
  else {
    entryOrders = [{
      price: entryPrice,
      side: entrySide,
      orderQty: orderQtyUSD,
      ordType: 'Limit',
      execInst: 'ParticipateDoNotInitiate'
    }]
  }

  var exitPriceOffset = (-orderQtyUSD/Math.abs(orderQtyUSD)*setup.bankroll.tick)
  var closeOrders = [{
    stopPx: stopMarket,
    side: exitSide,
    ordType: 'Stop',
    execInst: 'Close,LastPrice'
  },
  // {
  //   price: stopLoss,
  //   stopPx: stopLoss + exitPriceOffset,
  //   side: exitSide,
  //   ordType: 'StopLimit',
  //   execInst: 'Close,LastPrice,ParticipateDoNotInitiate'
  // },
  {
    price: takeProfit - exitPriceOffset * 2,
    stopPx: takeProfit - exitPriceOffset,
    side: exitSide,
    ordType: 'LimitIfTouched',
    execInst: 'Close,LastPrice,ParticipateDoNotInitiate'
  }]

  var takeProfitOrders = [{
    price: takeProfit,
    orderQty: orderQtyUSD/2,
    side: exitSide,
    ordType: 'Limit',
    execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  },{
    price: takeHalfProfit,
    orderQty: orderQtyUSD/2,
    side: exitSide,
    ordType: 'Limit',
    execInst: 'ParticipateDoNotInitiate,ReduceOnly'
  }]

  return {entryOrders:entryOrders,closeOrders:closeOrders,takeProfitOrders:takeProfitOrders}
}

function getSignalPath({symbol,interval,startTime,endTime}) {
  return path.resolve(__dirname, 'data/bitmex/signal/'+symbol+'-'+interval+'-'+startTime+'-'+endTime+'.json').replace(/:/g,';')
}

function resetEntrySignal() {
  var now = getTimeNow()
  exitCandleTime = now - (now % oneCandleMS)
  entrySignal = {}
  if (fs.existsSync(entrySignalFilePath)) {
    fs.unlinkSync(entrySignalFilePath)
  }
}

function initEntrySignal() {
  var now = getTimeNow() 
  exitCandleTime = now - (now % oneCandleMS)
  entrySignal = {}

  if (!fs.existsSync(entrySignalFilePath)) {
    return
  }

  var entrySignalString = fs.readFileSync(entrySignalFilePath,readFileOptions)
  entrySignal = JSON.parse(entrySignalString)
  entrySignal.time = new Date(entrySignal.timestamp).getTime()

  var {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal)
  entrySignal.entryOrders = entryOrders
  entrySignal.closeOrders = closeOrders
  entrySignal.takeProfitOrders = takeProfitOrders
}

async function init() { try {
  if (mock) {
    await mock.init(shoes.mock)
    getTimeNow = mock.getTimeNow
    next = mock.next
    createInterval = mock.createInterval
  }

  initEntrySignal()

  await strategy.init()
  await bitmex.init(checkPositionCallback)
  await server.init(getMarketJson,getTradeJson,getFundingCsv)

  if (mock) {
    // var s = {
    //   symbol: 'ETHUSD',
    //   interval: 1,
    //   startTime: '2019-05-09T00:00:00.000Z',
    //   endTime: '2019-05-10T00:00:00.000Z'
    // }
    // var tradeJSON = await getTradeJson(s)
    // debugger
  }
  else {
    next()
    createInterval(6000*2**0)
    createInterval(6000*2**1)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

init()

// var lineReader = require('readline').createInterface({
//   input: require('fs').createReadStream('combined.log')
// })

// lineReader.on('line', (line) => {
//   var json = JSON.parse(line)
//   var {timestamp,url,rsiSignal} = json
//   if (rsiSignal && timestamp.indexOf('09T11:16:') > 0) {
//     console.log(json)
//     console.log(json.message)
//     debugger
//   }
// })
