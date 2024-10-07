const path = require('path')

const base = require('./base_strategy.js')
const shoes = require('../shoes.js')
const setup = shoes.setup

const basedata = require('../exchange/basedata.js')
const bitmex = require('../exchange/bitmex.js')
const coinbase = require('../exchange/coinbase.js')
const bitstamp = require('../exchange/bitstamp.js')
const binance = require('../exchange/binance.js')
const bitfinex = require('../exchange/bitfinex.js')
const exchanges = {bitmex: bitmex, coinbase: coinbase, bitstamp: bitstamp, binance: binance, bitfinex: bitfinex}
var tradeExchanges

const winston = require('winston')
const storage = require('../storage.js')
const candlestick = require('../candlestick.js')
const email = require('../email/email.js')

const oneCandleMS = setup.candle.interval*60000

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global

function typeColor(type) {
  return (type == 'LONG' ? '\x1b[36m' : type == 'SHORT' ? '\x1b[35m' : '') + type + '\x1b[39m'
}

function getStopRisk({exchange,positionSize,lastPrice,walletBalance,marginBalance,unrealisedPnl},stopLoss) {
  // console.log(positionSize,lastPrice,walletBalance,unrealisedPnl,stopLoss)
  const lastCost = exchanges[exchange].getCost({
    side: 'Sell',
    cumQty: -positionSize,
    price: lastPrice,
    execInst: 'LastPrice,Close'
  })
  // console.log('lastCost',lastCost)
  const stopCost = exchanges[exchange].getCost({
    side: 'Sell',
    cumQty: -positionSize,
    price: stopLoss,
    execInst: 'LastPrice,Close'
  })
  // console.log('stopCost',stopCost)

  marginBalance = walletBalance + unrealisedPnl
  
  const stopDistance = lastCost[0] - stopCost[0]
  const stopDistancePercent = stopDistance / lastCost[0] || 0
  const stopBalance = walletBalance + unrealisedPnl + stopDistance
  const stopPnlPercent = Math.round((stopBalance-walletBalance) / walletBalance * 10000) / 100
  const stopRisk = stopBalance-marginBalance
  const stopRiskPercent = Math.round(stopRisk / walletBalance * 10000) / 100

  const riskPerTradePercent = setup.exchange[exchange].riskPerTradePercent * 100
  const stopDistanceRiskRatio = Math.round(stopRiskPercent/stopDistancePercent/riskPerTradePercent/10) || 0

  // console.log(stopDistance.toFixed(0), stopDistancePercent.toFixed(2), stopRisk.toFixed(0), stopRiskPercent, stopDistanceRiskRatio)
  
  return {
    stopBalance: stopBalance,
    stopPnlPercent: stopPnlPercent,
    stopRiskPercent: stopRiskPercent,
    stopDistanceRiskRatio: stopDistanceRiskRatio
  }
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
            case 'checkEntry': {
              let {exchange,caller,walletBalance,marginBalance,unrealisedPnl,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal,currentStopPx} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal.signal || {}
              let marginBalanceString,marginPnlPercent,stopBalanceString,stopDistanceRiskRatioString,lossDistancePercentString, positionSizeString, lastPriceString
              stopLoss = currentStopPx || stopLoss
              walletBalance /= 100000000
              unrealisedPnl /= 100000000
              marginBalance /= 100000000
              marginPnlPercent = Math.round((marginBalance-walletBalance) / walletBalance * 10000) / 100
              marginBalanceString = (marginBalance > walletBalance ? '\x1b[32m' : (marginBalance < walletBalance ? '\x1b[31m' : '')) + marginBalance.toFixed(4) + ' ' + marginPnlPercent + '%\x1b[39m'

              let {stopBalance,stopPnlPercent,stopDistanceRiskRatio} = getStopRisk(splat[0],stopLoss) 
              stopBalance /= 100000000
              stopBalanceString = (stopBalance > walletBalance ? '\x1b[32m' : (stopBalance < walletBalance ? '\x1b[31m' : '')) + stopBalance.toFixed(4) + ' ' + stopPnlPercent + '%\x1b[39m'
              stopDistanceRiskRatioString = (stopDistanceRiskRatio < 70 ? '\x1b[32m' : '\x1b[31m') + stopDistanceRiskRatio + '\x1b[39m'

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
              let fundingRateString = (fundingRate > 0 ? '\x1b[32m' : '\x1b[31m') + (fundingRate*100).toFixed(4) + '\x1b[39m'
              line += exchange + ' ' + caller + ' B:'+walletBalance.toFixed(4)+' M:'+marginBalanceString+' S:'+stopBalanceString+' R:'+stopDistanceRiskRatioString+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' D:'+lossDistancePercentString+' F:'+fundingRateString
                //+' T:'+takeProfit.toFixed(1)+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
            } break
            case 'ENTER SIGNAL': {
              let signal = splat[0]
              if (signal) {
                let {signalExchange,condition,type='',entryPrice=NaN,stopLoss=NaN,orderQtyUSD,lossDistance=NaN,riskAmountUSD=NaN,reason=''} = signal
                line += signalExchange+' '+typeColor(condition)+' '+typeColor(type)+' '+entryPrice.toFixed(1)+' '+stopLoss.toFixed(1)+' '+orderQtyUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)+' '+reason
              }
            } break
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

