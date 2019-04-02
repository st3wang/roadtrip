const util = require('util')
const fs = require('fs')
const readline = require('readline')
const readFileOptions = {encoding:'utf-8', flag:'r'}

var handleMargin,handleOrder,handlePosition,handleInstrument
var startYMD = 20170101, endYMD = 20170201 //20190330
var instrumentTime = new Date('2017-01-01').getTime()
var _orders = [], 
    _margin = {availableMargin: 100000000, walletBalance: 100000000}
    _position = {currentQty: 0}, 
    _instrument = {}

function getYmd(ymd) {
  var y = Math.floor(ymd / 10000)
  var m = Math.floor((ymd - y * 10000) / 100)
  var d = ymd - y * 10000 - m * 100
  return {y:y,m:m,d:d}
}

function nextDay(ymd) {
  var date = getYmd(ymd)
  var y = date.y, m = date.m, d = date.d
  var maxDay = 30
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      maxDay = 31
      break;
    case 2:
      maxDay = (y % 4 == 0 ? 29 : 28)
      break;
  }

  if (++d > maxDay) {
    d = 1
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return y*10000 + m*100 + d
}

async function readTrades(ymd) {
  return new Promise((resolve,reject) => {
    var trades = []
    var lineReader = readline.createInterface({
      input: fs.createReadStream('../survey/data/bitmex/trade/'+ymd+'_XBTUSD.csv')
    })
    
    lineReader.on('line', line => {
      trades.push(line.split(','))
    })
    lineReader.on("close", () => {
      resolve(trades)
    })
  })
}

async function connect() { try {
  await handleMargin([_margin])
  await handlePosition([_position])

  for (var ymd = startYMD; ymd < endYMD; ymd = nextDay(ymd)) {
    let trades = await readTrades(ymd)
    let len = trades.length
    for (let i = 0; i < len; i++) {
      let [time,side,size,price] = trades[i]
      price = +price
      instrumentTime = +time
      
      await fillOrders(price)

      _instrument.timestamp = new Date(instrumentTime).toISOString()
      _instrument.bidPrice = price
      _instrument.askPrice = price
      _instrument.lastPrice = price
        // fundingTimestamp = lastInstrument.fundingTimestamp
        // fundingRate: 0
      await handleInstrument([_instrument])
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

function authorize() {

}

function getTradeBucketed() {
  var str = fs.readFileSync('../survey/data/bitmex/candle/15/' + (20170101+1) + '.json',readFileOptions)
  var market = JSON.parse(str)
  return market
}

function getCurrentTradeBucketed() {
  return {candle:{},candleTimeOffset:0}
}

function updateLeverage() {

}

function getNow() {
  return new Date(instrumentTime++)
}

function cancelAll() {
  _orders.forEach(order => {
    if (order.ordStatus == 'New') order.ordStatus = 'Canceled'
  })
}

async function orderLimit(cid,price,size,execInst) {
  var order = {
    ordStatus: 'New',
    ordType: 'Limit',
    side: size > 0 ? 'Buy' : 'Sell',
    cumQty: 0,
    orderQty: Math.abs(size),
    price: price,
    stopPx: null,
    execInst:'ParticipateDoNotInitiate'+(execInst||'')
  }
  _orders.push(order)
  await handleOrder(_orders)
  return ({obj:order})
}

async function orderStopMarket(price,size) {
  var order = {
    ordStatus: 'New',
    ordType: 'Stop',
    side: size > 0 ? 'Buy' : 'Sell',
    cumQty: 0,
    orderQty: Math.abs(size),
    price: null,
    stopPx: price,
    execInst:'LastPrice,ReduceOnly'
  }
  _orders.push(order)
  await handleOrder(_orders)
  return ({obj:order})
}

async function fillOrders(lastPrice) {
  var filledOrders = _orders.filter(({ordStatus,price,stopPx,orderQty,side}) => {
    if (ordStatus !== 'New') return
    if (price) {
      if (side == 'Buy') {
        if (lastPrice < price) {
          return true
        }
      }
      else {
        if (lastPrice > price) {
          return true
        }
      }
    }
    else if (stopPx) {
      if (side == 'Buy') {
        if (lastPrice >= stopPx) {
          return true
        }
      }
      else {
        if (lastPrice <= stopPx) {
          return true
        }
      }
    }
    return
  })
  for (let i = 0; i < filledOrders.length; i++) {
    let order = filledOrders[i]
    let {side,price,stopPx,orderQty} = order

    let execQty = (side == 'Buy' ? orderQty : (-orderQty))
    // console.log('filled',order)

    if (_position.currentQty == 0 && order.execInst.indexOf('ReduceOnly') >= 0) {
      order.ordStatus = 'Canceled'
    }
    else {
      if (price) {
        let execPrice = price
        let execBTC = execQty/execPrice
        let execCost = (-execBTC //- (Math.abs(execBTC)*0.000225)
        )*100000000
        if (order.execInst == 'ParticipateDoNotInitiate') {
          if (_position.currentQty != 0) debugger
          // Entry
          order.cumQty = orderQty
          order.ordStatus = 'Filled'
          _position.execQty = execQty
          _position.avgEntryPrice = execPrice
          _position.execCost = execCost
        }
        else {
          // Take Profit
          order.cumQty = orderQty
          order.ordStatus = 'Filled'
          let profit = _position.execCost + execCost
          if (profit > 0) debugger
          _margin.availableMargin -= profit
          _margin.walletBalance = _margin.availableMargin
        }
      }
      else if (stopPx) {
        // Stop Market
        let execPrice = stopPx
        let execBTC = execQty/execPrice
        let execCost = (-execBTC //+ (Math.abs(execBTC)*0.000675)
        )*100000000
        order.cumQty = orderQty
        order.ordStatus = 'Filled'
        let profit = _position.execCost + execCost
        if (profit < 0) debugger
        _margin.availableMargin -= profit
        _margin.walletBalance = _margin.availableMargin
      }
      _position.currentQty += execQty
      console.log(_position.currentQty)
      await handlePosition([_position])
    }
    await handleOrder(_orders)
  }
}

function init(handleMarginCb,handleOrderCb,handlePositionCb,handleInstrumentCb) {
  handleMargin = handleMarginCb
  handleOrder = handleOrderCb
  handlePosition = handlePositionCb
  handleInstrument = handleInstrumentCb
}

module.exports = {
  init: init,
  getNow: getNow,
  connect: connect,
  authorize: authorize,
  getTradeBucketed: getTradeBucketed,
  getCurrentTradeBucketed: getCurrentTradeBucketed,
  updateLeverage: updateLeverage,
  cancelAll: cancelAll,
  orderLimit: orderLimit,
  orderStopMarket: orderStopMarket
}