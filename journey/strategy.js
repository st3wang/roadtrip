const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('./bitmex')
const shoes = require('./shoes')

var mock
if (shoes.mock) mock = require('./mock.js')

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

async function init() {
  if (mock) {
    getTimeNow = mock.getTimeNow
  }
}

module.exports = {
  init: init,
  getSignals: getSignals
}
