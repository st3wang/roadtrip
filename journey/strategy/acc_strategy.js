const path = require('path')

const base = require('./base_strategy.js')
const shoes = require('../shoes')
const setup = shoes.setup

const basedata = require('../exchange/basedata')
const bitmex = require('../exchange/bitmex')
const coinbase = require('../exchange/coinbase')
const bitstamp = require('../exchange/bitstamp')
const binance = require('../exchange/binance')
const bitfinex = require('../exchange/bitfinex')
const exchanges = {bitmex: bitmex, coinbase: coinbase, bitstamp: bitstamp, binance: binance, bitfinex: bitfinex}
var tradeExchanges = []
Object.keys(setup.exchange).forEach(exchangeName => {
  tradeExchanges.push(exchanges[exchangeName])
})

const winston = require('winston')
const storage = require('../storage')
const candlestick = require('../candlestick')

const oneCandleMS = setup.candle.interval*60000

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global

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
            case 'checkEntry': {
              let {exchange,caller,walletBalance,marginBalance,unrealisedPnl,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal,currentStopPx} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal.signal || {}
              let marginBalanceString,marginPnlPercent,stopBalance,stopBalanceString,stopPnlPercent,lossDistancePercentString, positionSizeString, lastPriceString
              stopLoss = currentStopPx || stopLoss
              walletBalance /= 100000000
              unrealisedPnl /= 100000000
              marginBalance /= 100000000
              marginPnlPercent = Math.round((marginBalance-walletBalance) / walletBalance * 10000) / 100
              marginBalanceString = (marginBalance > walletBalance ? '\x1b[32m' : (marginBalance < walletBalance ? '\x1b[31m' : '')) + marginBalance.toFixed(4) + ' ' + marginPnlPercent + '%\x1b[39m'
              
              let lastCost = exchanges[exchange].getCost({
                side: 'Sell',
                cumQty: -positionSize,
                price: lastPrice,
                execInst: 'Close,LastPrice'
              })
              // console.log('lastCost',lastCost)
              let stopCost = exchanges[exchange].getCost({
                side: 'Sell',
                cumQty: -positionSize,
                price: stopLoss,
                execInst: 'Close,LastPrice'
              })
              // console.log('stopCost',stopCost)
              
              stopBalance = walletBalance + unrealisedPnl + lastCost[0] - stopCost[0]
              stopPnlPercent = Math.round((stopBalance-walletBalance) / walletBalance * 10000) / 100
              stopBalanceString = (stopBalance > walletBalance ? '\x1b[32m' : (stopBalance < walletBalance ? '\x1b[31m' : '')) + stopBalance.toFixed(4) + ' ' + stopPnlPercent + '%\x1b[39m'
              
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
              line += exchange + ' ' + caller + ' B:'+walletBalance.toFixed(4)+' M:'+marginBalanceString+' S:'+stopBalanceString+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' T:'+takeProfit.toFixed(1)+
                ' D:'+lossDistancePercentString+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
            } break
            case 'ENTER SIGNAL': {
              let signal = splat[0]
              if (signal) {
                let {condition,type='',entryPrice=NaN,stopLoss=NaN,orderQtyUSD,lossDistance=NaN,riskAmountUSD=NaN,reason=''} = signal
                line += typeColor(condition)+' '+typeColor(type)+' '+entryPrice.toFixed(1)+' '+stopLoss.toFixed(1)+' '+orderQtyUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)+' '+reason
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

async function getAccumulationSignal(signalExchange,{rsi},stopLoss) { try {
  var now = getTimeNow()
  var signal = {
    timestamp: new Date(now).toISOString(),
    signalExchange: signalExchange.name,
    condition: '-',
    stopLoss: stopLoss
  }

  var market = await signalExchange.getCurrentMarket()
  if (!market || !market.candles || market.candles.length != setup.candle.length) {
    console.log(signalExchange.name, 'invalid market', (market && market.candles) ? market.candles.length : market)
    return signal
  }
  else {
    console.log(signalExchange.name, 'got market', market.candles.length)
  }

  var last = market.closes.length-1
  var open = market.opens[last]
  var close = market.closes[last]

  // var bullRun = timeNow < 1516579200000 /*Date.parse('22 Jan 2018 00:00:00 GMT')*/ ||
  //   (timeNow > 1554681600000 /*Date.parse('08 Apr 2019 00:00:00 GMT')*/ && timeNow < 1569801600000 /*Date.parse('30 Sep 2019 00:00:00 GMT')*/)
  // if (!bullRun) return signal
  
  var rsis = (market.rsis || await base.getRsi(market.closes,rsi.rsiLength))
  var [isWRsi,wrb1,wrt1,wrb2] = candlestick.findW(rsis,last,rsis,rsis[last-1],rsis[last])
  // var [isMRsi,mrt1,mrb1,mrt2] = candlestick.findM(rsis,last,rsis,rsis[last-1],rsis[last])

  var [avgBodies,bodyHighs,bodyLows] = candlestick.getBody(market)
  var [isWPrice,wbottom1,wtop1,wbottom2] = candlestick.findW(avgBodies,last,bodyHighs,open,close)
  // var [isMPrice,mtop1,mbottom1,mtop2] = candlestick.findM(avgBodies,last,bodyLows,open,close)

  // signal.stopLoss = market.lows[wbottom2]
  signal.stopLoss = signal.stopLoss || Math.min(...market.lows)
  // signal.stopLoss = Math.min(...(market.lows.slice(6,market.lows.length-1)))

  if (isWPrice == 3 && isWRsi == 3) {
    signal.condition = 'LONG'
  }
  // if (isMPrice == 3 && isMRsi == 3) {
  //   signal.condition = 'SHORT'
  //   signal.stopLoss = Math.max(...market.highs)
  // }

  // var timestamp = new Date(getTimeNow()).toISOString()
  // if (timestamp.includes('T11')) {
  //   signal.condition = 'LONG'
  //   signal.stopLoss = base.roundPrice(close*0.98) //candlestick.lowestBody(market,24)
  // }
  
  await basedata.writeSignal(signalExchange.name,signalExchange.symbols[setup.symbol],setup.candle.interval,now,signal)

  return signal
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrder(tradeExchange,setup,position,signal) {
  if (signal.condition == '-') {
    return signal
  }

  var quote = tradeExchange.getQuote()
  var lastCandle = tradeExchange.getLastCandle()
  var currentCandle = tradeExchange.getCurrentCandle()

  switch(signal.condition) {
    case 'LONG':
      signal.entryPrice = Math.min(lastCandle.close,quote.bidPrice)
      if (signal.entryPrice <= signal.stopLoss) {
        signal.reason = 'entryPrice <= stopLoss ' + JSON.stringify(quote)
        return signal
      }
      else if (currentCandle.low <= signal.stopLoss) {
        signal.reason = 'currentCandle.low <= stopLoss ' + JSON.stringify(currentCandle)
        return signal
      }
      // else if (base.isFundingWindow(fundingTimestamp) && fundingRate > 0) {
      //   signal.reason = 'Will have to pay funding.'
      //   return signal
      // }
      break
    case 'SHORT':
      signal.entryPrice = Math.max(lastCandle.close,quote.askPrice)
      if (signal.entryPrice >= signal.stopLoss) {
        signal.reason = 'entryPrice >= stopLoss ' + JSON.stringify(quote)
        return signal
      }
      else if (currentCandle.high >= signal.stopLoss) {
        signal.reason = 'currentCandle.high >= stopLoss ' + JSON.stringify(currentCandle)
        return signal
      }
      // else if (base.isFundingWindow(fundingTimestamp) && fundingRate < 0) {
      //   signal.reason = 'Will have to pay funding.'
      //   return signal
      // }
      break
  }

  var XBTUSDRate = tradeExchange.getRate('XBTUSD')
  signal.coinPairRate = quote.lastPrice/XBTUSDRate
  signal.marginBalance = position.marginBalance / signal.coinPairRate
  signal.lossDistance = base.roundPrice(signal.stopLoss - signal.entryPrice)

  if (!signal.lossDistance || !signal.marginBalance) {
    return signal
  }

  var {marginBalance,entryPrice,lossDistance,coinPairRate} = signal
  var tick = setup.candle.tick
  var leverageMargin = marginBalance*0.000000008
  var profitDistance, takeProfit, stopMarketDistance, 
    stopLossTrigger, takeProfitTrigger,lossDistancePercent,
    riskAmountUSD, riskAmountBTC, orderQtyUSD, qtyBTC, leverage

  var {outsideCapitalBTC=0,outsideCapitalUSD=0,riskPerTradePercent,profitPercent,profitFactor,
    stopMarketFactor,scaleInFactor,scaleInLength,minOrderSizeBTC,minStopLoss,maxStopLoss} = setup.bankroll
  var side = -lossDistance/Math.abs(lossDistance) // 1 or -1

  minOrderSizeBTC /= coinPairRate
  stopMarketDistance = base.roundPrice(lossDistance * stopMarketFactor)
  profitDistance = base.roundPrice(-lossDistance * profitFactor)

  stopMarket = base.roundPrice(entryPrice + stopMarketDistance)
  takeProfit = base.roundPrice(entryPrice + profitDistance)

  stopLossTrigger = entryPrice + (lossDistance/2)
  takeProfitTrigger = entryPrice + (profitDistance/8)
  stopMarketTrigger = entryPrice + (stopMarketDistance/4)
  lossDistancePercent = lossDistance/entryPrice

  var capitalBTC = (outsideCapitalUSD/entryPrice) + outsideCapitalBTC + marginBalance/100000000
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
  // var goodStopDistance = absLossDistancePercent >= minStopLoss && absLossDistancePercent <= maxStopLoss

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

async function getSignal(setup,position) {
  console.log('===== getSignal =====', new Date(getTimeNow()).toISOString())
  const bitmexSignal = await getAccumulationSignal(bitmex,setup)
  if (bitmexSignal.condition != '-') {
    return bitmexSignal
  }

  const coinbaseSignal = await getAccumulationSignal(coinbase,setup,bitmexSignal.stopLoss)
  if (coinbaseSignal.condition != '-') {
    return coinbaseSignal
  }

  const bitstampSignal = await getAccumulationSignal(bitstamp,setup,bitmexSignal.stopLoss)
  if (bitstampSignal.condition != '-') {
    return bitstampSignal
  }

  const binanceSignal = await getAccumulationSignal(binance,setup,bitmexSignal.stopLoss)
  if (binanceSignal.condition != '-') {
    return binanceSignal
  }

  const bitfinexSignal = await getAccumulationSignal(bitfinex,setup,bitmexSignal.stopLoss)
  if (bitfinexSignal.condition != '-') {
    return bitfinexSignal
  }

  return bitmexSignal
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
    let response = await tradeExchange.order(entryOrders.concat(closeOrders),true)
    /*TODO: wait for order confirmations*/
    if (response.status == 200) {
      entrySignal.entryOrders = entryOrders
      entrySignal.closeOrders = closeOrders
      entrySignal.takeProfitOrders = takeProfitOrders
      base.setEntrySignal(tradeExchange.name,entrySignal)
      storage.writeEntrySignalTable(entrySignal)
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

function isBear() {
  return false
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
  const existingSignal = getEntrySignal(tradeExchange.name).signal
  const position = tradeExchange.position

  position.signal = existingSignal // for logging try to remove it
  if (!mock) logger.info('checkEntry',position)

  if (existingSignal) {
    let existingSignalTime = new Date(existingSignal.timestamp).getTime()
    let now = getTimeNow()
    let ts = new Date(now).toISOString()
    let st = existingSignalTime - existingSignalTime % oneCandleMS
    let et = st + oneCandleMS - 1

    if (now >= st && now <= et) {
      // there is an existing signal
      let entryOrders = tradeExchange.findOrders(/New|Fill/,position.signal.entryOrders)
      if (entryOrders.length > 0) {
        if (!mock) logger.info('EXISTING SIGNAL ENTRY ORDER EXISTS')
        return
      }
    }
  }
  var signal = await getOrder(tradeExchange,setup,position,await getSignal(setup,position))

  if (!mock) logger.info('ENTER SIGNAL',signal)

  if (!isBear() && signal.orderQtyUSD) {
    if (!(signal.type == 'SHORT' || signal.type == 'LONG')) debugger
    var entrySignal = {signal:signal}
    await orderEntry(tradeExchange,entrySignal)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(tradeExchange,position) { try {
  position.signal = getEntrySignal(tradeExchange.name)
  var {positionSize,bid,ask,lastPrice,signal} = position
  if (positionSize == 0 || !lastPrice || !signal || !signal.signal) return

  var {signal:{entryPrice,stopLoss,lossDistance},entryOrders,takeProfitOrders,closeOrders} = signal

  var exit = base.exitTooLong(position) || base.exitFunding(position) || isBear()
  if (exit) {
    let exitOrders = [{
      price: (positionSize < 0 ? bid : ask),
      side: (positionSize < 0 ? 'Buy' : 'Sell'),
      ordType: 'Limit',
      execInst: 'Close,ParticipateDoNotInitiate'
    }]
    exit.exitOrders = exitOrders

    let existingExitOrders = tradeExchange.findOrders(/New/,exitOrders)
    if (existingExitOrders.length == 1) {
      // logger.debug('EXIT EXISTING ORDER',exit)
      return existingExitOrders
    }

    if (!mock) logger.info('CLOSE ORDER', exit)
    let response = await tradeExchange.order(exitOrders,true)
    return response
  }
  /*
  // move stop loss. it reduced draw down in the side way market. see Test 4
  else if ((positionSize > 0 && lastPrice > entryPrice) || (positionSize < 0 && lastPrice < entryPrice)) {
    // Use loss distance as next step
    let closeOrder = tradeExchange.findOrders(/New/,[{
      side: (positionSize < 0 ? 'Buy' : 'Sell'),
      ordType: 'Stop',
      execInst: 'Close,LastPrice',
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
    const exchange = tradeExchanges[i]
    const {walletBalance,lastPositionSize,positionSize,caller,name} = exchange.position
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
    await checkEntry(exchange)
  }
  // if (position.positionSize != 0) {
    // await checkExit(bitex,position)
  // }
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

async function init() {
  var now = getTimeNow()
  base.init(tradeExchanges)
  if (mock) {
    mock.setGetAccumulationSignalFn(getAccumulationSignal)
    getAccumulationSignal = mock.getAccumulationSignal
  }
}

module.exports = {
  init: init,
  checkPosition: checkPosition,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  getEntryExitOrders: getEntryExitOrders,
}

