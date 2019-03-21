const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('./bitmex')

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

async function getSignal(closes,rsiLength,rsiOverbought,rsiOversold) { try {
  var rsis = await getRsi(closes,rsiLength)
  var len = closes.length
  var last0 = len - 1
  var last1 = len - 2
  var rsi = rsis[last0]
  var prsi = rsis[last1]
  var close = closes[last0]
  var shortCondition = prsi > rsiOverbought && rsi <= rsiOverbought 
  var longCondition = prsi < rsiOversold && rsi >= rsiOversold 
  var signal = {
    rsis: rsis,
    length: rsiLength,
    overbought: rsiOverbought,
    oversold: rsiOversold,
    prsi: prsi,
    rsi: rsi,
    condition: '-'
  }
  if (shortCondition) {
    signal.condition = 'SHORT'
  }
  else if (longCondition) {
    signal.condition = 'LONG'
  }
  else if (prsi > rsiOverbought) {
    signal.condition = 'S'
  }
  else if (prsi < rsiOversold) {
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

function lowestBody(market,start,length) {
  var lowestOpen = lowest(market.opens,start,length)
  var lowestClose = lowest(market.closes,start,length)
  return Math.min(lowestOpen,lowestClose)
}

function highestBody(market,start,length) {
  var highestOpen = highest(market.opens,start,length)
  var highestClose = highest(market.closes,start,length)
  return Math.max(highestOpen,highestClose)
}

async function getOrderSignal(signal,market,bankroll,margin) { try {
  var created = new Date().toISOString()
  let signalCondition = signal.condition
  
  let lastIndex = market.closes.length - 1
  let close = market.closes[lastIndex]
  let availableMargin = margin.availableMargin
  let outsideCapitalBTC = bankroll.outsideCapitalBTC || 0
  let outsideCapitalUSD = bankroll.outsideCapitalUSD || 0
  let riskPerTradePercent = bankroll.riskPerTradePercent
  let profitFactor = bankroll.profitFactor
  let stopMarketFactor = bankroll.stopMarketFactor
  let stopLossLookBack = bankroll.stopLossLookBack
  let leverageMargin = availableMargin*0.000000008
  let entryPrice, lossDistance, stopLoss, profitDistance, takeProfit, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger, stopMarketTrigger,lossDistancePercent,
    riskAmountUSD, riskAmountBTC, positionSizeUSD, positionSizeBTC, leverage

  let quote = bitmex.getQuote()

  switch(signalCondition) {
    case 'SHORT':
      stopLoss = highestBody(market,lastIndex,stopLossLookBack)
      entryPrice = Math.max(quote.askPrice,close) // use askPrice or close
      entryPrice = Math.min(entryPrice,stopLoss) // askPrice might already went up higher than stopLoss
      lossDistance = Math.abs(stopLoss - entryPrice)
      stopMarketDistance = Math.round(lossDistance*stopMarketFactor*2)/2 // round to 0.5
      profitDistance = Math.round(-lossDistance*profitFactor*2)/2 // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss - 0.5
      takeProfitTrigger = entryPrice - 2 //takeProfit + 0.5
      stopMarketTrigger = entryPrice + stopMarketDistance
      lossDistancePercent = lossDistance/entryPrice
      // positionSizeUSD = Math.round(riskAmountUSD / -lossDistancePercent)
      break;
    case 'LONG':
      stopLoss = lowestBody(market,lastIndex,stopLossLookBack)
      entryPrice = Math.min(quote.bidPrice,close)
      entryPrice = Math.max(entryPrice,stopLoss) // bidPrice might already went down lower than stopLoss
      lossDistance = -Math.abs(entryPrice - stopLoss)
      stopMarketDistance = Math.round(lossDistance*stopMarketFactor*2)/2
      profitDistance = -lossDistance * profitFactor
      profitDistance = Math.round(profitDistance*2)/2 // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss + 0.5
      takeProfitTrigger = entryPrice + 2 //takeProfit - 0.5
      stopMarketTrigger = entryPrice + stopMarketDistance
      lossDistancePercent = lossDistance/entryPrice
      // positionSizeUSD = Math.round(capitalUSD * riskPerTradePercent / -lossDistancePercent)
      break;
  }

  let capitalBTC = (outsideCapitalUSD/entryPrice) + outsideCapitalBTC + availableMargin/100000000
  let capitalUSD = capitalBTC * entryPrice

  riskAmountBTC = capitalBTC * riskPerTradePercent
  riskAmountUSD = Math.round(riskAmountBTC * entryPrice)
  positionSizeBTC = riskAmountBTC / -lossDistancePercent
  positionSizeUSD = Math.round(positionSizeBTC * entryPrice)
  leverage = Math.max(Math.ceil(Math.abs(positionSizeBTC / leverageMargin)*100)/100,1)

  var absLossDistancePercent = Math.abs(lossDistancePercent)
  var goodStopDistance = absLossDistancePercent >= bankroll.minStopLoss && absLossDistancePercent <= bankroll.maxStopLoss

  return {
    created: created,
    capitalBTC: capitalBTC,
    capitalUSD: capitalUSD,
    type: (goodStopDistance ? signalCondition : '-'),
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    stopLoss: stopLoss,
    takeProfit: takeProfit,
    stopLossTrigger: stopLossTrigger,
    takeProfitTrigger: takeProfitTrigger,
    stopMarketTrigger: stopMarketTrigger,
    riskAmountBTC: riskAmountBTC,
    riskAmountUSD: riskAmountUSD,
    positionSizeBTC: positionSizeBTC,
    positionSizeUSD: positionSizeUSD,
    leverage: leverage
  }
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  getSignal: getSignal,
  getOrderSignal: getOrderSignal,
  getRsi: getRsi
}
