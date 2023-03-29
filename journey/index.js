const fs = require('fs')
const fsR = require('fs-reverse')
const { Writable } = require('stream');
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const bitmexdata = require('./exchange/bitmexdata')
const coinbasedata = require('./exchange/coinbasedata')
const bitstampdata = require('./exchange/bitstampdata')
const binancedata = require('./exchange/binancedata')
const bitfinexdata = require('./exchange/bitfinexdata')
const gsheet = require('./gsheet/gsheet')

const winston = require('winston')
const path = require('path')

const shoes = require('./shoes')
const setup = shoes.setup
global.logDir = path.resolve(__dirname, 'log/'+shoes.symbol)
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
global.wait = async function wait(ms) {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

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
  getTimeNow = global.getTimeNow = mock.getTimeNow
}
else {
  getTimeNow = global.getTimeNow = () => {
    return new Date().getTime()
  }
}

const storage = require('./storage')
global.storage = storage

const bitmex = require('./exchange/bitmex')
const coinbase = require('./exchange/coinbase')
const bitstamp = require('./exchange/bitstamp')
const binance = require('./exchange/binance')
const bitfinex = require('./exchange/bitfinex')
var exchanges = {bitmex: bitmex, 
  coinbase: coinbase, 
  bitstamp: bitstamp, 
  binance: binance, 
  bitfinex: bitfinex}
if (shoes.strategy == 'abi') {
  exchanges = {coinbase: coinbase, binance: binance}
}
var tradeExchanges = []
var tradeExchangesByName = {}
Object.keys(setup.exchange).forEach(exchangeName => {
  tradeExchanges.push(exchanges[exchangeName])
  tradeExchangesByName[exchangeName] = exchanges[exchangeName]
})
const strategy = require('./strategy/' + shoes.strategy + '_strategy')
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

