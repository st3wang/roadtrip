const bitmexdata = require('./bitmexdata')
const uuid = require('uuid');
const fs = require('fs')

const shoes = require('./shoes')
const {symbol,account,setup} = shoes

const winston = require('winston')
const colorizer = winston.format.colorize();
const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date(getTimeNow()).toISOString()
  return info;
});

const oneDayMs = 24*60*60000

var startTimeMs = new Date(shoes.mock.startTime).getTime()
var endTimeMs = new Date(shoes.mock.endTime).getTime()

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

var timeNow = 0, handleInterval,handleMargin,handleOrder,handlePosition,handleInstrument,handleXBTUSDInstrument

function getTimeNow() {
  return timeNow //new Date().getTime()
}

function getISOTimeNow() {
  return new Date(timeNow).toISOString()
}

function authorize() {

}

async function getTradeBucketed({symbol,interval,startTime:st,endTime:et}) { try {
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
  var startIndex = startTime % (oneDayMs) / 60000
  var endIndex = startIndex + (endTime - startTime) / 60000
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
  let now = getTimeNow()
  let candleTimeOffset = now % (interval*60000)
  var candle = {}
  let timeMs = now-candleTimeOffset
  candle.time = new Date(timeMs).toISOString()
  candle.startTimeMs = timeMs
  candle.endTimeMs = timeMs + 899999
  candle.lastTradeTimeMs = timeMs // accepting new trade data
  // debugger
  return {candle:candle,candleTimeOffset:candleTimeOffset}
} catch(e) {logger.error(e.stack||e); debugger} }

function initOrders() {

}

function updateLeverage() {

}

var margin = {
  walletBalance: 100000000
}
var orders = [], historyOrders = []
var position = {
  currentQty: 0
}
var trades = [], currentTradeIndex = -1

async function nextMargin() {
  await handleMargin([margin])
}

function fillOrder(o) {
  var {orderQty,side,execInst} = o
  o.cumQty = orderQty 
  o.ordStatus = 'Filled'
  o.transactTime = getISOTimeNow()
  o.timestamp = o.transactTime
  return side == 'Buy' ? orderQty : -orderQty
}

async function nextOrder(lastPrice) {
  var execOrders = orders.filter(o => {
    let {ordStatus,ordType,side,orderQty,price,stopPx,execInst} = o
    if (ordStatus == 'New') {
      switch(ordType) {
        case 'Limit':
          return ((side == 'Buy' && lastPrice < price) || (side == 'Sell' && lastPrice > price))
        case 'Stop':
          return ((side == 'Buy' && lastPrice >= stopPx) || (side == 'Sell' && lastPrice <= stopPx))
      }
    }
  })
  if (execOrders.length) {
    execOrders.forEach(o => {
      if (position.currentQty == 0 && o.execInst.indexOf('ReduceOnly') > 0) {
        o.ordStatus = 'Canceled'
      }
      else {
        o.orderQty = o.orderQty || Math.abs(position.currentQty)
        position.currentQty += fillOrder(o)
      }
    })
    await handleOrder(orders)
    await handlePosition([position])
  }
}

async function nextPosition() {
  await handlePosition([position])
}

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
  trades = await bitmexdata.readTradeDay(startTime,shoes.symbol)
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

var lastIntervalTime = 0

async function nextInstrument() { try {
  currentTradeIndex++
  var trade = trades[currentTradeIndex]

  if (!trade) {
    console.timeEnd('readNextDayTrades')
    console.time('readNextDayTrades')
    trades = await readNextDayTrades()
    if (trades && trades.length) {
      currentTradeIndex = 0
      trade = trades[0]
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

  if (shoes.symbol != 'XBTUSD') {
    handleXBTUSDInstrument([{
      symbol: 'XBTUSD',
      lastPrice: 5000
    }])
  }
} catch(e) {logger.error(e.stack||e);debugger} }

function next() {

}

function createInterval() {
  
}

async function cancelAll() {
  orders.forEach(o => {
    if (o.ordStatus == 'New') {
      o.ordStatus = 'Canceled'
    }
  })
}

function newOrder({side,orderQty,price,stopPx,ordType,execInst}) {
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
  var amendOrders = []
  ords.forEach(o => {
    let ord = orders.find(ao => {
      return ao.orderID == o.orderID
    })
    if (ord) {
      ord.orderQty = Math.abs(o.orderQty)
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

async function updateData() {
  var start = 20190401
  var end = 20190430
  await bitmexdata.downloadTradeData(start,end)
  await bitmexdata.generateCandleDayFiles(start,end,1)
}

async function init(sp) {
  // await updateData()
  // debugger
  margin = {
    walletBalance: 100000000
  }
  orders = []
  historyOrders = []
  position = {
    currentQty: 0
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

    await nextMargin()
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

  next: next,
  createInterval: createInterval,
  start: start
}
