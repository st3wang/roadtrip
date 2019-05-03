const bitmexdata = require('./bitmexdata')
const uuid = require('uuid');
const fs = require('fs')

const shoes = require('./shoes')
const {symbol,account,setup} = shoes
const oneCandleMS = setup.candle.interval*60000
const candleLengthMS = setup.candle.interval*setup.candle.length*60000

const winston = require('winston')
const colorizer = winston.format.colorize();
const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date(getTimeNow()).toISOString()
  return info;
});

const startTimeMs = new Date(shoes.mock.startTime).getTime()
const endTimeMs = new Date(shoes.mock.endTime).getTime()

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

var timeNow, handleInterval,handleMargin,handleOrder,handlePosition,handleInstrument,handleXBTUSDInstrument

function getTimeNow() {
  return timeNow //new Date().getTime()
}

function getISOTimeNow() {
  return new Date(timeNow).toISOString()
}

function authorize() {

}

async function getTradeBucketed(interval,length) { try {
  var endTime = getTimeNow()
  var startTime = endTime - (interval*length*60000)
  return await bitmexdata.getTradeBucketed(interval,startTime,endTime,shoes.symbol)
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
var orders = []
var position = {
  currentQty: 0
}
var trades, currentTradeIndex

async function nextMargin() {
  await handleMargin([margin])
}

function fillOrder(o) {
  var {orderQty,side} = o
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
      o.orderQty = o.orderQty || Math.abs(position.currentQty)
      position.currentQty += fillOrder(o)
    })
    await handleOrder(orders)
    await handlePosition([position])
  }
}

async function nextPosition() {
  await handlePosition([position])
}

async function nextInstrument() { try {
  var trade = trades[currentTradeIndex]
  timeNow = trade.time
  if (trade.isInterval) {
    await handleInterval()
  }
  else {
    await nextOrder(trade.price)
    await handleInstrument([{
      symbol: shoes.symbol,
      timestamp: new Date(timeNow).toISOString(),
      lastPrice: trade.price,
      bidPrice: trade.price,
      askPrice: trade.price
    }])
  }
  setTimeout(() => {
    currentTradeIndex++
    if (currentTradeIndex < trades.length) {
      nextInstrument()
    }
  },0)
} catch(e) {logger.error(e.stack||e); debugger} }

async function streamInstrument(time) {
  trades = await bitmexdata.readTradeDay(time,shoes.symbol,startTimeMs,endTimeMs)
  currentTradeIndex = 0
  setTimeout(() => {
    nextInstrument()
  },0)
}

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
  await nextMargin()
  await nextOrder()
  await nextPosition()
  await streamInstrument(timeNow)
} catch(e) {logger.error(e.stack||e);debugger} }

function next() {

}

function createInterval() {
  
}

async function cancelAll() {

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

async function getOrders(startTime) {
  startTime = startTime || (getTimeNow() - (candleLengthMS))

  return orders.filter(({timestamp}) => {
    return (new Date(timestamp).getTime() >= startTime)
  })
}

function init() {
  timeNow = startTimeMs
  try {
    fs.unlinkSync(global.logDir+'/combined.log')
    fs.unlinkSync(global.logDir+'/entry_signal_table.log')
    fs.unlinkSync(global.logDir+'/warn.log')
  }
  catch(e) {

  }
}

module.exports = {
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


}

init()

// bitmexdata.downloadTradeData(20190425,20190429)
// bitmexdata.generateCandleDayFiles(20190425,20190429,1)