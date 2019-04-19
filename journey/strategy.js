const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('./bitmex')
const shoes = require('./shoes')

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

async function getOrderSignal(signal,market,bankroll,walletBalance) { try {
  var timestamp = new Date().toISOString()
  let signalCondition = signal.condition
  
  let lastIndex = market.closes.length - 1
  let close = market.closes[lastIndex]
  let {outsideCapitalBTC=0,outsideCapitalUSD=0,riskPerTradePercent,profitFactor,halfProfitFactor,
    stopMarketFactor,stopLossLookBack,scaleInFactor,scaleInLength,minOrderSizeBTC} = bankroll

  let leverageMargin = walletBalance*0.000000008
  let entryPrice, lossDistance, stopLoss, profitDistance, takeProfit, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger,lossDistancePercent,
    riskAmountUSD, riskAmountBTC, positionSizeUSD, positionSizeBTC, leverage

  let quote = bitmex.getQuote()

  // Test
  // if (shoes.test ) {
  //   if (signalCondition == 'S') signalCondition = 'SHORT'
  //   else if (signalCondition == 'L' || signalCondition == '-') signalCondition = 'LONG'
  // }

  switch(signalCondition) {
    case 'SHORT':
      stopLoss = highestBody(market,stopLossLookBack)
      stopLoss = Math.round(stopLoss*2)/2
      entryPrice = Math.max(quote.askPrice||0,close) // use askPrice or close to be a maker
      entryPrice = Math.min(entryPrice,stopLoss) // askPrice might already went up higher than stopLoss
      break;
    case 'LONG':
      stopLoss = lowestBody(market,stopLossLookBack)
      stopLoss = Math.round(stopLoss*2)/2
      entryPrice = Math.min(quote.bidPrice||Infinity,close) // use bidPrice or close to be a maker
      entryPrice = Math.max(entryPrice,stopLoss) // bidPrice might already went down lower than stopLoss
      break;
  }

  lossDistance = stopLoss - entryPrice
  stopMarketDistance = Math.round(lossDistance*stopMarketFactor*2)/2 // round to 0.5
  stopMarket = entryPrice + stopMarketDistance
  profitDistance = Math.round(-lossDistance*profitFactor*2)/2 // round to 0.5
  takeProfit = entryPrice + profitDistance
  halfProfitDistance = Math.floor(-lossDistance*halfProfitFactor*2)/2
  takeHalfProfit = entryPrice + halfProfitDistance

  stopLossTrigger = entryPrice + (lossDistance/2)
  takeProfitTrigger = entryPrice + (profitDistance/8)
  stopMarketTrigger = entryPrice + (stopMarketDistance/4)
  lossDistancePercent = lossDistance/entryPrice

  let capitalBTC = (outsideCapitalUSD/entryPrice) + outsideCapitalBTC + walletBalance/100000000
  let capitalUSD = capitalBTC * entryPrice

  riskAmountBTC = capitalBTC * riskPerTradePercent
  riskAmountUSD = riskAmountBTC * entryPrice
  positionSizeBTC = riskAmountBTC / -lossDistancePercent
  if (positionSizeBTC < minOrderSizeBTC) {
    positionSizeBTC = minOrderSizeBTC
  }
  positionSizeUSD = Math.ceil(positionSizeBTC * entryPrice)
  leverage = Math.max(Math.ceil(Math.abs(positionSizeBTC / leverageMargin)*100)/100,1)

  var absLossDistancePercent = Math.abs(lossDistancePercent)
  var goodStopDistance = absLossDistancePercent >= bankroll.minStopLoss && absLossDistancePercent <= bankroll.maxStopLoss

  var scaleInSize = Math.round(positionSizeUSD/scaleInLength)
  var minScaleInSize = minOrderSizeBTC * entryPrice
  if (scaleInSize < minScaleInSize) {
    scaleInLength = Math.floor(positionSizeUSD/minScaleInSize)
    scaleInSize = Math.round(positionSizeUSD/scaleInLength)
  }

  var scaleInDistance = lossDistance * scaleInFactor
  if (scaleInDistance && Math.abs(scaleInDistance) < 2) {
    scaleInDistance = scaleInDistance > 0 ? 2 : -2
  }
  var scaleInStep = scaleInDistance/(scaleInLength-1)
  if (Math.abs(scaleInStep) == Infinity) {
    scaleInStep = 0
  }
  
  var scaleInOrders = []
  for (var i = 0; i < scaleInLength; i++) {
    scaleInOrders.push({
      size:scaleInSize,
      price:Math.round((entryPrice+scaleInStep*i)*2)/2
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
    positionSizeBTC: positionSizeBTC,
    positionSizeUSD: positionSizeUSD,
    leverage: leverage,
    scaleInOrders: scaleInOrders
  }
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  getSignal: getSignal,
  getOrderSignal: getOrderSignal,
  getRsi: getRsi
}
