const path = require('path')

const base = require('./base_strategy.js')
const bitmex = require('../bitmex')
const shoes = require('../shoes')
const winston = require('winston')
const storage = require('../storage')
const candlestick = require('../candlestick')

const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000

const {getTimeNow, isoTimestamp, colorizer} = global
var exitCandleTime

function typeColor(type) {
  return (type == 'LONG' ? '\x1b[36m' : type == 'SHORT' ? '\x1b[35m' : '') + type + '\x1b[39m'
}

const logger = winston.createLogger({
  format: winston.format.label({label:'acc'}),
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
            case 'enterSignal': {
              let signal = splat[0]
              if (signal) {
                let {condition,type='',entryPrice=NaN,orderQtyUSD,lossDistance=NaN,riskAmountUSD=NaN} = signal
                line += typeColor(condition)+' '+typeColor(type)+' '+entryPrice.toFixed(1)+' '+orderQtyUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)
              }
            } break
            case 'ENTER SIGNAL': 
            case 'ENTER ORDER': {
              let {orderQtyUSD,entryPrice} = splat[0].signal
              line =  (orderQtyUSD>0?'\x1b[36m':'\x1b[35m')+line+'\x1b[39m'+orderQtyUSD+' '+entryPrice
            } break
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

async function getAccumulationSignal(market,{rsi,willy}) { try {
  var last = market.closes.length-1
  var open = market.opens[last]
  var close = market.closes[last]
  var signal = {
    condition: '-',
    stopLoss: close
  }
  // var timeNow = getTimeNow()
  // var bullRun = timeNow < 1516579200000 /*Date.parse('22 Jan 2018 00:00:00 GMT')*/ ||
  //   (timeNow > 1554681600000 /*Date.parse('08 Apr 2019 00:00:00 GMT')*/ && timeNow < 1569801600000 /*Date.parse('30 Sep 2019 00:00:00 GMT')*/)
  // if (!bullRun) return signal
  
  var rsis = (market.rsis || await base.getRsi(market.closes,rsi.rsiLength))
  var [isWRsi,wrb1,wrt1,wrb2] = candlestick.findW(rsis,last,rsis,rsis[last-1],rsis[last])
  var [isMRsi,mrt1,mrb1,mrt2] = candlestick.findM(rsis,last,rsis,rsis[last-1],rsis[last])

  var [avgBodies,bodyHighs,bodyLows] = candlestick.getBody(market)
  var [isWPrice,wbottom1,wtop1,wbottom2] = candlestick.findW(avgBodies,last,bodyHighs,open,close)
  var [isMPrice,mtop1,mbottom1,mtop2] = candlestick.findM(avgBodies,last,bodyLows,open,close)

  if (isWPrice == 3) {
    signal.condition = 'LONG'
    signal.stopLoss = market.lows[wbottom2]
  }
  // if (isMPrice == 3 && isMRsi == 3) {
  //   signal.condition = 'SHORT'
  //   signal.stopLoss = close - (market.highs[mtop2] - close)*2
  // }

  // var timestamp = new Date(getTimeNow()).toISOString()
  // if (timestamp.includes('T11')) {
  //   signal.condition = 'LONG'
  //   signal.stopLoss = base.roundPrice(close*0.98) //candlestick.lowestBody(market,24)
  // }

  return signal
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrder(setup,signal) {
  var {walletBalance,entryPrice,lossDistance,coinPairRate} = signal
  var tick = setup.candle.tick
  var leverageMargin = walletBalance*0.000000008
  var profitDistance, takeProfit, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger,lossDistancePercent,
    riskAmountUSD, riskAmountBTC, orderQtyUSD, qtyBTC, leverage

  var {outsideCapitalBTC=0,outsideCapitalUSD=0,riskPerTradePercent,profitFactor,halfProfitFactor,
    stopMarketFactor,scaleInFactor,scaleInLength,minOrderSizeBTC,minStopLoss,maxStopLoss} = setup.bankroll
  var side = -lossDistance/Math.abs(lossDistance) // 1 or -1

  minOrderSizeBTC /= coinPairRate
  stopMarketDistance = base.roundPrice(lossDistance * stopMarketFactor)
  profitDistance = base.roundPrice(-lossDistance * profitFactor)
  halfProfitDistance = base.roundPrice(-lossDistance * halfProfitFactor)
  if (profitDistance == halfProfitDistance) {
    profitDistance += tick*side
  }

  stopMarket = base.roundPrice(entryPrice + stopMarketDistance)
  takeProfit = base.roundPrice(entryPrice + profitDistance)
  takeHalfProfit = base.roundPrice(entryPrice + halfProfitDistance)

  stopLossTrigger = entryPrice + (lossDistance/2)
  takeProfitTrigger = entryPrice + (profitDistance/8)
  stopMarketTrigger = entryPrice + (stopMarketDistance/4)
  lossDistancePercent = lossDistance/entryPrice

  var capitalBTC = (outsideCapitalUSD/entryPrice) + outsideCapitalBTC + walletBalance/100000000
  var capitalUSD = capitalBTC * entryPrice
  riskAmountBTC = capitalBTC * riskPerTradePercent
  riskAmountUSD = riskAmountBTC * entryPrice
  qtyBTC = riskAmountBTC / -lossDistancePercent
  var absQtyBTC = Math.abs(qtyBTC)
  if (absQtyBTC < minOrderSizeBTC) {
    qtyBTC = minOrderSizeBTC*side
  }
  orderQtyUSD = Math.round(qtyBTC * entryPrice)
  var absOrderQtyUSD = Math.abs(orderQtyUSD)
  var minOrderSizeUSD = Math.ceil(minOrderSizeBTC * entryPrice)
  if (absOrderQtyUSD < minOrderSizeUSD*2) {
    orderQtyUSD = minOrderSizeUSD*2*side
    absOrderQtyUSD = Math.abs(orderQtyUSD)
    qtyBTC = orderQtyUSD / entryPrice
  }
  leverage = Math.max(Math.ceil(Math.abs(qtyBTC / leverageMargin)*100)/100,1)

  var absLossDistancePercent = Math.abs(lossDistancePercent)
  var goodStopDistance = absLossDistancePercent >= minStopLoss && absLossDistancePercent <= maxStopLoss

  var scaleInSize = Math.round(orderQtyUSD / scaleInLength)
  var absScaleInsize = Math.abs(scaleInSize)
  if (absScaleInsize < minOrderSizeUSD) {
    scaleInLength = Math.round(absOrderQtyUSD / minOrderSizeUSD)
    scaleInSize = minOrderSizeUSD * side
    orderQtyUSD = scaleInSize * scaleInLength
    qtyBTC = orderQtyUSD / entryPrice
  }

  var scaleInDistance = lossDistance * scaleInFactor
  var minScaleInDistance = tick * (scaleInLength - 1)
  if (scaleInDistance && Math.abs(scaleInDistance) < minScaleInDistance) {
    scaleInDistance = scaleInDistance > 0 ? minScaleInDistance : -minScaleInDistance
  }
  var scaleInStep = scaleInDistance / (scaleInLength - 1)
  if (Math.abs(scaleInStep) == Infinity) {
    scaleInStep = 0
  }
  
  var scaleInOrders = []
  for (var i = 0; i < scaleInLength; i++) {
    scaleInOrders.push({
      size:scaleInSize,
      price:base.roundPrice(entryPrice+scaleInStep*i)
    })
  }
  
  // if (shoes.test ) {
  //   if (scaleInOrders.length <= 1) goodStopDistance = false
  // }

  return Object.assign({
    capitalBTC: capitalBTC,
    capitalUSD: capitalUSD,
    type: (goodStopDistance ? signal.condition : '-'),
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    halfProfitDistance: halfProfitDistance,
    takeProfit: takeProfit,
    takeHalfProfit: takeHalfProfit,
    stopMarket: stopMarket,
    stopLossTrigger: stopLossTrigger,
    takeProfitTrigger: takeProfitTrigger,
    stopMarketTrigger: stopMarketTrigger,
    riskAmountBTC: riskAmountBTC,
    riskAmountUSD: riskAmountUSD,
    qtyBTC: qtyBTC,
    orderQtyUSD: orderQtyUSD,
    leverage: leverage,
    scaleInOrders: scaleInOrders
  },signal)
}

async function getSignal(market,setup,walletBalance) { try {
  var timestamp = new Date(getTimeNow()).toISOString()
  var signal = await getAccumulationSignal(market,setup)
  signal.timestamp = timestamp
  
  // Test
  // if (shoes.test ) {
  //   if (signalCondition == 'S' || signalCondition == '-') signalCondition = 'SHORT'
  //   else if (signalCondition == 'L') signalCondition = 'LONG'
  // }

  if (signal.condition == '-') {
    return signal
  }

  var quote = bitmex.getQuote()
  var XBTUSDRate = bitmex.getRate('XBTUSD')
  signal.coinPairRate = quote.lastPrice/XBTUSDRate
  signal.walletBalance = walletBalance / signal.coinPairRate
  signal.entryPrice = market.closes[market.closes.length - 1]
  signal.lossDistance = base.roundPrice(signal.stopLoss - signal.entryPrice)
  if (!signal.lossDistance || !signal.walletBalance) {
    return signal
  }

  var orderSignal = await getOrder(setup,signal)
  return orderSignal
} catch(e) {console.error(e.stack||e);debugger} }

function cancelOrder(params) {
  var {positionSize,signal} = params
  
  if (positionSize != 0) return

  let cancelParams = Object.assign({},params)
  cancelParams.positionSize = signal.orderQtyUSD
  return (base.exitTooLong(cancelParams) 
  //|| base.exitFunding(cancelParams) 
  || base.exitTarget(cancelParams) || base.exitStop(cancelParams))
}

async function enterSignal({positionSize,fundingTimestamp,fundingRate,walletBalance}) { try {
  var enter, signal
  // var candleTimeOffset = bitmex.getCandleTimeOffset()

  // if (candleTimeOffset >= 5000 && candleTimeOffset <= 15000) {
    var market = await bitmex.getCurrentMarket()
    signal = await getSignal(market,setup,walletBalance)
    if (!shoes.mock) logger.debug('enterSignal',signal)
  // }

  if (signal && (signal.type == 'SHORT' || signal.type == 'LONG') && 
      signal.entryPrice && signal.orderQtyUSD) {
    if (base.isFundingWindow(fundingTimestamp) &&
      ((signal.orderQtyUSD > 0 && fundingRate > 0) || 
      (signal.orderQtyUSD < 0 && fundingRate < 0))) {
        logger.info('Funding ' + signal.type + ' will have to pay. Do not enter.')
    }
    else {
      enter = {signal:signal}
      if (!shoes.mock) logger.info('enterSignal',enter)
    }
  }
  return enter
} catch(e) {logger.error(e.stack||e);debugger} }

async function orderEntry(entrySignal) { try {
  let {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal.signal)
  let existingEntryOrders = bitmex.findOrders(/New|Fill/,entryOrders).filter(o => {
    return (new Date(o.timestamp).getTime() >= entrySignal.time)
  })
  if (existingEntryOrders.length > 0) {
    // logger.info('SAME ENTRY ORDER EXISTS')
  }
  else {
    if (!shoes.mock) logger.info('ENTER ORDER',entrySignal)
    closeOrders = closeOrders.slice(0,1)
    let response = await bitmex.order(entryOrders.concat(closeOrders),true)
    if (response.status == 200) {
      base.writeEntrySignal(entrySignal)
      entrySignal.entryOrders = entryOrders
      entrySignal.closeOrders = closeOrders
      // entrySignal.takeProfitOrders = takeProfitOrders
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkEntry(params) { try {
  let entrySignal = (await enterSignal(params))
  if (entrySignal) {
    await orderEntry(entrySignal)
    base.setEntrySignal(entrySignal)
    storage.writeEntrySignalTable(entrySignal)
  }

  return
/*
  var {positionSize,signal} = params
  var newEntryOrders = bitmex.findOrders(/New/,signal.entryOrders)

  if (newEntryOrders.length > 0) {
    let cancel = cancelOrder(params)
    if (cancel) {
      if (!shoes.mock) logger.info('CANCEL ORDER',cancel)
      await bitmex.cancelOrders(newEntryOrders)
      newEntryOrders = []
      resetEntrySignal()
    }
  }

  var entrySignal = getEntrySignal()
  if (entrySignal.timestamp) {
    let now = getTimeNow()
    if (now > (entrySignal.time + oneCandleMS)) {
      let {open,close} = await bitmex.getLastCandle()
      if ((entrySignal.type == 'LONG' && close > entrySignal.entryPrice && close > open) ||
        (entrySignal.type == 'SHORT' && close < entrySignal.entryPrice && close < open)) {
          await orderEntry(entrySignal)
      }
      else {
        let cancel = cancelOrder(params)
        if (cancel) {
          if (!shoes.mock) logger.info('CANCEL SIGNAL',cancel)
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
        base.setEntrySignal(entrySignal)
        entrySignalTable.info('entry',entrySignal)
        entrySignal.time = new Date(entrySignal.timestamp).getTime()
        if (!shoes.mock) logger.info('ENTER SIGNAL',entrySignal)
        // await orderEntry()
      }
    }
  }
  */
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(params) { try {
  var {positionSize,bid,ask,lastPrice,signal} = params
  if (positionSize == 0 || !lastPrice) return

  var {signal:{entryPrice},entryOrders,takeProfitOrders,closeOrders} = signal

  var exit = base.exitTooLong(params) || base.exitFunding(params)
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

    if (!shoes.mock) logger.info('CLOSE ORDER', exit)
    var response = await bitmex.order(exitOrders,true)
    return response
  }
  // else if ((positionSize > 0 && lastPrice > entryPrice) || (positionSize < 0 && lastPrice < entryPrice)) {
  //   let [takeProfitOrder,takeHalfProfitOrder] = takeProfitOrders
  
  //   let orders = []
  //   let exitOrderQty = -bitmex.getCumQty(entryOrders,signal.timestamp)
  //   let halfExitOrderQty = exitOrderQty/2
  
  //   // total takeProfit orderQty
  //   takeProfitOrder.orderQty = Math.round(halfExitOrderQty)
  //   takeHalfProfitOrder.orderQty = exitOrderQty - takeProfitOrder.orderQty
  
  //   // find orders based on the total qty
  //   let takeProfitCumQty = bitmex.getCumQty([takeProfitOrder],signal.timestamp)
  //   let takeHalfProfitCumQty = bitmex.getCumQty([takeHalfProfitOrder],signal.timestamp)
  
  //   // subtract filled qty
  //   takeProfitOrder.orderQty -= takeProfitCumQty
  //   takeHalfProfitOrder.orderQty -= takeHalfProfitCumQty
  
  //   // submit orders if there is any remaining qty
  //   if (takeProfitOrder.orderQty != 0) orders.push(takeProfitOrder)
  //   if (takeHalfProfitOrder.orderQty != 0) orders.push(takeHalfProfitOrder)

  //   let existingTakeProfitOrders = bitmex.findOrders(/New/,orders)
  //   if (existingTakeProfitOrders.length != orders.length) {
  //     let tooSmall = bitmex.ordersTooSmall(orders) 
  //     if (tooSmall.length > 0) {
  //       if (orders.length > 1) {
  //         orders[0].orderQty += orders[1].orderQty
  //         orders.pop()
  //         existingTakeProfitOrders = bitmex.findOrders(/New/,orders)
  //         if (existingTakeProfitOrders.length == 1) {
  //           return
  //         }
  //       }
  //       else {
  //         logger.info('order tooSmall', orders)
  //         return
  //       }
  //     }
  //     return await bitmex.order(orders)
  //   }
  // }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPosition(params) {
  await checkEntry(params)
  if (params.positionSize != 0) {
    params.signal = base.getEntrySignal()
    await checkExit(params)
  }
}

function resetEntrySignal() {
  var now = getTimeNow()
  exitCandleTime = now - (now % oneCandleMS)
  base.resetEntrySignal()
}

function getEntrySignal() {
  return base.getEntrySignal()
}

function getEntryExitOrders(entrySignal) {
  return base.getEntryExitOrders(entrySignal)
}

async function init() {
  var now = getTimeNow()
  exitCandleTime = now - (now % oneCandleMS)
  base.init()
}

function getCacheTradePath(dirname,{symbol,startTime,endTime,candle:{interval},rsi:{rsiLength},willy:{willyLength}}) {
  return path.resolve(dirname, 'data/bitmex/signal/'+symbol+'/'+interval+'-'+startTime+'-'+endTime+
    rsiLength+willyLength+'.json').replace(/:/g,';')
}

module.exports = {
  init: init,
  // getSignals: getSignals,
  checkPosition: checkPosition,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  getEntryExitOrders: getEntryExitOrders,
  getCacheTradePath: getCacheTradePath
}

