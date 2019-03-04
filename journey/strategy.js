const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)

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

async function getSignal(closes,rsiLength,rsiOverbought,rsiOversold) {
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
}

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
  return Math.min(highestOpen,highestClose)
}

function getOrder(signal,market,bankroll,position,margin) {
  let signalCondition = signal.condition
  let positionSize = position.currentQty

  if (positionSize != 0 || signalCondition.length < 2) {
    return {type:'-'}
  }
  
  let capitalUSD = bankroll.capitalUSD
  let riskPerTradePercent = bankroll.riskPerTradePercent
  let profitFactor = bankroll.profitFactor
  let stopMarketFactor = bankroll.stopMarketFactor
  let stopLossLookBack = bankroll.stopLossLookBack
  let lastIndex = market.closes.length - 1
  let entryPrice = market.closes[lastIndex]
  let availableMargin = margin.availableMargin*0.000000009
  let riskAmountUSD = capitalUSD * riskPerTradePercent
  let riskAmountBTC = riskAmountUSD / entryPrice
  let lossDistance, stopLoss, profitDistance, takeProfit, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger, stopMarketTrigger,
    lossDistancePercent, positionSizeUSD, positionSizeBTC, leverage
  switch(signalCondition) {
    case 'SHORT':
      stopLoss = highestBody(market,lastIndex,stopLossLookBack)
      lossDistance = Math.abs(stopLoss - entryPrice)
      stopMarketDistance = Math.round(lossDistance*stopMarketFactor*2)/2
      profitDistance = -lossDistance * profitFactor
      profitDistance = Math.round(profitDistance*2)/2 // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss - 0.5
      takeProfitTrigger = takeProfit + 0.5
      stopMarketTrigger = entryPrice + stopMarketDistance
      lossDistancePercent = lossDistance/entryPrice
      positionSizeUSD = Math.round(riskAmountUSD / -lossDistancePercent)
      break;
    case 'LONG':
      stopLoss = lowestBody(market,lastIndex,stopLossLookBack)
      lossDistance = -Math.abs(entryPrice - stopLoss)
      stopMarketDistance = Math.round(lossDistance*stopMarketFactor*2)/2
      profitDistance = -lossDistance * profitFactor
      profitDistance = Math.round(profitDistance*2)/2 // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss + 0.5
      takeProfitTrigger = takeProfit - 0.5
      stopMarketTrigger = entryPrice + stopMarketDistance
      lossDistancePercent = lossDistance/entryPrice
      positionSizeUSD = Math.round(capitalUSD * riskPerTradePercent / -lossDistancePercent)
      break;
  }
  
  positionSizeBTC = positionSizeUSD / entryPrice
  leverage = Math.ceil(Math.abs(positionSizeBTC / availableMargin))

  return {
    type: (Math.abs(lossDistancePercent) < bankroll.minimumStopLoss) ? '-' : signalCondition,
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    stopLoss: stopLoss,
    takeProfit: takeProfit,
    stopLossTrigger: stopLossTrigger,
    takeProfitTrigger: takeProfitTrigger,
    stopMarketTrigger: stopMarketTrigger,
    riskAmountUSD: riskAmountUSD,
    riskAmountBTC: riskAmountBTC,
    positionSizeUSD: positionSizeUSD,
    positionSizeBTC: positionSizeBTC,
    leverage: leverage
  }
}

module.exports = {
  getSignal: getSignal,
  getOrder: getOrder,
  getRsi: getRsi
}
