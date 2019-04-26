const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('./bitmex')
const shoes = require('./shoes')

var roundPriceFactor

function getTimeNow() {
  return new Date().getTime()
}

async function getRsi(data,length) {
  var result = await talibExecute({
    name: "RSI",
    inReal: data,
    startIdx: 0,
    endIdx: data.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
}

async function getSignal(closes,{length,shortPrsi,shortRsi,longPrsi,longRsi}) { try {
  var rsis = await getRsi(closes,length)
  var len = closes.length
  var last0 = len - 1
  var last1 = len - 2
  var rsi = rsis[last0]
  var prsi = rsis[last1]
  // var close = closes[last0]
  var shortCondition = prsi > shortPrsi && rsi <= shortRsi 
  var longCondition = prsi < longPrsi && rsi >= longRsi 
  var signal = {
    condition: '-',
    prsi: Math.round(prsi*100)/100,
    rsi: Math.round(rsi*100)/100,
    // rsis: rsis,
    // length: rsiLength,
    // overbought: rsiOverbought,
    // oversold: rsiOversold,
  }
  if (shortCondition) {
    signal.condition = 'SHORT'
  }
  else if (longCondition) {
    signal.condition = 'LONG'
  }
  else if (prsi > shortPrsi) {
    signal.condition = 'S'
  }
  else if (prsi < longPrsi) {
    signal.condition = 'L'
  }
  return signal
} catch(e) {console.error(e.stack||e);debugger} }

function lowest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.min.apply( Math, array )
}

function highest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.max.apply( Math, array )
}

function lowestBody(market,length) {
  var opens = market.opens, closes = market.closes, lows = market.lows
  var weightedLows = []
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
  // var lowestOpen = lowest(market.opens,start,length)
  // var lowestClose = lowest(market.closes,start,length)
  // return Math.min(lowestOpen,lowestClose)
}

function highestBody(market,length) {
  var opens = market.opens, closes = market.closes, highs = market.highs
  var weightedHighs = []
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
  // var highestOpen = highest(market.opens,start,length)
  // var highestClose = highest(market.closes,start,length)
  // return Math.max(highestOpen,highestClose)
}

function roundPrice(p) {
  return +((Math.round(p*roundPriceFactor)/roundPriceFactor).toFixed(2))
}

async function getOrderSignal(signal,market,bankroll,walletBalance) { try {
  var timestamp = new Date(getTimeNow()).toISOString()
  var signalCondition = signal.condition
  
  var lastIndex = market.closes.length - 1
  var close = market.closes[lastIndex]
  var {outsideCapitalBTC=0,outsideCapitalUSD=0,riskPerTradePercent,profitFactor,halfProfitFactor,
    stopMarketFactor,stopLossLookBack,scaleInFactor,scaleInLength,minOrderSizeBTC,tick} = bankroll

  var leverageMargin = walletBalance*0.000000008
  var entryPrice, lossDistance, stopLoss, profitDistance, takeProfit, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger,lossDistancePercent,
    riskAmountUSD, riskAmountBTC, orderQtyUSD, qtyBTC, leverage

  var quote = bitmex.getQuote()
  var XBTUSDRate = bitmex.getRate('XBTUSD')
  var coinPairRate = quote.lastPrice/XBTUSDRate

  roundPriceFactor = 1/tick
  walletBalance /= coinPairRate
  minOrderSizeBTC /= coinPairRate

  // Test
  if (shoes.test ) {
    if (signalCondition == 'S' || signalCondition == '-') signalCondition = 'SHORT'
    else if (signalCondition == 'L') signalCondition = 'LONG'
  }

  switch(signalCondition) {
    case 'SHORT':
      stopLoss = roundPrice(highestBody(market,stopLossLookBack))
      entryPrice = Math.max(quote.askPrice||0,close) // use askPrice or close to be a maker
      entryPrice = Math.min(entryPrice,stopLoss) // askPrice might already went up higher than stopLoss
      break;
    case 'LONG':
      stopLoss = roundPrice(lowestBody(market,stopLossLookBack))
      entryPrice = Math.min(quote.bidPrice||Infinity,close) // use bidPrice or close to be a maker
      entryPrice = Math.max(entryPrice,stopLoss) // bidPrice might already went down lower than stopLoss
      break;
  }

  entryPrice = roundPrice(entryPrice)
  lossDistance = roundPrice(stopLoss - entryPrice)
  if (!lossDistance || !walletBalance) {
    return {
      timestamp: timestamp,
      type: '-'
    }
  }

  var side = -lossDistance/Math.abs(lossDistance) // 1 or -1

  stopMarketDistance = roundPrice(lossDistance * stopMarketFactor)
  stopMarket = roundPrice(entryPrice + stopMarketDistance)
  profitDistance = roundPrice(-lossDistance * profitFactor)
  takeProfit = roundPrice(entryPrice + profitDistance)
  halfProfitDistance = roundPrice(-lossDistance * halfProfitFactor)
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
  var goodStopDistance = absLossDistancePercent >= bankroll.minStopLoss && absLossDistancePercent <= bankroll.maxStopLoss

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
    timestamp: timestamp,
    capitalBTC: capitalBTC,
    capitalUSD: capitalUSD,
    type: (goodStopDistance ? signalCondition : '-'),
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    halfProfitDistance: halfProfitDistance,
    stopLoss: stopLoss,
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
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  getSignal: getSignal,
  getOrderSignal: getOrderSignal,
  getRsi: getRsi
}
