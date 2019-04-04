const util = require('util')
const talib = require('talib')
const talibExecute = util.promisify(talib.execute)
const bitmex = require('./bitmex')
const mock = require('./mock')

function getNow() {
  return new Date()
}

if (mock) {
  getNow = mock.getNow
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

async function getOrderSignal(signal,market,bankroll,availableMargin) { try {
  var timestamp = getNow().toISOString()
  let signalCondition = signal.condition
  
  let lastIndex = market.closes.length - 1
  let close = market.closes[lastIndex]
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
      stopMarketDistance = lossDistance*stopMarketFactor
      // stopMarketDistance = Math.round(stopMarketDistance*2)/2 // round to 0.5
      profitDistance = -lossDistance*profitFactor
      // profitDistance = Math.round(profitDistance*2)/2 // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = entryPrice + (lossDistance/4)
      takeProfitTrigger = entryPrice - (lossDistance/4)
      // stopMarketTrigger = entryPrice + stopMarketDistance
      lossDistancePercent = lossDistance/entryPrice
      // positionSizeUSD = Math.round(riskAmountUSD / -lossDistancePercent)
      break;
    case 'LONG':
      stopLoss = lowestBody(market,lastIndex,stopLossLookBack)
      entryPrice = Math.min(quote.bidPrice,close)
      entryPrice = Math.max(entryPrice,stopLoss) // bidPrice might already went down lower than stopLoss
      lossDistance = -Math.abs(entryPrice - stopLoss)
      stopMarketDistance = lossDistance*stopMarketFactor
      // stopMarketDistance = Math.round(stopMarketDistance*2)/2 // round to 0.5
      profitDistance = -lossDistance * profitFactor
      // profitDistance = Math.round(profitDistance*2)/2 // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = entryPrice + (lossDistance/4)
      takeProfitTrigger = entryPrice - (lossDistance/4)
      // stopMarketTrigger = entryPrice + stopMarketDistance
      lossDistancePercent = lossDistance/entryPrice
      // positionSizeUSD = Math.round(capitalUSD * riskPerTradePercent / -lossDistancePercent)
      break;
  }

  //(3950*4000)/(4000-3950)*0.01
  // LONG positionSizeUSD = (stopLoss*entryPrice)/(entryPrice-stopLoss)*riskPerTradePercent

  let capitalBTC = (outsideCapitalUSD/entryPrice) + outsideCapitalBTC + availableMargin/100000000
  let capitalUSD = capitalBTC * entryPrice

  riskAmountBTC = capitalBTC * riskPerTradePercent
  riskAmountUSD = riskAmountBTC * entryPrice
  positionSizeBTC = riskAmountBTC / -lossDistancePercent
  positionSizeUSD = Math.round(positionSizeBTC * entryPrice)
  leverage = Math.max(Math.ceil(Math.abs(positionSizeBTC / leverageMargin)*100)/100,1)

  var absLossDistancePercent = Math.abs(lossDistancePercent)
  var goodStopDistance = absLossDistancePercent >= bankroll.minStopLoss && absLossDistancePercent <= bankroll.maxStopLoss

  return {
    timestamp: timestamp,
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