async function getSMASignal(signalExchange,{rsi,sma},symbol) { try {
  var now = getTimeNow()
  var signal = {
    timestamp: new Date(now).toISOString(),
    signalExchange: signalExchange.name,
    condition: '-'
  }

  var market = await signalExchange.getCurrentMarket(symbol)
  if (!market || !market.candles || market.candles.length != setup.candle.length) {
    console.log(signalExchange.name, 'invalid market', (market && market.candles) ? market.candles.length : market)
    return signal
  }
  else {
    // console.log(signalExchange.name, 'got market', market.candles.length)
  }

  var last = market.closes.length-1
  var open = market.opens[last]
  var close = market.closes[last]
  
  var fastAverage = await base.getSMA(market.closes, sma.fast)
  var slowAverage = await base.getSMA(market.closes, sma.slow)
  var longAverage = await base.getSMA(market.closes, sma.long)

  var fastAverage0 = fastAverage[fastAverage.length-1]
  var fastAverage1 = fastAverage[fastAverage.length-2]
  var fastAverage2 = fastAverage[fastAverage.length-3]
  var slowAverage0 = slowAverage[slowAverage.length-1]
  var slowAverage1 = slowAverage[slowAverage.length-2]
  var slowAverage2 = slowAverage[slowAverage.length-3]
  var longAverage0 = longAverage[longAverage.length-1]

  var crossLong0 = fastAverage1 < slowAverage1 && fastAverage0 > slowAverage0
  var crossLong1 = fastAverage2 < slowAverage2 && fastAverage1 > slowAverage1
  var crossShort0 = fastAverage1 > slowAverage1 && fastAverage0 < slowAverage0
  var crossShort1 = fastAverage2 > slowAverage2 && fastAverage1 < slowAverage1

  // TODO: RSI value is very close but not correct
  var rsis = (market.rsis || await base.getRsi(market.closes,rsi.rsiLength))
  const rsi0 = rsis[rsis.length-1]
  var rsiModerate = rsi0 > 46 && rsi0 < 60
  
  var crossLongCheck = crossLong0 || crossLong1
  var crossShortCheck = crossShort0 || crossShort1
  
  var averageLongCheck = slowAverage0 > longAverage0 //and slowAverage[0] > longAverage[0]
  var averageShortCheck = slowAverage0 < longAverage0 //and slowAverage[1] < longAverage[1]
  
  var priceLongCheck = close < open //and close[1] > open[1] 
  var priceShortCheck = close > open //and close[1] < open[1] 
  
  var longCondition = crossLongCheck && rsiModerate && averageLongCheck && priceLongCheck
  var shortCondition = crossShortCheck && rsiModerate && averageShortCheck && priceShortCheck

  if (longCondition) {
    signal.condition = 'LONG'
  } 
  if (shortCondition) {
    signal.condition = 'SHORT'
  }
  
  // await basedata.writeSignal(signalExchange.name,signalExchange.symbols[setup.symbol],setup.candle.interval,now,signal)

  return signal
} catch(e) {console.error(e.stack||e);debugger} }

