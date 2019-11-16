const fs = require('fs')
const fsR = require('fs-reverse')
const { Writable } = require('stream');
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const winston = require('winston')
const path = require('path')

const shoes = require('./shoes')
global.logDir = path.resolve(__dirname, 'log/'+shoes.symbol)

var mock
if (shoes.mock) mock = require('./mock.js')

const bitmex = require('./bitmex')
const strategy = require('./strategy/' + shoes.strategy + '_strategy')
const server = require('./server')
const candlestick = require('./candlestick')
const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000

global.bitmex = bitmex

const entrySignalTableFilePath = global.logDir + '/entry_signal_table.log'

const colorizer = winston.format.colorize()

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date(getTimeNow()).toISOString()
  return info;
})

function getTimeNow() {
  return new Date().getTime()
}

var lastCheckPositionTime = getTimeNow()

function conditionColor(condition) {
  return (condition == 'LONG' ? '\x1b[36m' : condition == 'SHORT' ? '\x1b[35m' : '') + condition + '\x1b[39m'
}

const logger = winston.createLogger({
  format: winston.format.label({label:'index'}),
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
            case 'checkPosition': {
              let {caller,walletBalance,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal
              let lossDistancePercentString, positionSizeString, lastPriceString
              walletBalance /= 100000000
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
              line += caller + ' B:'+walletBalance.toFixed(4)+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' T:'+takeProfit.toFixed(1)+
                ' D:'+lossDistancePercentString+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
            } break
            case 'enterSignal': {
              let {signal,orderSignal} = splat[0]
              if (signal) {
                if (signal.rsis) {
                  let {condition,prsi=NaN,rsi=NaN} = signal
                  line += conditionColor(condition)+' '+prsi.toFixed(1)+' '+rsi.toFixed(1)
                }
              }
              if (orderSignal) {
                let {type,entryPrice=NaN,orderQtyUSD,lossDistance=NaN,riskAmountUSD=NaN} = orderSignal
                line += ' '+conditionColor(type)+' '+entryPrice.toFixed(1)+' '+orderQtyUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)
              }
            } break
            case 'ENTER SIGNAL': 
            case 'ENTER ORDER': {
              let {orderQtyUSD,entryPrice} = splat[0]
              line =  (orderQtyUSD>0?'\x1b[36m':'\x1b[35m')+line+'\x1b[39m'+orderQtyUSD+' '+entryPrice
            } break
            // case 'EXIT ORDER': {
            //   let {side,price} = splat[0].exitOrders[0]
            //   line = (side>0?'\x1b[36m':'\x1b[35m')+line+'\x1b[39m'+size+' '+price
            // } break
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

const entrySignalTable = winston.createLogger({
  transports: [
    new winston.transports.File({filename:entrySignalTableFilePath,
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    })
  ]
})

logger.info('shoes', shoes)

async function checkPositionCallback(params) { try {
  params.signal = strategy.getEntrySignal()
  return await checkPosition(params)
} catch(e) {logger.error(e.stack||e);debugger} }

var checking = false, recheckWhenDone = false

async function checkPosition(params) { try {
  const {walletBalance,lastPositionSize,positionSize,caller} = params
  if (!mock) logger.info('checkPosition',params)
  switch(caller) {
    case 'position': {
      if (lastPositionSize == 0) {
        if (!mock) logger.info('ENTER POSITION', walletBalance)
        // console.log(new Date(getTimeNow()).toISOString(),'ENTER POSITION', walletBalance)
      }
      else if (positionSize == 0) {
        if (!mock) logger.info('EXIT POSITION', walletBalance)
        // console.log(new Date(getTimeNow()).toISOString(),'EXIT POSITION', walletBalance)
        strategy.resetEntrySignal()
      }
    } break;
  }
  if (checking) {
    recheckWhenDone = true
    return
  }
  checking = true
  lastCheckPositionTime = getTimeNow()

  await strategy.checkPosition(params)

  if (recheckWhenDone) {
    setTimeout(next,50)
    recheckWhenDone = false
  }
  checking = false
} catch(e) {logger.error(e.stack||e);debugger} }

async function next() { try {
  var now = getTimeNow()
  if (now-lastCheckPositionTime > 2500) {
    bitmex.getCurrentMarket() // to start a new candle if necessary
    bitmex.checkPositionParams.caller = 'interval'
    bitmex.checkPositionParams.signal = strategy.getEntrySignal()
    checkPosition(bitmex.checkPositionParams)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarketJson(sp) { try {
  var market = await bitmex.getMarket(sp)
  if (sp.candlestick) {
    candlestick.fillPatterns(market)
  }
  return JSON.stringify(market)
} catch(e) {logger.error(e.stack||e);debugger} }

async function getTradeSignals({startTime,endTime}) { try {
  return new Promise((resolve,reject) => {
    var startTimeMs = new Date(startTime).getTime()
    var endTimeMs = new Date(endTime).getTime()
    var signals = []
    var stream = fsR(entrySignalTableFilePath, {})
    const outStream = new Writable({
      write(chunk, encoding, callback) {
        let str = chunk.toString()
        if (str && str.length > 0) {
          let signal = JSON.parse(str)
          let signalTime = new Date(signal.timestamp).getTime()
          if (signalTime >= startTimeMs && signalTime <= endTimeMs) {
            var {entryOrders,closeOrders,takeProfitOrders} = strategy.getEntryExitOrders(signal)
            signal.entryOrders = entryOrders
            signal.closeOrders = closeOrders
            signal.takeProfitOrders = takeProfitOrders
            signals.unshift(signal)
          }
          else {
            stream.destroy()
            resolve(signals)
          }
        }
        callback()
      }
    })
    stream.pipe(outStream)
    stream.on('finish', () => {
      resolve(signals)
    })
    stream.on('end', () => {
      resolve(signals)
    })
  })
} catch(e) {logger.error(e.stack||e);debugger} }

var gettingTradeJson = false

async function getTradeJson(sp) { try {
  console.time('getTradeJson')
  var cachePath = getSignalPath(sp)

  if (mock) {
    // if (fs.existsSync(cachePath)) {
    //   console.timeEnd('getTradeJson')
    //   return fs.readFileSync(cachePath,readFileOptions)
    // }
    if (gettingTradeJson) {
      return ''
    }
    gettingTradeJson = true
    setup.rsi = sp.rsi
    await mock.init(sp)
    strategy.resetEntrySignal()
    await bitmex.init(sp,checkPositionCallback)
    await mock.start()
    gettingTradeJson = false
  }

  var [orders,signals] = await Promise.all([
    bitmex.getOrders(sp),
    getTradeSignals(sp)
  ])
  orders = orders.filter(o => {
    return o.stopPx != 1
  })
  var trades = []
  var timeOffset = 1000 // bitmex time and server time are not the same
  signals.forEach((signal,i) => {
    let {timestamp} = signal
    let startTime = new Date(timestamp).getTime() - timeOffset
    let endTime = (signals[i+1] ? new Date(signals[i+1].timestamp) : new Date()).getTime() - timeOffset
    signal.ords = orders.filter(({timestamp}) => {
      let t = new Date(timestamp).getTime()
      return (t >= startTime && t < endTime)
    })
  })
  signals.forEach(({ords,timestamp,capitalBTC,type,orderQtyUSD,entryPrice,stopLoss,stopMarket,takeProfit,takeHalfProfit,entryOrders,closeOrders,takeProfitOrders},i) => {
    let trade = {
      timestamp, capitalBTC, type, orderQtyUSD, entryPrice, stopLoss, stopMarket, takeProfit, takeHalfProfit,
      entryOrders: bitmex.findOrders(/.+/,entryOrders,ords),
      closeOrders: bitmex.findOrders(/.+/,closeOrders,ords),
      takeProfitOrders: bitmex.findOrders(/.+/,takeProfitOrders,ords),
    }
    let foundOrders = trade.entryOrders.concat(trade.closeOrders).concat(trade.takeProfitOrders)
    trade.otherOrders = ords.filter((e) => {
      return foundOrders.indexOf(e) < 0
    })
    trades.push(trade)
  })
  
  let walletHistory = await bitmex.getWalletHistory()
  let tradeJSON = JSON.stringify({trades:trades,orders:orders,walletHistory:walletHistory})
  fs.writeFileSync(cachePath,tradeJSON,writeFileOptions)

  console.timeEnd('getTradeJson')
  return tradeJSON
} catch(e) {logger.error(e.stack||e);debugger} }

async function getFundingCsv() { try {
  var csv = 'Date,Rate\n'
  var fundings = await bitmex.getFundingHistory()
  fundings.push(bitmex.getNextFunding())
  fundings.forEach(funding => {
    csv += funding.timestamp+','+funding.fundingRate+'\n'
  })
  return csv
} catch(e) {logger.error(e.stack||e);debugger} }

function createInterval(candleDelay) {
  var now = getTimeNow()
  var interval = oneCandleMS
  var startsIn = ((interval*2)-now%(interval) + candleDelay) % interval
  var startsInSec = startsIn % 60000
  var startsInMin = (startsIn - startsInSec) / 60000
  console.log('createInterval every ' + oneCandleMS + ' delay ' + candleDelay + ' starts in ' + startsInMin + ':' + Math.floor(startsInSec/1000) + ' minutes')
  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startsIn)
}

function getSignalPath({symbol,interval,startTime,endTime,rsi}) {
  var {length,shortPrsi,shortRsi,longPrsi,longRsi} = rsi
  return path.resolve(__dirname, 'data/bitmex/signal/'+symbol+'/'+interval+'-'+startTime+'-'+endTime+
    length+shortPrsi+shortRsi+longPrsi+longRsi+'.json').replace(/:/g,';')
}

async function init() { try {
  if (mock) {
    getTimeNow = mock.getTimeNow
    next = mock.next
    createInterval = mock.createInterval
  }

  await strategy.init(logger,entrySignalTable)
  await server.init(getMarketJson,getTradeJson,getFundingCsv)

  if (mock) {
    var s = {
      symbol: 'XBTUSD',
      interval: 5,
      startTime: '2019-05-02T00:00:00.000Z',
      endTime: '2019-05-17T00:00:00.000Z',
      rsi: {
        length: 4,
        shortPrsi: 65,
        shortRsi: 55,  
        longRsi: 55,
        longPrsi: 50
      },
    }
    var tradeJSON = await getTradeJson(s)
    var t = JSON.parse(tradeJSON)
    debugger
    // for (var sprsi = 55; sprsi <= 75; sprsi+=5) {
    //   for (var srsi = 50; srsi <= 70; srsi+=5) {
    //     for (var lrsi = 30; lrsi <= 55; lrsi+=5) {
    //       for (var lprsi = 25; lprsi <= 50; lprsi+=5) {
    //         if (sprsi >= srsi && lrsi >= lprsi) {
    //           s.rsi.shortPrsi = sprsi
    //           s.rsi.shortRsi = srsi
    //           s.rsi.longRsi = lrsi
    //           s.rsi.longPrsi = lprsi
    //           let tradeJSON = await getTradeJson(s)
    //           let t = JSON.parse(tradeJSON)
    //           let startBalance = t.walletHistory[0][1]
    //           let endBalance = t.walletHistory[t.walletHistory.length-1][1]
    //           let gain = endBalance-startBalance
    //           console.log(sprsi,srsi,lrsi,lprsi,startBalance,endBalance,gain)
    //           if (gain > 0) debugger
    //         }
    //       }
    //     }
    //   }
    // }
  }
  else {
    await bitmex.init(setup,checkPositionCallback)
    next()
    createInterval(6000*2**0)
    createInterval(6000*2**1)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

init()

// var lineReader = require('readline').createInterface({
//   input: require('fs').createReadStream('combined.log')
// })

// lineReader.on('line', (line) => {
//   var json = JSON.parse(line)
//   var {timestamp,url,signal} = json
//   if (signal && timestamp.indexOf('09T11:16:') > 0) {
//     console.log(json)
//     console.log(json.message)
//     debugger
//   }
// })
