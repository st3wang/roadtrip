const fs = require('fs')
const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('./bitmex')
const shoes = require('./shoes')
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const entrySignalFilePath = global.logDir + '/entry_signal.json'

const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000
const fundingWindowTime = setup.candle.fundingWindow * oneCandleMS
var cutOffTimeForAll = setup.candle.inTradeMax*60000
var cutOffTimeForLargeTrade = 59*60000

var mock
if (shoes.setup.startTime) mock = require('./mock.js')

var logger, entrySignalTable, entrySignal, exitCandleTime
var roundPriceFactor

function getTimeNow() {
  return new Date().getTime()
}

function lowestBody(market,length) {
  var opens = market.opens, closes = market.closes, lows = market.lows
  var lowest = 9999999
  var start = market.closes.length - length
  var end = market.closes.length
  for (var i = start; i < end; i++) {
    var weightedLow = (Math.min(opens[i],closes[i])+lows[i])/2
    if (weightedLow < lowest) {
      lowest = weightedLow
    }
  }
  return lowest
}

function highestBody(market,length) {
  var opens = market.opens, closes = market.closes, highs = market.highs
  var highest = 0
  var start = market.closes.length - length
  var end = market.closes.length
  for (var i = start; i < end; i++) {
    var weightedHigh = (Math.max(opens[i],closes[i])+highs[i])/2
    if (weightedHigh > highest) {
      highest = weightedHigh
    }
  }
  return highest
}

function roundPrice(p) {
  return +((Math.round(p*roundPriceFactor)/roundPriceFactor).toFixed(2))
}

async function getRsi(data,length) { try {
  var result = await talibExecute({
    name: "RSI",
    inReal: data,
    startIdx: 0,
    endIdx: data.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
} catch(e) {console.error(e.stack||e);debugger} }

async function getRsiSignal(market,{shortPrsi,shortRsi,longPrsi,longRsi,length}) { try {
  var rsis = (market.rsis || await getRsi(market.closes,length))
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
    length:length,
    closes: market.closes
  }
} catch(e) {console.error(e.stack||e);debugger} }

function getRsiStopLoss(signalCondition,market,stopLossLookBack) {
  switch(signalCondition) {
    case 'SHORT':
      return roundPrice(highestBody(market,stopLossLookBack))
      // entryPrice = Math.max(quote.askPrice||0,close) // use askPrice or close to be a maker
      // entryPrice = Math.min(entryPrice,stopLoss) // askPrice might already went up higher than stopLoss
      break;
    case 'LONG':
      return roundPrice(lowestBody(market,stopLossLookBack))
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
  stopMarketDistance = roundPrice(lossDistance * stopMarketFactor)
  profitDistance = roundPrice(-lossDistance * profitFactor)
  halfProfitDistance = roundPrice(-lossDistance * halfProfitFactor)
  if (profitDistance == halfProfitDistance) {
    profitDistance += tick*side
  }

  stopMarket = roundPrice(entryPrice + stopMarketDistance)
  takeProfit = roundPrice(entryPrice + profitDistance)
  takeHalfProfit = roundPrice(entryPrice + halfProfitDistance)

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
      price:roundPrice(entryPrice+scaleInStep*i)
    })
  }
  
  // if (shoes.test ) {
  //   if (scaleInOrders.length <= 1) goodStopDistance = false
  // }

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
  roundPriceFactor = 1/setup.candle.tick

  if (setup.rsi) {
    signal = await getRsiSignal(market,setup.rsi)
    // Test
    // if (shoes.test ) {
    //   if (signalCondition == 'S' || signalCondition == '-') signalCondition = 'SHORT'
    //   else if (signalCondition == 'L') signalCondition = 'LONG'
    // }
    stopLoss = getRsiStopLoss(signal.condition, market, setup.rsi.stopLossLookBack)
  }

  var quote = bitmex.getQuote()
  var XBTUSDRate = bitmex.getRate('XBTUSD')
  var coinPairRate = quote.lastPrice/XBTUSDRate
  walletBalance /= coinPairRate
  
  var lastIndex = market.closes.length - 1
  var close = market.closes[lastIndex]

  entryPrice = close
  lossDistance = roundPrice(stopLoss - entryPrice)
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

function isFundingWindow(fundingTimestamp) {
  var fundingTime = new Date(fundingTimestamp).getTime()
  var checkFundingPositionTime = fundingTime - fundingWindowTime //1800000
  var now = getTimeNow()
  return (now > checkFundingPositionTime)
}

function isInPositionForTooLong(signal) {
  if (signal) {
    var time = getTimeNow()
    var entryTime = new Date(signal.timestamp).getTime()
    var delta = time-entryTime
    return (delta > cutOffTimeForAll)
     //|| (delta > cutOffTimeForLargeTrade && Math.abs(signal.lossDistancePercent) >= 0.002))
  }
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
  return (exitTooLong(cancelParams) 
  //|| exitFunding(cancelParams) 
  || exitTarget(cancelParams) || exitStop(cancelParams))
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
    if (isFundingWindow(fundingTimestamp) &&
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

async function orderEntry() { try {
  let {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal)
  let existingEntryOrders = bitmex.findOrders(/New|Fill/,entryOrders).filter(o => {
    return (new Date(o.timestamp).getTime() >= entrySignal.time)
  })
  if (existingEntryOrders.length > 0) {
    // logger.info('ENTRY ORDER EXISTS')
  }
  else {
    if (!mock) logger.info('ENTER ORDER',entrySignal)
    let response = await bitmex.order(entryOrders.concat(closeOrders),true)
    if (response.status == 200) {
      fs.writeFileSync(entrySignalFilePath,JSON.stringify(entrySignal,null,2),writeFileOptions)
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

  if (entrySignal.timestamp) {
    let now = getTimeNow()
    if (now > (entrySignal.time + oneCandleMS)) {
      let {open,close} = await bitmex.getLastCandle()
      if ((entrySignal.type == 'LONG' && close > entrySignal.entryPrice && close > open) ||
        (entrySignal.type == 'SHORT' && close < entrySignal.entryPrice && close < open)) {
          await orderEntry()
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
        entrySignalTable.info('entry',entrySignal)
        entrySignal.time = new Date(entrySignal.timestamp).getTime()
        if (!mock) logger.info('ENTER SIGNAL',entrySignal)
        // await orderEntry()
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
  entrySignal = {}
  if (fs.existsSync(entrySignalFilePath)) {
    fs.unlinkSync(entrySignalFilePath)
  }
}

function getEntrySignal() {
  return entrySignal
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

  var exitPriceOffset = (-orderQtyUSD/Math.abs(orderQtyUSD)*setup.candle.tick)
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

async function init(_logger, _entrySignalTable) {
  logger = _logger
  entrySignalTable = _entrySignalTable

  initEntrySignal()
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
