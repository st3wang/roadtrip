const path = require('path')

const base = require('./base_strategy.js')

const bitmex = require('../exchange/bitmex')
const coinbase = require('../exchange/coinbase')
const bitstamp = require('../exchange/bitstamp')
const binance = require('../exchange/binance')

const shoes = require('../shoes')
const winston = require('winston')
const storage = require('../storage')
const candlestick = require('../candlestick')

const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global
var exitCandleTime

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

async function getAccumulationSignal(market,{rsi}) { try {
  var last = market.closes.length-1
  var open = market.opens[last]
  var close = market.closes[last]
  var signal = {
    condition: '-',
    stopLoss: close
  }
  // var timeNow = getTimeNow()
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
  signal.stopLoss = Math.min(...market.lows)
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

  return signal
} catch(e) {console.error(e.stack||e);debugger} }

async function getOrder(setup,signal) {
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

  if (!goodStopDistance) {
    order.type = '-'
    order.reason = 'not good stop distance. ' + JSON.stringify({
      absLossDistancePercent: absLossDistancePercent,
      minStopLoss: minStopLoss,
      maxStopLoss: maxStopLoss
    })
  }

  return order
}

async function getSignal(setup,params) {
  console.log('===== getSignal =====', new Date(getTimeNow()).toISOString())
  console.log('bitmexSignal')
  const bitmexSignal = await getExchangeSignal(bitmex,setup,params)
  // return bitmexSignal
  if (bitmexSignal.entryPrice) {
    // console.log('bitmexSignal')
    return bitmexSignal
  }

  console.log('coinbaseSignal')
  const coinbaseSignal = await getExchangeSignal(coinbase,setup,params,bitmexSignal.stopLoss)
  if (coinbaseSignal.entryPrice) {
    // console.log('coinbaseSignal')
    return coinbaseSignal
  }

  console.log('bitstampSignal')
  const bitstampSignal = await getExchangeSignal(bitstamp,setup,params,bitmexSignal.stopLoss)
  if (bitstampSignal.entryPrice) {
    // console.log('bitstampSignal')
    return bitstampSignal
  }

  console.log('binanceSignal')
  const binanceSignal = await getExchangeSignal(binance,setup,params,bitmexSignal.stopLoss)
  if (binanceSignal.entryPrice) {
    console.log('binanceSignal')
    return binanceSignal
  }

  return bitmexSignal
} 