function getStopLoss(market, signal, stopLossLookBack) {
  const lastIndex = market.lows.length

  switch(signal.condition) {
    case 'LONG': {
      // lowest
      return Math.min(...market.lows.slice(lastIndex-stopLossLookBack,lastIndex))
    } break;
    case 'SHORT': {
      // highest
      return Math.max(...market.highs.slice(lastIndex-stopLossLookBack,lastIndex))
    } break;
  }

  return NaN
}

async function getOrder(tradeExchange,setup,position,signal) {
  var lastCandle = tradeExchange.getLastCandle()
  var currentCandle = await tradeExchange.getCurrentCandle()
  if (signal.condition == '-') {
    return signal
  }

  const quote = await tradeExchange.getQuote()
  const market = await tradeExchange.getCurrentMarket()
  const existingSignal = getEntrySignal(tradeExchange.name).signal
  const riskPerTradePercent = setup.exchange[tradeExchange.name].riskPerTradePercent
  const stopLossLookBack = setup.candle.stopLossLookBack

  // capital = strategy.equity

  var {profitFactor,stopMarketFactor,scaleInLength,minOrderSizeBTC,minStopLoss,maxStopLoss} = setup.bankroll
  // var side = -lossDistance/Math.abs(lossDistance) // 1 or -1

  signal.stopLoss = base.roundPrice(tradeExchange, getStopLoss(market,signal,stopLossLookBack))
  signal.entryPrice = base.roundPrice(tradeExchange, Math.min(lastCandle.close,quote.bidPrice))
  signal.lossDistance = signal.stopLoss - signal.entryPrice
  signal.takeProfit = base.roundPrice(tradeExchange, signal.entryPrice - (signal.lossDistance * profitFactor))

  var XBTUSDRate = quote.lastPrice
  signal.coinPairRate = quote.lastPrice/XBTUSDRate
  signal.marginBalance = position.marginBalance / signal.coinPairRate

  if (!signal.lossDistance || !signal.marginBalance) {
    debugger
    return signal
  }

  if (position.positionSize != 0) {
    console.log('already in position')
    return signal
  }

  switch(signal.condition) {
    case 'LONG':
      if (signal.entryPrice <= signal.stopLoss) {
        signal.reason = 'entryPrice <= stopLoss ' + JSON.stringify(quote)
        debugger
        return signal
      }
      else if (currentCandle && currentCandle.low <= signal.stopLoss) {
        signal.reason = 'currentCandle.low <= stopLoss ' + JSON.stringify(currentCandle)
        debugger
        return signal
      }
      break
    case 'SHORT':
      if (signal.entryPrice >= signal.stopLoss) {
        signal.reason = 'entryPrice >= stopLoss ' + JSON.stringify(quote)
        debugger
        return signal
      }
      else if (currentCandle && currentCandle.high >= signal.stopLoss) {
        signal.reason = 'currentCandle.high >= stopLoss ' + JSON.stringify(currentCandle)
        debugger
        return signal
      }
      break
  }

  var {marginBalance,entryPrice,lossDistance,coinPairRate} = signal
  var leverageMargin = marginBalance*0.000000008
  var profitDistance, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger,lossDistancePercent,
    riskAmountUSD, riskAmountBTC, orderQtyUSD, qtyBTC, leverage

  minOrderSizeBTC /= coinPairRate
  stopMarketDistance = base.roundPrice(tradeExchange, lossDistance * stopMarketFactor)
  profitDistance = base.roundPrice(tradeExchange, -lossDistance * profitFactor)

  stopMarket = base.roundPrice(tradeExchange, entryPrice + stopMarketDistance)
  takeProfit = base.roundPrice(tradeExchange, entryPrice + profitDistance)

  stopLossTrigger = entryPrice + (lossDistance/2)
  takeProfitTrigger = entryPrice + (profitDistance/8)
  stopMarketTrigger = entryPrice + (stopMarketDistance/4)
  lossDistancePercent = lossDistance/entryPrice
console.log(signal)
  const {stopBalance, stopRiskPercent, stopDistanceRiskRatio} = getStopRisk(position,stopMarket) 
  // console.log(stopRiskPercent)
  // if (stopDistanceRiskRatio > riskPerTradePercent*6000) {
  //   riskPerTradePercent /= 2
  // }
  // else 
  // if (stopDistanceRiskRatio > riskPerTradePercent*7000) {
  //   riskPerTradePercent /= 10
  // }

  var capitalBTC = stopBalance/100000000
  var capitalUSD = capitalBTC * entryPrice
  riskAmountBTC = capitalBTC * riskPerTradePercent
  riskAmountUSD = riskAmountBTC * entryPrice
  qtyBTC = riskAmountBTC / -lossDistancePercent
  orderQtyUSD = Math.round(qtyBTC * entryPrice)

  // Order quantity must be a multiple of lot size: 100
  orderQtyUSD = Math.ceil(orderQtyUSD/100)*100
  // reculate after adjusting to 100 lot size
  qtyBTC = orderQtyUSD/entryPrice
  riskAmountBTC = qtyBTC * -lossDistancePercent
  riskAmountUSD = riskAmountBTC * entryPrice

  leverage = Math.max(Math.ceil(Math.abs(qtyBTC / leverageMargin)*100)/100,1)

  var scaleInSize = Math.round(orderQtyUSD / scaleInLength)
  var scaleInStep = 0
  
  var scaleInOrders = []
  for (var i = 0; i < scaleInLength; i++) {
    scaleInOrders.push({
      size:scaleInSize,
      price:base.roundPrice(tradeExchange, entryPrice+scaleInStep*i, signal.condition == 'LONG' ? Math.floor : Math.ceil)
    })
  }

  var order = Object.assign({
    capitalBTC: capitalBTC,
    capitalUSD: capitalUSD,
    type: signal.condition,
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    takeProfit: takeProfit,
    stopMarket: stopMarket,
    stopLossLookBack: stopLossLookBack,
    stopLossTrigger: stopLossTrigger,
    takeProfitTrigger: takeProfitTrigger,
    stopMarketTrigger: stopMarketTrigger,
    riskPerTradePercent: riskPerTradePercent,
    riskAmountBTC: riskAmountBTC,
    riskAmountUSD: riskAmountUSD,
    qtyBTC: qtyBTC,
    orderQtyUSD: orderQtyUSD,
    leverage: leverage,
    scaleInOrders: scaleInOrders,
    stopRiskPercent: stopRiskPercent,
    stopDistanceRiskRatio: stopDistanceRiskRatio
  },signal)

  // if (!goodStopDistance) {
  //   order.type = '-'
  //   order.reason = 'not good stop distance. ' + JSON.stringify({
  //     absLossDistancePercent: absLossDistancePercent,
  //     minStopLoss: minStopLoss,
  //     maxStopLoss: maxStopLoss
  //   })
  // }

  return order
}

