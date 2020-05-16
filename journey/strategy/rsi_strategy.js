const base = require('./base_strategy.js')
const bitmex = require('../bitmex')
const shoes = require('../shoes')
const winston = require('winston')
const candlestick = require('../candlestick')
const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000

var mock
if (shoes.setup.startTime) mock = require('./mock.js')

var exitCandleTime

const colorizer = winston.format.colorize()

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date(getTimeNow()).toISOString()
  return info;
})

function getTimeNow() {
  return new Date().getTime()
}

function conditionColor(condition) {
  return (condition == 'LONG' ? '\x1b[36m' : condition == 'SHORT' ? '\x1b[35m' : '') + condition + '\x1b[39m'
}

const logger = winston.createLogger({
  format: winston.format.label({label:'rsi'}),
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
              let {signal,orderSignal} = splat[0]
              if (signal) {
                if (signal.rsis) {
                  let {condition,prsi=NaN,rsi=NaN} = signal
                  line += conditionColor(condition)+' '+prsi.toFixed(1)+' '+rsi.toFixed(1)
                }
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

async function getRsiSignal(market,{shortPrsi,shortRsi,longPrsi,longRsi,rsiLength}) { try {
  var rsis = (market.rsis || await base.getRsi(market.closes,rsiLength))
  var len = rsis.length
  var rsi = rsis[len - 1]
  var prsi = rsis[len - 2]
  var condition = '-'
  if (prsi > shortPrsi && rsi <= shortRsi ) {
    condition = 'SHORT'
  }
  else if (prsi < longPrsi && rsi >= longRsi ) {
    condition = 'LONG'
  }
  else if (prsi > shortPrsi) {
    condition = 'S'
  }
  else if (prsi < longPrsi) {
    condition = 'L'
  }
  return {
    condition: condition,
    prsi: Math.round(prsi*100)/100,
    rsi: Math.round(rsi*100)/100,
    rsis: rsis,
    shortPrsi: shortPrsi,
    shortRsi: shortRsi,
    longPrsi: longPrsi,
    longRsi: longRsi,
    rsiLength: rsiLength,
    closes: market.closes
  }
} catch(e) {console.error(e.stack||e);debugger} }

function getRsiStopLoss(signalCondition,market,stopLossLookBack) {
  switch(signalCondition) {
    case 'SHORT':
      return base.roundPrice(candlestick.highestBody(market,stopLossLookBack))
      // entryPrice = Math.max(quote.askPrice||0,close) // use askPrice or close to be a maker
      // entryPrice = Math.min(entryPrice,stopLoss) // askPrice might already went up higher than stopLoss
      break;
    case 'LONG':
      return base.roundPrice(candlestick.lowestBody(market,stopLossLookBack))
      // entryPrice = Math.min(quote.bidPrice||Infinity,close) // use bidPrice or close to be a maker
      // entryPrice = Math.max(entryPrice,stopLoss) // bidPrice might already went down lower than stopLoss
      break;
  }
}

async function getOrder(setup,signalCondition,walletBalance,entryPrice,lossDistance,coinPairRate) {
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
  
  if (shoes.test ) {
    goodStopDistance = true
  }

  return {
    capitalBTC: capitalBTC,
    capitalUSD: capitalUSD,
    type: (goodStopDistance ? signalCondition : '-'),
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
  }
}

async function getSignals(market,setup,walletBalance) { try {
  var timestamp = new Date(getTimeNow()).toISOString()
  var signal, stopLoss, entryPrice, lossDistance

  signal = await getRsiSignal(market,setup.rsi)

  // Test
  if (shoes.test ) {
    if (signal.condition == 'S' || signal.condition == '-') signal.condition = 'SHORT'
    else if (signal.condition == 'L') signal.condition = 'LONG'
  }
  
  if (signal.condition == '-') {
    return {
      signal: signal,
      orderSignal: {
        timestamp: timestamp,
        type: '-'
      }
    }
  }

  stopLoss = getRsiStopLoss(signal.condition, market, setup.rsi.stopLossLookBack)

  var quote = bitmex.getQuote()
  var XBTUSDRate = bitmex.getRate('XBTUSD')
  var coinPairRate = quote.lastPrice/XBTUSDRate
  walletBalance /= coinPairRate
  
  var lastIndex = market.closes.length - 1
  var close = market.closes[lastIndex]

  entryPrice = close
  lossDistance = base.roundPrice(stopLoss - entryPrice)
  if (!lossDistance || !walletBalance) {
    return {
      signal: signal,
      orderSignal: {
        timestamp: timestamp,
        type: '-'
      }
    }
  }

  var orderSignal = await getOrder(setup,signal.condition,walletBalance,entryPrice,lossDistance,coinPairRate)
  orderSignal.stopLoss = stopLoss
  orderSignal.timestamp = timestamp

  return {
    signal: signal,
    orderSignal: orderSignal
  }
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
  if (positionSize != 0) return

  var enter
  let candleTimeOffset = bitmex.getCandleTimeOffset()

  let signals, orderSignal

  if (candleTimeOffset >= 5000 && candleTimeOffset <= 15000) {
    var market = await bitmex.getCurrentMarket()
    signals = await getSignals(market,setup,walletBalance)
    orderSignal = signals.orderSignal

    if (!mock) logger.debug('enterSignal',signals)
  }

  if (orderSignal && (orderSignal.type == 'SHORT' || orderSignal.type == 'LONG') && 
    orderSignal.entryPrice && orderSignal.orderQtyUSD) {
    if (base.isFundingWindow(fundingTimestamp) &&
      ((orderSignal.orderQtyUSD > 0 && fundingRate > 0) || 
      (orderSignal.orderQtyUSD < 0 && fundingRate < 0))) {
        logger.info('Funding ' + orderSignal.type + ' will have to pay. Do not enter.')
    }
    else {
      if (!mock) logger.info('enterSignal',signals)
      enter = {type:'Limit',price:orderSignal.entryPrice,size:orderSignal.positionSize,execInst:'ParticipateDoNotInitiate',signal:orderSignal}
    }
  }
  return enter
} catch(e) {logger.error(e.stack||e);debugger} }

async function orderEntry(entrySignal) { try {
  let {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal)
  let existingEntryOrders = bitmex.findOrders(/New|Fill/,entryOrders).filter(o => {
    return (new Date(o.timestamp).getTime() >= entrySignal.time)
  })
  if (existingEntryOrders.length > 0) {
    logger.info('ENTRY ORDER EXISTS')
  }
  else {
    if (!mock) logger.info('ENTER ORDER',entrySignal)
    let response = await bitmex.order(entryOrders.concat(closeOrders),true)
    if (response.status == 200) {
      base.writeEntrySignal(entrySignal)
      entrySignal.entryOrders = entryOrders
      entrySignal.closeOrders = closeOrders
      entrySignal.takeProfitOrders = takeProfitOrders
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkEntry(params) { try {
  var {positionSize,signal} = params
  var newEntryOrders = bitmex.findOrders(/New/,signal.entryOrders)

  if (newEntryOrders.length > 0) {
    let cancel = cancelOrder(params)
    if (cancel) {
      if (!mock) logger.info('CANCEL ORDER',cancel)
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
          if (!mock) logger.info('CANCEL SIGNAL',cancel)
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
        if (!mock) logger.info('ENTER SIGNAL',entrySignal)
      }
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(params) { try {
  var {positionSize,bid,ask,lastPrice,signal} = params
  if (positionSize == 0 || !lastPrice) return

  var {entryPrice,entryOrders,takeProfitOrders,closeOrders} = signal

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

    if (!mock) logger.info('CLOSE ORDER', exit)
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
      return await bitmex.order(orders)
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPosition(params) {
  if (params.positionSize == 0) {
    await checkEntry(params)
  }
  else {
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

async function init(_entrySignalTable) {
  var now = getTimeNow()
  exitCandleTime = now - (now % oneCandleMS)
  base.init()
  entrySignalTable = _entrySignalTable

  if (mock) {
    getTimeNow = mock.getTimeNow
  }
}

module.exports = {
  init: init,
  getSignals: getSignals,
  checkPosition: checkPosition,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  getEntryExitOrders: getEntryExitOrders
}
