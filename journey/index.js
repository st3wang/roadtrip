const fs = require('fs')
const fsR = require('fs-reverse')
const { Writable } = require('stream');
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const bitmexdata = require('./bitmexdata')

const winston = require('winston')
const path = require('path')

const shoes = require('./shoes')
global.logDir = path.resolve(__dirname, 'log/'+shoes.symbol)

const colorizer = winston.format.colorize()
global.colorizer = colorizer
const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date(getTimeNow()).toISOString()
  return info;
})
global.isoTimestamp = isoTimestamp

var mock, getTimeNow
if (shoes.setup.startTime) {
  mock = require('./mock.js')
  global.getTimeNow = mock.getTimeNow
}
else {
  global.getTimeNow = () => {
    return new Date().getTime()
  }
}

const storage = require('./storage')
global.storage = storage

const bitmex = require('./bitmex')
const strategy = require('./strategy/' + shoes.strategy + '_strategy')
const server = require('./server')
const candlestick = require('./candlestick')
const setup = shoes.setup
const oneCandleMS = setup.candle.interval*60000

global.bitmex = bitmex
global.strategy = strategy

var lastCheckPositionTime

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
            case 'position': {
              let {caller,walletBalance,marginBalance,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal.signal || {}
              let marginBalanceString,pnlPercent,pnlPercentString,lossDistancePercentString, positionSizeString, lastPriceString
              pnlPercent = Math.round((marginBalance-walletBalance) / walletBalance * 10000) / 100
              walletBalance /= 100000000
              marginBalance /= 100000000
              marginBalanceString = (marginBalance > walletBalance ? '\x1b[32m' : (marginBalance < walletBalance ? '\x1b[31m' : '')) + marginBalance.toFixed(4) + '\x1b[39m'
              pnlPercentString = (marginBalance > walletBalance ? '\x1b[32m' : (marginBalance < walletBalance ? '\x1b[31m' : '')) + pnlPercent + '%\x1b[39m'
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
              line += caller + ' B:'+walletBalance.toFixed(4)+' M:'+marginBalanceString+' '+pnlPercentString+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' T:'+takeProfit.toFixed(1)+
                ' D:'+lossDistancePercentString+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
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

global.logger = logger

async function checkPositionCallback(params) { try {
  if (mock) {
    var timestamp = new Date(getTimeNow()).toISOString()
    // if (timestamp.includes('06.000Z')) {
      params.signal = strategy.getEntrySignal()
      return await checkPosition(params)
    // }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

var checking = false, recheckWhenDone = false

async function checkPosition(params) { try {
  const {walletBalance,lastPositionSize,positionSize,caller} = params
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

async function next(logOnly) { try {
  var now = getTimeNow()
  // if (now-lastCheckPositionTime > 2500) {
    bitmex.getCurrentMarket() // to start a new candle if necessary
    bitmex.checkPositionParams.caller = 'interval'
    bitmex.checkPositionParams.signal = strategy.getEntrySignal()
    if (!mock) logger.info('position',bitmex.checkPositionParams)
    if (!logOnly) checkPosition(bitmex.checkPositionParams)
  // }
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarketJson(sp) { try {
  var market = await bitmex.getMarket(sp)
  if (sp.candlestick) {
    candlestick.fillPatterns(market)
  }
  return JSON.stringify(market)
} catch(e) {logger.error(e.stack||e);debugger} }

var gettingTradeJson = false

async function getTradeJson(sp,useCache) { try {
  console.time('getTradeJson')
  var cachePath = strategy.getCacheTradePath(__dirname,sp)

  if (mock) {
    if (useCache && fs.existsSync(cachePath)) {
      console.timeEnd('getTradeJson')
      return fs.readFileSync(cachePath,readFileOptions)
    }
    if (gettingTradeJson) {
      return ''
    }
    gettingTradeJson = true
    await mock.init(sp)
    strategy.resetEntrySignal()
    await bitmex.init(sp,checkPositionCallback)
    await mock.start()
    gettingTradeJson = false
  }

  var [orders,signals] = await Promise.all([
    bitmex.getOrders(sp),
    storage.readEntrySignalTable(sp)
  ])
  orders = orders.filter(o => {
    return o.stopPx != 1
  })
  var firstEnterPrice = signals[0].signal.entryPrice
  var walletHistory = await bitmex.getWalletHistory()
  var trades = [], ords = []
  var timeOffset = 1000 // bitmex time and server time are not the same
  var walletBalance = walletHistory[0][1]
  var walletBalanceUSD = walletBalance*firstEnterPrice/100000000
  var groupid = 0
  let totalHoursInTrade = 0
  signals.forEach((signal,i) => {
    let {timestamp} = signal
    let startTime = new Date(timestamp).getTime() - timeOffset
    let endTime = (signals[i+1] ? new Date(signals[i+1].timestamp) : new Date()).getTime() - timeOffset
    ords[i] = orders.filter((o) => {
      let {timestamp} = o
      let t = new Date(timestamp).getTime()
      return (t >= startTime && t < endTime)
    })
  })
  signals.forEach((s,i) => {
    let previousTrade = trades[i-1] || {drawdown:0,drawdownPercent:0,drawdownUSD:0,drawdownUSDPercent:0,wl:0,cwl:0,wins:0,losses:0,walletBalanceStart:0}
    let trade = {
      signal: s,
      entryOrders: bitmex.findOrders(/.+/,s.entryOrders,ords[i]),
      closeOrders: ords[i].filter(o => {return o.ordType == 'Stop'}),
      // takeProfitOrders: bitmex.findOrders(/.+/,s.takeProfitOrders,ords[i]),
      fee: 0, cost: 0, costPercent: '%', feePercent: '%', pnl:0, pnlPercent:'%',
      group: 0, grouppnl: 0,
      drawdown: previousTrade.drawdown, drawdownPercent: previousTrade.drawdownPercent,
      drawdownUSD: previousTrade.drawdownUSD, drawdownUSDPercent: previousTrade.drawdownUSDPercent,
      wl: 0, /* continuous win or los */ cwl: previousTrade.cwl,
      wins: previousTrade.wins, losses: previousTrade.losses, winsPercent: previousTrade.winsPercent,
      walletBalance: walletBalance, walletBalancePercent:'%',
      walletBalanceStart: previousTrade.walletBalanceStart, walletBalanceUSD: previousTrade.walletBalanceUSD,
      hoursInTrade: 0, avgHoursInTrade: 0, avgGroupHoursInTrade: 0
    }
    let foundOrders = trade.entryOrders.concat(trade.closeOrders).concat(trade.takeProfitOrders)
    trade.otherOrders = ords.filter((e) => {
      return foundOrders.indexOf(e) < 0
    })
    trades.push(trade)

    let closeOrder = trade.closeOrders[0]
    if (!closeOrder) {
      debugger
      return
    }
    closeOrder.price = closeOrder.price || 0

    let closeQty = trade.closeOrders[0].cumQty
    let closeTimestamp = trade.closeOrders[0].timestamp
    let closeTime = new Date(closeTimestamp).getTime()
    let len = trades.length
    let startIndex = len
    let startWalletBalance = walletBalance
    let totalGroupHoursInTrade = 0
    let groupLen = 1
    while (closeQty > 0) {
      startIndex--
      closeQty -= trades[startIndex].entryOrders[0].cumQty
    }
    if (closeQty < 0) {
      console.error('incorrect quantity')
      debugger
    }
    else if (startIndex < len) {
      startWalletBalance = trades[startIndex].walletBalance
      groupid++
      groupLen = len - startIndex
    }
    for (;startIndex < len; startIndex++) {
      let t = trades[startIndex]
      let pt = trades[startIndex-1] || {drawdown:0,wl:0,cwl:0,wins:0,losses:0}
      let entryOrder = t.entryOrders[0]
      if (entryOrder.ordStatus == 'Filled') {
        t.group = groupid
        let entryCost = mock.getCost(entryOrder)
        let entryTime = new Date(entryOrder.timestamp).getTime()
        let partialCloseOrder = t.closeOrders[0]
        partialCloseOrder.cumQty = entryOrder.cumQty
        partialCloseOrder.price = closeOrder.price
        let closeCost = mock.getCost(partialCloseOrder)
        let lastPrice = (partialCloseOrder.price||entryOrder.price)
        t.fee = entryCost[2] + closeCost[2]
        t.cost = Math.round((entryCost[0] + closeCost[0]) * 100000000)
        t.pnl = (t.cost - t.fee)
        t.wl = t.pnl / Math.abs(t.pnl)
        t.cwl = t.wl + (t.wl == pt.wl ? pt.cwl : 0)
        t.wins = pt.wins + (t.wl > 0 ? 1 : 0)
        t.losses = pt.losses + (t.wl < 0 ? 1 : 0)
        t.winsPercent = (Math.round(t.wins / (startIndex+1) * 10000) / 100).toFixed(2)
        let pnlUSD = t.pnl*lastPrice/100000000
        t.drawdown = pt.drawdown + t.pnl
        t.drawdownUSD = pt.drawdownUSD + pnlUSD
        if (t.drawdown > 0) {
          t.drawdown = 0
          t.drawdownUSD = 0
        }
        t.feePercent = (Math.round(-t.fee / walletBalance * 10000) / 100).toFixed(2)
        t.costPercent = (Math.round(t.cost / walletBalance * 10000) / 100).toFixed(2)
        t.pnlPercent = (Math.round(t.pnl / walletBalance * 10000) / 100).toFixed(2)
        t.drawdownPercent = (Math.round(t.drawdown / (walletBalance-t.drawdown) * 10000) / 100).toFixed(2)
        t.drawdownUSDPercent = (Math.round(t.drawdownUSD / (walletBalanceUSD-t.drawdownUSD) * 10000) / 100).toFixed(2)
        walletBalance += t.pnl
        walletBalanceUSD += pnlUSD
        t.walletBalance = walletBalance
        t.walletBalancePercent = (walletBalance / walletHistory[0][1] * 100).toFixed(2)
        t.walletBalanceStart = walletBalance*firstEnterPrice/100000000
        t.walletBalanceUSD = walletBalanceUSD
        t.hoursInTrade = (closeTime - entryTime) / 3600000
        totalHoursInTrade += t.hoursInTrade
        totalGroupHoursInTrade += t.hoursInTrade
        t.avgHoursInTrade = Math.round(totalHoursInTrade/(startIndex+1) * 10) / 10
      }
      else {
        t.drawdown = pt.drawdown
        t.drawdownUSD = pt.drawdownUSD
        t.wl = 0
        t.cwl = pt.cwl
      }
    }
    trade.grouppnl = walletBalance - startWalletBalance
    trade.avgGroupHoursInTrade = Math.round(totalGroupHoursInTrade/groupLen*10)/10
  })
  
  console.timeEnd('getTradeJson')

  let tradeObject = {trades:trades} //,orders:orders,walletHistory:walletHistory}
  await storage.writeTradesCSV(path.resolve(__dirname, 'test/test.csv'),tradeObject.trades)
  debugger
  // return tradeObject
  let tradeJSON = JSON.stringify(tradeObject)
  fs.writeFileSync(cachePath,tradeJSON,writeFileOptions)
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

async function updateData() {
  console.time('updateData')
  var start = 20200501
  var end = 20200529
  await bitmexdata.downloadTradeData(start,end)
  // await bitmexdata.testCandleDayFiles(start,end,60)
  await bitmexdata.generateCandleDayFiles(start,end,60)
  await bitmexdata.generateCandleDayFiles(start,end,1440)
  console.timeEnd('updateData')
  debugger
}

async function readLog() {
  return new Promise((resolve,reject) => {
    var lineReader = require('readline').createInterface({
      input: require('fs').createReadStream('combined.log')
    })
  
    lineReader.on('line', (line) => {
      if (line && line.length) {
        var json = JSON.parse(line)
        var {timestamp,message,condition,riskAmountBTC,price} = json
        if (
          price == 9781.5
          //timestamp.includes('2020-05-13T16'
        // && message == 'position'
          ) {
            console.log(json)
          // console.log(json.timestamp, json.condition, json.type, json.entryPrice)
        }
      }
      else {
        debugger
        resolve()
      }
    })
  })
}

async function init() { try {
  // await readLog()
  // await updateData()
  getTimeNow = global.getTimeNow
  lastCheckPositionTime = getTimeNow()
  logger.info('shoes', shoes)

  if (mock) {
    next = mock.next
    createInterval = mock.createInterval
  }

  await storage.init()
  await strategy.init()
  await server.init(getMarketJson,getTradeJson,getFundingCsv)

  if (mock) {
    var tradeJSON = await getTradeJson(setup,false)
    debugger
  }
  else {
    await bitmex.init(setup,checkPositionCallback)
    next()
    createInterval(6000*2**0) // 6s after candle close
    createInterval(6000*2**1) // 12s
  }
} catch(e) {logger.error(e.stack||e);debugger} }

init()

/* TODO
use marginBalance instead of walletBalance
move stop loss 
  - when it's winning
  - every hour lookback 36
test short
reduce size
*/