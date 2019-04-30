const shoes = require('./shoes')
const bitmexdata = require('./bitmexdata')

const winston = require('winston')

const colorizer = winston.format.colorize();
const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date().toISOString()
  return info;
});

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

var timeNow, handleMargin,handleOrder,handlePosition,handleInstrument,handleXBTUSDInstrument

function getTimeNow() {
  return timeNow //new Date().getTime()
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

var trades, currentTradeIndex

async function nextInstrument() {
  var trade = trades[currentTradeIndex]
  timeNow = trade.time
  await handleInstrument([{
    symbol: shoes.symbol,
    timestamp: new Date(timeNow).toISOString,
    lastPrice: trade.price,
    bidPrice: trade.price,
    askPrice: trade.price
  }])
  setTimeout(() => {
    currentTradeIndex++
    nextInstrument()
  },0)
}

async function streamInstrument(time) {
  trades = await bitmexdata.readTradeDay(time,shoes.symbol)
  currentTradeIndex = 0
  setTimeout(() => {
    nextInstrument()
  },0)
}

async function connect(hMargin,hOrder,hPosition,hInstrument,hXBTUSDInstrument) {
  handleMargin = hMargin
  handleOrder = hOrder
  handlePosition = hPosition
  handleInstrument = hInstrument
  handleXBTUSDInstrument = hXBTUSDInstrument

  await streamInstrument(timeNow)
}

function next() {

}

function createInterval() {
  
}

async function cancelAll() {

}

async function orderNewBulk() {
  return {
    status: 200,
    obj: []
  }
}

function init() {
  timeNow = new Date(shoes.mock.startTime).getTime()
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

  next: next,
  createInterval: createInterval,


}

init()

// bitmexdata.downloadTradeData(20190425,20190429)
// bitmexdata.generateCandleDayFiles(20190425,20190429,1)