async function checkPositionCallback(position) { try {
  if (mock) {
    const now = getTimeNow()
    const nowString = new Date(now).toISOString()
    if (nowString.endsWith('06.000Z')) {
      return await checkPosition()
    }
  }
  else {
    // position.signal = strategy.getEntrySignal(position.exchange)
    // logger.info('position',params)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

var checking = false, recheckWhenDone = false

async function checkPosition() { try {
  if (checking) {
    recheckWhenDone = true
    return
  }
  checking = true
  lastCheckPositionTime = getTimeNow()

  await strategy.checkPosition()

  if (recheckWhenDone) {
    setTimeout(next,50)
    recheckWhenDone = false
  }
  checking = false
} catch(e) {logger.error(e.stack||e);debugger} }

async function next(logOnly) { try {
  var now = getTimeNow()
  tradeExchanges.forEach(tradeExchange => {
    tradeExchange.getCurrentMarket() // to start a new candle if necessary
    tradeExchange.position.caller = 'interval' // for logging
  })
  if (!logOnly) await checkPosition()
} catch(e) {logger.error(e.stack||e);debugger} }

var gettingTradeJson = false

async function getTradeJson(sp) { try {
  console.time('getTradeJson')

  if (mock) {
    if (gettingTradeJson) {
      return ''
    }
    gettingTradeJson = true
    await mock.init(sp)
    for (let i = 0; i < tradeExchanges.length; i++) {
      strategy.resetEntrySignal(tradeExchanges[i].name)
    }
    await initExchanges()
    await mock.start()
    gettingTradeJson = false
  }

  var [orders,signals] = await Promise.all([
    bitmex.getOrders(sp),
    storage.entrySignals
  ])
  orders = orders.filter(o => {
    return o.stopPx != 1
  })
  var firstEnterPrice = signals[0].signal.entryPrice
  var walletHistory = await bitmex.getWalletHistory()
  var trades = [], ords = []
  var walletBalance = walletHistory[0][1]
  var startDrawDownWalletBalance = walletBalance
  var startDrawDownWalletBalanceUSD = startDrawDownWalletBalance*firstEnterPrice/100000000
  var groupid = 0
  let totalHoursInTrade = 0
  let totalPnlPercent = 0
  let maxDrawDown = 0
  let maxDrawDownUSD = 0
  let cwlMin = 0, cwlMax = 0
  let totalGroups = 0, totalGroupLen = 0
  let totalWinGroups = 0, totalWinGroupLen = 0
  let totalLoseGroups = 0, totalLoseGroupLen = 0
  let contribution = 0

  signals.forEach((signal,i) => {
    let {timestamp} = signal.signal
    let startTime = new Date(timestamp).getTime()
    startTime -= startTime%oneCandleMS
    let endTime = (signals[i+1] ? new Date(signals[i+1].signal.timestamp) : new Date()).getTime()
    endTime -= endTime%oneCandleMS+1000
    ords[i] = orders.filter((o) => {
      let {timestamp} = o
      let t = new Date(timestamp).getTime()
      return (t >= startTime && t < endTime)
    })
  })
  signals.forEach((s,i) => {
    let previousTrade = trades[i-1] || {drawdown:0,drawdownPercent:0,drawdownUSD:0,drawdownUSDPercent:0,wl:0,cwl:0,wins:0,losses:0,walletBalanceUSD:0,psize:0,psizePercent:0}
    let trade = {
      signal: s,
      entryOrders: bitmex.findOrders(/.+/,s.entryOrders,ords[i]),
      closeOrders: [ords[i][ords[i].length-1]], //ords[i].filter(o => {return o.ordType == 'Stop'}),
      takeProfitOrders: bitmex.findOrders(/.+/,s.takeProfitOrders,ords[i]),
      fee: 0, cost: 0, costPercent: '%', feePercent: '%', pnl:0, pnlPercent:'%',
      group: 0, grouppnl: 0,
      drawdown: previousTrade.drawdown, drawdownPercent: previousTrade.drawdownPercent,
      drawdownUSD: previousTrade.drawdownUSD, drawdownUSDPercent: previousTrade.drawdownUSDPercent,
      wl: 0, /* continuous win or los */ cwl: previousTrade.cwl,
      wins: previousTrade.wins, losses: previousTrade.losses, winsPercent: previousTrade.winsPercent,
      walletBalance: walletBalance, walletBalancePercent:'%',
      walletBalanceUSD: previousTrade.walletBalanceUSD, 
      //walletBalanceUSD: previousTrade.walletBalanceUSD,
      hoursInTrade: 0, avgHoursInTrade: 0, avgGroupHoursInTrade: 0,
      psize: 0, psizePercent: 0,
      stopRiskPercent: s.signal.stopRiskPercent,
      stopDistanceRiskRatio: s.signal.stopDistanceRiskRatio
    }
    let foundOrders = trade.entryOrders.concat(trade.closeOrders).concat(trade.takeProfitOrders)
    trade.otherOrders = ords.filter((e) => {
      return foundOrders.indexOf(e) < 0
    })
    trades.push(trade)
    if (!trade.entryOrders[0]) debugger

    let closeOrder = trade.closeOrders[0]
    if (!closeOrder) {
      // debugger
      return
    }
    switch (closeOrder.ordStatus) {
      case 'New':
      case 'Canceled': {
        if (trade.takeProfitOrders[0] && trade.takeProfitOrders[0].ordStatus != 'Canceled') {
          closeOrder = trade.takeProfitOrders[0]
        }
      }
      break;
    }
    // if (closeOrder.ordStatus !== 'Filled') {
    //   debugger
    //   return
    // }
    closeOrder.price = closeOrder.price || 0

    let closeQty = closeOrder.cumQty
    let closeTimestamp = closeOrder.timestamp
    let closeTime = new Date(closeTimestamp).getTime()
    let len = trades.length
    let startIndex = len
    let startWalletBalance = walletBalance
    let totalGroupHoursInTrade = 0
    let groupLen = 1
    while (closeQty > 0) {
      startIndex--
      if (!trades[startIndex]) debugger
      if (!trades[startIndex].entryOrders[0]) debugger
      closeQty -= trades[startIndex].entryOrders[0].cumQty
    }
    if (closeQty < 0) {
      orders 
      signals
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
      let pt = trades[startIndex-1] || {drawdown:0,wl:0,cwl:0,wins:0,losses:0,positionSize:0}
      let signal = signals[startIndex].signal
      let entryOrder = t.entryOrders[0]
      if (entryOrder.ordStatus == 'Filled') {
        t.group = groupid
        let entryCost = mock.getCost(entryOrder)
        let entryTime = new Date(entryOrder.timestamp).getTime()
        let partialCloseOrder = t.closeOrders[t.closeOrders.length-1]
        if (t.closeOrders.length > 1) debugger
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
        t.feePercent = (Math.round(-t.fee / walletBalance * 10000) / 100).toFixed(2)
        t.costPercent = (Math.round(t.cost / walletBalance * 10000) / 100).toFixed(2)
        t.pnlPercent = (Math.round(t.pnl / walletBalance * 10000) / 100).toFixed(2)

        walletBalance += t.pnl
        // if (walletBalance < 100000000) {
        //   let newContribution = 100000000 - walletBalance
        //   contribution += newContribution
        //   walletBalance = 100000000
        //   t.contribution = contribution
        // }
        t.walletBalance = walletBalance

        t.walletBalancePercent = (walletBalance / walletHistory[0][1] * 100).toFixed(2)
        t.walletBalanceUSD = walletBalance*lastPrice/100000000
        totalPnlPercent += parseFloat(t.pnlPercent)
        cwlMin = Math.min(cwlMin, t.cwl)
        cwlMax = Math.max(cwlMax, t.cwl)

        t.drawdown = pt.drawdown + t.pnl
        t.drawdownUSD = t.walletBalanceUSD - startDrawDownWalletBalanceUSD
        if (t.drawdown > 0) {
          t.drawdown = 0
          t.drawdownUSD = 0
          startDrawDownWalletBalance = walletBalance
        }
        if (t.drawdownUSD > 0) {
          t.drawdownUSD = 0
          startDrawDownWalletBalanceUSD = walletBalance*lastPrice/100000000
        }
        t.drawdownPercent = (Math.round(t.drawdown / (startDrawDownWalletBalance) * 10000) / 100).toFixed(2)
        t.drawdownUSDPercent = (Math.round(t.drawdownUSD / (startDrawDownWalletBalanceUSD) * 10000) / 100).toFixed(2)
        maxDrawDown = Math.min(maxDrawDown, parseFloat(t.drawdownPercent))
        maxDrawDownUSD = Math.min(maxDrawDownUSD, parseFloat(t.drawdownUSDPercent))

        if (t.group == pt.group) {
          t.psize = pt.psize + entryOrder.cumQty
        }
        else {
          t.psize = entryOrder.cumQty
        }
        t.psizePercent = (t.psize/t.walletBalanceUSD)*100
        t.hoursInTrade = (closeTime - entryTime) / 3600000
        totalHoursInTrade += t.hoursInTrade
        totalGroupHoursInTrade += t.hoursInTrade
        t.avgHoursInTrade = Math.round(totalHoursInTrade/(startIndex+1) * 10) / 10
      }
      else {
        t.drawdown = pt.drawdown
        t.drawdownUSD = pt.drawdownUSD
        t.walletBalanceUSD = pt.walletBalanceUSD
        t.drawdownPercent = (Math.round(t.drawdown / (startDrawDownWalletBalance) * 10000) / 100).toFixed(2)
        t.drawdownUSDPercent = (Math.round(t.drawdownUSD / (startDrawDownWalletBalanceUSD) * 10000) / 100).toFixed(2)
        t.wl = 0
        t.cwl = pt.cwl
      }
    }
    trade.grouppnl = walletBalance - startWalletBalance
    trade.avgGroupHoursInTrade = Math.round(totalGroupHoursInTrade/groupLen*10)/10
    if (trade.grouppnl) {
      totalGroups++
      totalGroupLen += groupLen
      if (trade.grouppnl > 0) {
        totalWinGroups++
        totalWinGroupLen += groupLen
      }
      else {
        totalLoseGroups++
        totalLoseGroupLen += groupLen
      }
      console.log(groupLen,trade.walletBalanceUSD,trade.drawdownPercent,trade.grouppnl,trade.winsPercent)
    }
  })
  
  console.timeEnd('getTradeJson')

  let lastTrade = trades[trades.length-1]
  let avgTotalHoursInTrade = (Math.round(totalHoursInTrade / trades.length * 100) / 100).toFixed(2)
  let avgPnlPercent = (Math.round(totalPnlPercent / trades.length * 100) / 100).toFixed(2)
  let avgGroupLen = (Math.round(totalGroupLen / totalGroups * 100) / 100)
  let avgWinGroupLen = (Math.round(totalWinGroupLen / totalWinGroups * 100) / 100)
  let avgLoseGroupLen = (Math.round(totalLoseGroupLen / totalLoseGroups * 100) / 100)
  console.log('Number of Trades: ' + trades.length, 'Balance: ' + lastTrade.walletBalancePercent+'%', 
    'WinPercent: ' + lastTrade.winsPercent+'%', 'avgTotalHoursInTrade: ' + avgTotalHoursInTrade,
    'avgPnlPercent: ' + avgPnlPercent, 'maxDrawDown: ' + maxDrawDown, 'maxDrawDownUSD: ' + maxDrawDownUSD, 
    'cwlMin: ' + cwlMin, 'cwlMax: ' + cwlMax, 'totalWinGroups: ' + totalWinGroups, 'totalLoseGroups: ' + totalLoseGroups, 
    'avgGroupLen: ' + avgGroupLen, 'avgWinGroupLen: ' + avgWinGroupLen, 'avgLoseGroupLen: ' + avgLoseGroupLen, 'contribution: ' + (contribution/100000000))

  trades[trades.length-1].drawdownPercent = '-100'
  let tradeObject = {trades:trades}
  const csvString = await storage.writeTradesCSV(path.resolve(__dirname, 'test/test1.csv'),tradeObject.trades)
  debugger
  const sheetName = '2% normal'
  await gsheet.upload(setup.startTime.substr(0,13) + ' ' + setup.endTime.substr(0,13) + ' ' + sheetName,csvString)
  console.log('getTradeJson done')
  // return tradeObject
  let tradeJSON = JSON.stringify(tradeObject)
  fs.writeFileSync(cachePath,tradeJSON,writeFileOptions)
  debugger
  return tradeJSON
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

async function updateData() {
  console.time('updateData')
  var start = 20181201
  var end = 20230219
  console.log('updateData bitmex')
  await bitmexdata.downloadTradeData(start,end)
  // await bitmexdata.testCandleDayFiles(start,end,60)
  await bitmexdata.generateCandleDayFiles(start,end,60)
  // await bitmexdata.generateCandleDayFiles(start,end,1440)
  console.log('updateData coinbase')
  await coinbasedata.generateCandleDayFiles(start,end,60)
  console.log('updateData bitstamp')
  await bitstampdata.generateCandleDayFiles(start,end,60)
  console.log('updateData binance')
  await binancedata.generateCandleDayFiles(start,end,60)
  console.log('updateData bitfinex')
  await bitfinexdata.generateCandleDayFiles(start,end,60)
  console.timeEnd('updateData')
  debugger
}

async function initExchanges() {
  for (let i = 0; i < tradeExchanges.length; i++) {
    await tradeExchanges[i].init(strategy,checkPositionCallback)
  }
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
  await strategy.init(tradeExchanges)

  if (mock) {
    var tradeJSON = await getTradeJson(setup)
    debugger
  }
  else {
    await initExchanges()
    await next()
    shoes.intervals.forEach(intervalDelay => {
      createInterval(intervalDelay)
    })
  }
} catch(e) {logger.error(e.stack||e);debugger} }

init()

/* TODO
find more signal to reduce the 5-6 trade draw down
test double trade on 11/14 21hr and 22hr

if the position != 0 the new stop lost must be more than current stop loss

use marginBalance instead of walletBalance
set take profit 1% in bear market
move stop loss 
  - when it's winning
  - every hour lookback 36
reduce size
*/