async function getSignal(tradeExchange,setup,position) {
  const tradeExchangeSignal = await getSMASignal(tradeExchange,setup)
  if (tradeExchangeSignal.condition != '-') {
    return tradeExchangeSignal
  }

  return tradeExchangeSignal
}

function cancelOrder(params) {
  var {positionSize,signal} = params
  
  if (positionSize != 0) return

  let cancelParams = Object.assign({},params)
  cancelParams.positionSize = signal.orderQtyUSD
  return (base.exitTooLong(cancelParams) 
  //|| base.exitFunding(cancelParams) 
  || base.exitTarget(cancelParams) || base.exitStop(cancelParams))
}

function sendEmailEnter(entrySignal) {
  if (mock || shoes.test) return
  const {entryOrders} = entrySignal
  const {side,price,orderQty} = entryOrders[0]
  email.send('MoonBoy Enter ' + side + ' ' + price + ' ' + orderQty, JSON.stringify(entrySignal, null, 2))
}

function sendEmailMoveStop(response) {
  if (mock || shoes.test) return
  var subject = 'MoonBoy MoveStop '
  if (response && response.status == 200 && response.obj && response.obj[0] && response.obj[0].stopPx) {
    subject += response.obj[0].stopPx
  }
  else {
    subject += 'ERROR'
  }
  email.send(subject, JSON.stringify(response, null, 2))
}

