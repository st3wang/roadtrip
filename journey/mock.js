const bitmexdata = require('./bitmexdata')
const uuid = require('uuid');
const fs = require('fs')

const shoes = require('./shoes')
const storage = require('./storage')

const winston = require('winston')
const {isoTimestamp, colorizer} = global

const makerFee = -0.00025
const takerFee = 0.00075
const oneDayMs = 24*60*60000
var oneCandleMs

var setup, startTimeMs, endTimeMs, XBTUSDRate

var timeNow = 0, handleInterval,handleMargin,handleOrder,handlePosition,handleInstrument,handleXBTUSDInstrument

var margin, walletHistory, orders, historyOrders, position, trades, currentTradeIndex
var rsis

const logger = winston.createLogger({
  format: winston.format.label({label:'bitmex'}),
  transports: [
    new winston.transports.Console({
      level:shoes.log.level||'info',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.prettyPrint(),
        winston.format.printf(info => {
          let splat = info[Symbol.for('splat')]
          let {timestamp,level,message} = info
          let prefix = timestamp.substring(5).replace(/[T,Z]/g,' ')+'['+colorizer.colorize(level,'mck')+'] '
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

function getTimeNow() {
  return timeNow //new Date().getTime()
}

function getISOTimeNow() {
  return new Date(timeNow).toISOString()
}

function authorize() {

}

async function getTradeBucketed({symbol,interval,startTime:st,endTime:et}) { try {
  oneCandleMs = interval * 60000
  var startTime = new Date(st).getTime()
  var endTime = new Date(et).getTime()
  var startDayTime = startTime - (startTime % oneDayMs) 
  var marketBuffer = {
    opens: [],
    highs: [],
    lows: [],
    closes: [],
    candles: []
  }
  for (; startDayTime < endTime; startDayTime += oneDayMs) {
    endDayTime = startDayTime + oneDayMs - 1
    let {opens,highs,lows,closes,candles} = await bitmexdata.getTradeBucketed(interval,startDayTime,symbol)
    marketBuffer.opens.push(...opens)
    marketBuffer.highs.push(...highs)
    marketBuffer.lows.push(...lows)
    marketBuffer.closes.push(...closes)
    marketBuffer.candles.push(...candles)
  }
  var startIndex = startTime % (oneDayMs) / oneCandleMs
  var endIndex = startIndex + (endTime - startTime) / oneCandleMs
  var market = {
    opens: marketBuffer.opens.slice(startIndex,endIndex),
    highs: marketBuffer.highs.slice(startIndex,endIndex),
    lows: marketBuffer.lows.slice(startIndex,endIndex),
    closes: marketBuffer.closes.slice(startIndex,endIndex),
    candles: marketBuffer.candles.slice(startIndex,endIndex),
  }
  return market
} catch(e) {logger.error(e.stack||e);debugger} }

async function getCurrentTradeBucketed(interval) { try {
  interval = interval || 15
  oneCandleMs = interval * 60000
  let now = getTimeNow()
  let candleTimeOffset = now % (interval*60000)
  var candle = {}
  let timeMs = now-candleTimeOffset
  candle.time = new Date(timeMs).toISOString()
  candle.startTimeMs = timeMs
  candle.endTimeMs = timeMs + (oneCandleMs-1)
  candle.lastTradeTimeMs = timeMs // accepting new trade data
  // debugger
  return {candle:candle,candleTimeOffset:candleTimeOffset}
} catch(e) {logger.error(e.stack||e); debugger} }

function initOrders() {

}

function updateLeverage() {

}

async function nextMargin(cost,fee) {
  margin.walletBalance += (cost - fee)
  margin.marginBalance = margin.walletBalance
  if (!margin.walletBalance) debugger
  walletHistory.push([getISOTimeNow(),margin.walletBalance,cost,fee])
  await handleMargin([margin])
}

function fillOrder(o,lastPrice) {
  var {orderQty,side,execInst} = o
  o.cumQty = orderQty 
  o.ordStatus = 'Filled'
  o.transactTime = getISOTimeNow()
  // o.timestamp = o.transactTime
  if (!o.price) {
    o.price = o.stopPx //+ (lastPrice < o.stopPx ? -2 : 2)
    // o.price = o.stopPx//lastPrice
  }
  // var foreignNotional = (side == 'Buy' ? -orderQty : orderQty)
  // var homeNotional = -foreignNotional / o.price
  // var coinPairRate = 1 // lastPrice/XBTUSDRate
  // var fee = execInst.indexOf('ParticipateDoNotInitiate') >= 0 ? makerFee : takerFee
  // var execComm = Math.round(Math.abs(homeNotional * coinPairRate) * fee * 100000000)
  return getCost(o)
}

function getCost({side,cumQty,price,execInst}) {
  var foreignNotional = (side == 'Buy' ? -cumQty : cumQty)
  var homeNotional = -foreignNotional / price
  var coinPairRate = 1 //lastPrice/XBTUSDRate
  var fee = execInst.indexOf('ParticipateDoNotInitiate') >= 0 ? makerFee : takerFee
  var execComm = Math.round(Math.abs(homeNotional * coinPairRate) * fee * 100000000)
  return [homeNotional,foreignNotional,execComm]
}

async function nextOrder(lastPrice) {
  var execOrders = orders.filter(o => {
    let {ordStatus,ordType,side,orderQty,price,stopPx,execInst} = o
    if (ordStatus == 'New') {
      switch(ordType) {
        case 'Limit':
          switch(execInst) {
            case 'ParticipateDoNotInitiate':
              return ((side == 'Buy' && lastPrice < price) || (side == 'Sell' && lastPrice > price))
            default:
              return ((side == 'Buy' && lastPrice <= price) || (side == 'Sell' && lastPrice >= price))
          }
        case 'Stop':
          return ((side == 'Buy' && lastPrice >= stopPx) || (side == 'Sell' && lastPrice <= stopPx))
      }
    }
  })
  if (execOrders.length) {
    execOrders.forEach(o => {
      if (position.currentQty == 0 && /Close|ReduceOnly/.test(o.execInst)) {
        o.ordStatus = 'Canceled'
      }
      else {
        o.orderQty = o.orderQty || Math.abs(position.currentQty)
        let [homeNotional,foreignNotional,execComm] = fillOrder(o,lastPrice)
        position.currentQty -= foreignNotional
        position.homeNotional += homeNotional
        position.foreignNotional += foreignNotional
        position.execComm += execComm
        if (position.currentQty == 0) {
          let coinPairRate = 1 //lastPrice/XBTUSDRate
          let cost = Math.round(position.homeNotional * coinPairRate * 100000000)
          let fee = position.execComm
          position.homeNotional = 0
          position.execComm = 0
          nextMargin(cost,fee)
        }
      }
    })
    await handleOrder(orders)
    await handlePosition([position])
  }
}

async function nextPosition() {
  await handlePosition([position])
}

async function nextXBTUSDInstrument(trade) { try {
  // debugger
  // var dayMarket = await bitmexdata.getTradeBucketed(1440,time,'XBTUSD')
  // debugger
  // var {open,high,low,close} = dayMarket.candles[0]
  // XBTUSDRate = (open+high+low+close)/4
  XBTUSDRate = trade[3]
  await handleXBTUSDInstrument([{
    symbol: 'XBTUSD',
    lastPrice: XBTUSDRate
  }])
} catch(e) {logger.error(e.stack||e); debugger} }

async function readNextDayTrades() { try {
  var startTime, endTime
  if (trades.length == 0) {
    startTime = startTimeMs
  }
  else {
    let lastTradeTime = trades[trades.length-1][0]
    startTime = lastTradeTime - (lastTradeTime % oneDayMs) + oneDayMs
  }
  if (startTime > endTimeMs) {
    return
  }
  endTime = startTime - (startTime % oneDayMs) + oneDayMs - 1
  if (endTime > endTimeMs) {
    endTime = endTimeMs
  }
  trades = await bitmexdata.readFeedDay(setup.symbol,setup.candle.interval,startTime)
  var filterStartTime = (startTime % oneDayMs) != 0
  var filterEndTime = (endTime % oneDayMs) != oneDayMs - 1
  if (filterStartTime && filterEndTime) {
    trades = trades.filter(([time]) => (time >= startTime && time <= endTime))
  }
  else if (filterStartTime) {
    trades = trades.filter(([time]) => (time >= startTime))
  }
  else if (filterEndTime) {
    trades = trades.filter(([time]) => (time <= endTime))
  }
  return trades
} catch(e) {logger.error(e.stack||e); debugger} }

async function nextInstrument() { try {
  currentTradeIndex++
  var trade = trades[currentTradeIndex]

  if (!trade) {
    // console.timeEnd('readNextDayTrades')
    // console.time('readNextDayTrades')
    trades = await readNextDayTrades()
    if (trades && trades.length) {
      currentTradeIndex = 0
      trade = trades[0]
      // if (setup.symbol != 'XBTUSD') {
        nextXBTUSDInstrument(trade)
      // }
    }
    else {
      return
    }
  }

  const [time,side,size,price] = trade
  timeNow = time
  const instruments = [{
    symbol: shoes.symbol,
    timestamp: new Date(timeNow).toISOString(),
    lastPrice: price,
    bidPrice: price,
    askPrice: price
  }]

  if (size) {
    await nextOrder(price)
    await handleInstrument(instruments)
  }
  else {
    // let now = getTimeNow()
    // let date = new Date(now)
    // let ms = date.getMilliseconds()
    // if (ms != 0) debugger
    // if (now - lastIntervalTime != 60000) {
    //   console.log('last', new Date(lastIntervalTime).toISOString())
    //   console.log('now', new Date(now).toISOString())
    //   let missing = new Date(now-60000).toISOString()
    //   let found
    //   for (let i = currentTradeIndex; i >=0; i--) {
    //     if (trades[i][4] == missing) {
    //       console.log('found trade', missing)
    //       found = true
    //       i = 0
    //     }
    //   }
    //   if (!found) {
    //     console.error('not found trade', missing)
    //   }
    // }
    // lastIntervalTime = now
    await handleInterval(instruments)
  }
  return true
} catch(e) {logger.error(e.stack||e); debugger} }

async function connect(hInterval,hMargin,hOrder,hPosition,hInstrument,hXBTUSDInstrument) { try {
  handleInterval = hInterval
  handleMargin = hMargin
  handleOrder = hOrder
  handlePosition = hPosition
  handleInstrument = hInstrument
  handleXBTUSDInstrument = hXBTUSDInstrument
} catch(e) {logger.error(e.stack||e);debugger} }

function next() {

}

function createInterval() {
  
}

async function cancelAll() {
  orders.forEach(o => {
    if (o.ordStatus == 'New') {
      if (o.ordType == 'Limit') {
        storage.cancelEntrySignal(o)
      }
      o.ordStatus = 'Canceled'
    }
  })
}

function newOrder({side,orderQty,price,stopPx,ordType,execInst}) {
  // console.log('newOrder',side,orderQty,price,stopPx,ordType,execInst)
  var isoTimeNow = getISOTimeNow()
  var o = {
    orderID: uuid.v1(),
    side: side,
    orderQty: Math.abs(orderQty),
    price: price,
    stopPx: stopPx,
    ordType: ordType,
    execInst: execInst,
    ordStatus: 'New',
    cumQty: 0,
    transactTime: isoTimeNow,
    timestamp: isoTimeNow
  }
  orders.push(o)
  historyOrders.push(o)
  return o
}

async function orderNewBulk(ords) {
  var newOrders = ords.map(o => {
    return newOrder(o)
  })
  return {
    status: 200,
    obj: newOrders
  }
}

async function orderAmendBulk(ords) {
  // console.log('orderAmendBulk')
  var amendOrders = []
  ords.forEach(o => {
    let ord = orders.find(ao => {
      return ao.orderID == o.orderID
    })
    if (ord) {
      ord.orderQty = Math.abs(o.orderQty)
      ord.stopPx = o.stopPx
      ord.price = o.price
      amendOrders.push(ord)
    }
  })
  return {
    status: 200,
    obj: amendOrders
  }
}

async function cancelOrders(ords) {
  var cancelOrders = []
  ords.forEach(o => {
    let ord = orders.find(ao => {
      return ao.orderID == o.orderID
    })
    if (ord) {
      ord.ordStatus = 'Canceled'
      cancelOrders.push(ord)
    }
  })
  return {
    status: 200,
    obj: cancelOrders
  }
}

async function getOrders({startTime,endTime}) { try {
  startTime = startTime ? new Date(startTime).getTime() : new Date(getTimeNow() - oneDayMs)
  endTime = endTime ? new Date(endTime).getTime() : new Date(getTimeNow())

  return historyOrders.filter(({timestamp}) => {
    return (new Date(timestamp).getTime() >= startTime)
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function getWalletHistory() {
  return walletHistory
}

async function getRsisCache(market) {
  var len = market.candles.length
  var rsisStartTime = startTimeMs-len*60000
  rsis = rsis || await bitmexdata.readRsis('XBTUSD',rsisStartTime,setup.interval,setup.rsi.length)

  var st = new Date(market.candles[0].time).getTime()
  var begin = Math.floor((st - rsisStartTime) / (setup.interval * 60000))
  return rsis.slice(begin,begin+len)
}

async function init(sp) {
  setup = sp
  oneCandleMs = sp.interval * 60000
  margin = {
    walletBalance: 100000000,
    marginBalance: 100000000
  }
  walletHistory = []
  orders = []
  historyOrders = []
  position = {
    currentQty: 0,
    homeNotional: 0,
    foreignNotional: 0,
    execComm: 0
  }
  trades = []
  currentTradeIndex = -1
  if (sp) {
    startTimeMs = new Date(sp.startTime).getTime()
    endTimeMs = new Date(sp.endTime).getTime()
  }

  timeNow = startTimeMs
  try {
    fs.writeFileSync(global.logDir+'/combined.log', '')
    fs.writeFileSync(global.logDir+'/entry_signal_table.log', '')
    fs.writeFileSync(global.logDir+'/warn.log', '')
  }
  catch(e) {

  }
}

async function start() {
  return new Promise(async (resolve,reject) => {
    var cont

    await nextMargin(0,0)
    await nextOrder()
    await nextPosition()
    
    do {
      cont = await nextInstrument()
    } while(cont)

    resolve()
  })
}

module.exports = {
  init: init,
  getTimeNow: getTimeNow,
  authorize: authorize,
  getTradeBucketed: getTradeBucketed,
  getCurrentTradeBucketed: getCurrentTradeBucketed,
  initOrders: initOrders,
  updateLeverage: updateLeverage,
  connect: connect,

  cancelAll: cancelAll,
  orderNewBulk: orderNewBulk,
  orderAmendBulk: orderAmendBulk,
  cancelOrders: cancelOrders,

  getOrders: getOrders,
  getWalletHistory: getWalletHistory,
  getCost: getCost,

  next: next,
  createInterval: createInterval,
  start: start,

}