async function getExchangeSignal(exchange, setup, {positionSize,fundingTimestamp,fundingRate,marginBalance}, overrideStopLoss) { try {
  var market = await exchange.getCurrentMarket()
  if (!market || !market.candles || market.candles.length != setup.candle.length) {
    console.log('invalid market', (market && market.candles) ? market.candles.length : market)
    return {}
  }
  else {
    console.log('got market', market.candles.length)
  }
  var currentCandle = await bitmex.getCurrentCandle()
  var timestamp = new Date(getTimeNow()).toISOString()
  var signal = await getAccumulationSignal(market,setup)
  signal.timestamp = timestamp
  if (overrideStopLoss) {
    signal.stopLoss = overrideStopLoss
  }

  var quote = bitmex.getQuote()
  var close = market.closes[market.closes.length - 1]

  switch(signal.condition) {
    case '-':
      return signal
    case 'LONG':
      signal.entryPrice = Math.min(close,quote.bidPrice)
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
      signal.entryPrice = Math.max(close,quote.askPrice)
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

  var XBTUSDRate = bitmex.getRate('XBTUSD')
  signal.coinPairRate = quote.lastPrice/XBTUSDRate
  signal.marginBalance = marginBalance / signal.coinPairRate
  signal.lossDistance = base.roundPrice(signal.stopLoss - signal.entryPrice)
  if (!signal.lossDistance || !signal.marginBalance) {
    return signal
  }

  var orderSignal = await getOrder(setup,signal)
  return orderSignal
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

async function orderEntry(entrySignal) { try {
  var {entryOrders,closeOrders,takeProfitOrders} = getEntryExitOrders(entrySignal.signal)
  var now = getTimeNow()
  var existingEntryOrders = bitmex.findOrders(/New|Fill/,entryOrders).filter(o => {
    return (now < new Date(o.timestamp).getTime() + oneCandleMS)
    // return (new Date(o.timestamp).getTime() >= entrySignal.time)
  })
  if (existingEntryOrders.length > 0) {
    if (!mock) logger.info('SAME ENTRY ORDER EXISTS')
  }
  else {
    if (!mock) logger.info('ENTER ORDER',entrySignal)
    closeOrders = closeOrders.slice(0,1)
    let response = await bitmex.order(entryOrders.concat(closeOrders),true)
    /*TODO: wait for order confirmations*/
    if (response.status == 200) {
      entrySignal.entryOrders = entryOrders
      entrySignal.closeOrders = closeOrders
      entrySignal.takeProfitOrders = takeProfitOrders
      base.setEntrySignal(entrySignal)
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

async function checkEntry(params) { try {
  var existingSignal = params.signal.signal
  if (existingSignal) {
    let existingSignalTime = new Date(existingSignal.timestamp).getTime()
    let now = getTimeNow()
    let ts = new Date(now).toISOString()
    let st = existingSignalTime - existingSignalTime % oneCandleMS
    let et = st + oneCandleMS - 1

    if (now >= st && now <= et) {
      // there is an existing signal
      let entryOrders = bitmex.findOrders(/New|Fill/,params.signal.entryOrders)
      if (entryOrders.length > 0) {
        if (!mock) logger.info('EXISTING SIGNAL ENTRY ORDER EXISTS')
        return
      }
    }
  }

  var signal = await getSignal(setup,params)

  if (!mock) logger.info('ENTER SIGNAL',signal)

  if (!isBear() && (signal.type == 'SHORT' || signal.type == 'LONG') && signal.entryPrice && signal.orderQtyUSD) {
    var entrySignal = {signal:signal}
    await orderEntry(entrySignal)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkExit(params) { try {
  var {positionSize,bid,ask,lastPrice,signal} = params
  if (positionSize == 0 || !lastPrice || !signal || !signal.signal) return

  var {signal:{entryPrice,stopLoss,lossDistance},entryOrders,takeProfitOrders,closeOrders} = signal

  var exit = base.exitTooLong(params) || base.exitFunding(params) || isBear()
  if (exit) {
    let exitOrders = [{
      price: (positionSize < 0 ? bid : ask),
      side: (positionSize < 0 ? 'Buy' : 'Sell'),
      ordType: 'Limit',
      execInst: 'Close,ParticipateDoNotInitiate'
    }]
    exit.exitOrders = exitOrders

    let existingExitOrders = bitmex.findOrders(/New/,exitOrders)
    if (existingExitOrders.length == 1) {
      // logger.debug('EXIT EXISTING ORDER',exit)
      return existingExitOrders
    }

    if (!mock) logger.info('CLOSE ORDER', exit)
    let response = await bitmex.order(exitOrders,true)
    return response
  }
  /*
  // move stop loss. it reduced draw down in the side way market. see Test 4
  else if ((positionSize > 0 && lastPrice > entryPrice) || (positionSize < 0 && lastPrice < entryPrice)) {
    // Use loss distance as next step
    let closeOrder = bitmex.findOrders(/New/,[{
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
      let existingEntryOrders = bitmex.findOrders(/New/,[{
        side: (positionSize > 0 ? 'Buy' : 'Sell'),
        ordType: 'Limit',
        execInst: 'ParticipateDoNotInitiate',
        price: 'any'
      }])
      if (existingEntryOrders.length > 0) {
        bitmex.cancelOrders(existingEntryOrders)
      }
      let newStopLoss = closeOrder.stopPx - lossDistance
      closeOrder.stopPx = newStopLoss
      return await bitmex.order([closeOrder])
    }
    // Use lowest low as a new stop loss
    // let market = await bitmex.getCurrentMarket()
    // let newStopLoss = Math.min(...market.lows)
    // if (newStopLoss > closeOrders[0].stopPx) {
    //   closeOrders[0].stopPx = newStopLoss
    //   return await bitmex.order(closeOrders)
    // }
  }
  */
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkPosition(params) {
  await checkEntry(params)
  if (params.positionSize != 0) {
    params.signal = base.getEntrySignal()
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

function getEntryExitOrders(signal) {
  return base.getEntryExitOrders(signal)
}

async function init() {
  var now = getTimeNow()
  exitCandleTime = now - (now % oneCandleMS)
  base.init()
}

function getCacheTradePath(dirname,{symbol,startTime,endTime,candle:{interval},rsi:{rsiLength}}) {
  return path.resolve(dirname, 'data/bitmex/signal/'+symbol+'/'+interval+'-'+startTime+'-'+endTime+
    rsiLength+'.json').replace(/:/g,';')
}

module.exports = {
  init: init,
  checkPosition: checkPosition,
  resetEntrySignal: resetEntrySignal,
  getEntrySignal: getEntrySignal,
  getEntryExitOrders: getEntryExitOrders,
  getCacheTradePath: getCacheTradePath
}