async function orderEntry(tradeExchange,entrySignal) { try {
  var {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal.signal)
  var now = getTimeNow()
  var existingEntryOrders = tradeExchange.findOrders(/New|Fill/,entryOrders).filter(o => {
    return (now < new Date(o.timestamp).getTime() + oneCandleMS)
    // return (new Date(o.timestamp).getTime() >= entrySignal.time)
  })
  if (existingEntryOrders.length > 0) {
    if (!mock) logger.info('SAME ENTRY ORDER EXISTS')
  }
  else {
    if (!mock) logger.info('ENTER ORDER',entrySignal)
    closeOrders = closeOrders.slice(0,1)
    const response = await tradeExchange.order(entryOrders.concat(closeOrders).concat(takeProfitOrders),true)
    /*TODO: wait for order confirmations*/
    if (response.status == 200) {
      entrySignal.entryOrders = entryOrders
      entrySignal.closeOrders = closeOrders
      entrySignal.takeProfitOrders = takeProfitOrders
      base.setEntrySignal(tradeExchange.name,entrySignal)
      storage.writeEntrySignalTable(entrySignal)
      sendEmailEnter(entrySignal)
    }
    else {
      console.error(response)
      debugger
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function orderExit(tradeExchange,stopPx) { try {
  var closeOrders = [{
    stopPx: stopPx,
    side: 'Sell',
    ordType: 'Stop',
    execInst: 'LastPrice,Close',
    test: 'Exit'
  }]
  const response = await tradeExchange.order(closeOrders,true)
  /*TODO: wait for order confirmations*/
  sendEmailMoveStop(response)
} catch(e) {logger.error(e.stack||e);debugger} }

function isBear({lastPrice}) {
  const now = getTimeNow()
  if (now >= 1483660800000 && now < 1484697600000) return true

  if (now >= 1515283200000 && now < 1517875200000) return true
  if (now >= 1519257600000 && now < 1523577600000) return true
  if (now >= 1524700800000 && now < 1530316800000) return true
  if (now >= 1532563200000 && now < 1534896000000) return true
  if (now >= 1537660800000 && now < 1546041600000) return true
  if (now >= 1548720000000 && now < 1550534400000) return true
  if (now >= 1559692800000 && now < 1560211200000) return true
  if (now >= 1561680000000 && now < 1570492800000) return true
  if (now >= 1582156800000 && now < 1586390400000) return true
  if (now >= 1598400000000 && now < 1600128000000) return true
  return false
}

async function checkEntry(tradeExchange) { try {
  const existingSignal = getEntrySignal(tradeExchange.name)
  const position = tradeExchange.position

  let now = getTimeNow()
  let nowDT = new Date(now)
  if (position.fundingRate < 0 && ((nowDT.getHours() - 4) % 8 == 0) && nowDT.getMinutes() == 0 && nowDT.getSeconds() < 10) {
    email.send('Funding ' + position.fundingRate, JSON.stringify(position,null,2))
  }

  position.signal = existingSignal // for logging try to remove it
  if (!mock) logger.info('checkEntry',position)

  if (existingSignal.signal) {
    let existingSignalTime = new Date(existingSignal.signal.timestamp).getTime()
    let ts = new Date(now).toISOString()
    let st = existingSignalTime - existingSignalTime % oneCandleMS
    let et = st + oneCandleMS - 1

    if (now >= st && now <= et) {
      // there is an existing signal
      let entryOrders = tradeExchange.findOrders(/New|Fill/,position.signal.entryOrders)
      if (entryOrders.length > 0) {
        if (!mock) logger.info('SIGNAL ENTRY ORDER EXISTS')
        return
      }
    }
  }
  var signal = await getOrder(tradeExchange,setup,position,await getSignal(tradeExchange,setup,position))

  if (!mock) logger.info('ENTER SIGNAL',signal)

  if (!isBear(position) && signal.orderQtyUSD) {
    var entrySignal = {signal:signal}
    await orderEntry(tradeExchange,entrySignal)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(tradeExchange) { try {
  const position = tradeExchange.position

  var {positionSize,bid,ask,lastPrice,signal} = position
  if (positionSize == 0 || !lastPrice || !signal || !signal.signal || signal.signal.condition != 'LONG') return

  var lastDistance = lastPrice - signal.signal.entryPrice
  // console.log('lastDistance', lastDistance, 'lossDistance', signal.signal.lossDistance)
  if (lastDistance >= -signal.signal.lossDistance) {
    let market = await tradeExchange.getCurrentMarket()
    let newStopLoss = getStopLoss(market,signal.signal.stopLossLookBack)
    // console.log('Move stop ', newStopLoss)
    let exitOrders = [{
      stopPx: newStopLoss,
      side: 'Sell',
      ordType: 'Stop',
      execInst: 'LastPrice,Close'
    }]
    let existingExitOrders = tradeExchange.findOrders(/New/,exitOrders)
    if (existingExitOrders.length > 0) {
      if (!mock) {
        logger.info('EXIT ORDER EXISTS', exitOrders[0].stopPx)
      }
      return
    }
    orderExit(tradeExchange,newStopLoss)
  }

  // var exit = base.exitTooLong(position) || base.exitFunding(position) || isBear()
  // if (exit) {
  //   let exitOrders = [{
  //     price: (positionSize < 0 ? bid : ask),
  //     side: (positionSize < 0 ? 'Buy' : 'Sell'),
  //     ordType: 'Limit',
  //     execInst: 'Close,ParticipateDoNotInitiate'
  //   }]
  //   exit.exitOrders = exitOrders

  //   let existingExitOrders = tradeExchange.findOrders(/New/,exitOrders)
  //   if (existingExitOrders.length == 1) {
  //     // logger.debug('EXIT EXISTING ORDER',exit)
  //     return existingExitOrders
  //   }

  //   if (!mock) logger.info('CLOSE ORDER', exit)
  //   let response = await tradeExchange.order(exitOrders,true)
  //   return response
  // }
  /*
  // move stop loss. it reduced draw down in the side way market. see Test 4
  else if ((positionSize > 0 && lastPrice > entryPrice) || (positionSize < 0 && lastPrice < entryPrice)) {
    // Use loss distance as next step
    let closeOrder = tradeExchange.findOrders(/New/,[{
      side: (positionSize < 0 ? 'Buy' : 'Sell'),
      ordType: 'Stop',
      execInst: 'LastPrice,Close',
      stopPx: 'any'
    }])[0]
    if (!closeOrder) {
      return
    }
    let nextTarget = closeOrder.stopPx - lossDistance*2
    if (lastPrice >= nextTarget) {
      let existingEntryOrders = tradeExchange.findOrders(/New/,[{
        side: (positionSize > 0 ? 'Buy' : 'Sell'),
        ordType: 'Limit',
        execInst: 'ParticipateDoNotInitiate',
        price: 'any'
      }])
      if (existingEntryOrders.length > 0) {
        tradeExchange.cancelOrders(existingEntryOrders)
      }
      let newStopLoss = closeOrder.stopPx - lossDistance
      closeOrder.stopPx = newStopLoss
      return await tradeExchange.order([closeOrder])
    }
    // Use lowest low as a new stop loss
    // let market = await tradeExchange.getCurrentMarket()
    // let newStopLoss = Math.min(...market.lows)
    // if (newStopLoss > closeOrders[0].stopPx) {
    //   closeOrders[0].stopPx = newStopLoss
    //   return await tradeExchange.order(closeOrders)
    // }
  }
  */
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPosition() {
  for (let i = 0; i < tradeExchanges.length; i++) {
    const tradeExchange = tradeExchanges[i]
    const {walletBalance,lastPositionSize,positionSize,caller,name} = tradeExchange.position
    switch(caller) {
      case 'position': {
        if (lastPositionSize == 0) {
          if (!mock) logger.info('ENTER POSITION', walletBalance)
        }
        else if (positionSize == 0) {
          if (!mock) {
            logger.info('EXIT POSITION', walletBalance)
            resetEntrySignal(name)
          }
        }
      } break;
    }
    await tradeExchange.updatePosition()
    await checkEntry(tradeExchange)
    await checkExit(tradeExchange)
  }
}

function resetEntrySignal(exchange) {
  var now = getTimeNow()
  base.resetEntrySignal(exchange)
}

function getEntrySignal(exchangeName) {
  return base.getEntrySignal(exchangeName)
}

function getEntryExitOrders(signal) {
  return base.getEntryExitOrders(signal)
}

async function init(tx) {
  var now = getTimeNow()
  tradeExchanges = tx
  base.init(tradeExchanges)
  if (mock) {
    mock.setGetSignalFn(getSMASignal)
    getSMASignal = mock.getSignal
  }
}

module.exports = {
  init: init,
  checkPosition: checkPosition,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  getEntryExitOrders: getEntryExitOrders,
}

