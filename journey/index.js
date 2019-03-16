const sheets = require('./sheets')
const log = require('./log')
const bitmex = require('./bitmex')
const strategy = require('./strategy')
const server = require('./server')
const shoes = require('./shoes')
const setup = shoes.setup

console.log('setup', JSON.stringify(setup))

async function next() {
  // TODO: move position logic from strategy.js to bitmex.js
  let position = bitmex.getPosition()
  let margin = await bitmex.getMargin()
  let market = await bitmex.getMarket(15,96) // one day of 15 minutes candles
  let rsiSignal = await strategy.getSignal(market.closes,setup.rsi.length,setup.rsi.overbought,setup.rsi.oversold)

  // if (shoes.test) {
  //   rsiSignal.condition = 'LONG'
  //   position.currentQty = 0
  // }
  
  var order = await strategy.getOrder(rsiSignal,market,setup.bankroll,position,margin)
  var orderSent = false

  // if (shoes.test) {
  //   debugger
  //   var distance = 0.5
  //   order.type = 'SHORT'
  //   order.entryPrice = 3718.5
  //   order.leverage = 1
  //   if (order.type == 'LONG') {
  //     order.stopLoss = order.entryPrice - distance
  //     order.stopMarketTrigger = order.entryPrice - distance*4
  //     order.takeProfit = order.entryPrice + distance
  //     order.positionSizeUSD = 1
  //   }
  //   else {
  //     order.stopLoss = order.entryPrice + distance
  //     order.stopMarketTrigger = order.entryPrice + distance*4
  //     order.takeProfit = order.entryPrice - distance
  //     order.positionSizeUSD = -1
  //   }
  //   order.stopLossTrigger = order.stopLoss
  //   order.takeProfitTrigger = order.takeProfit
  // }

  if (order.type == 'SHORT' || order.type == 'LONG') {
    orderSent = await bitmex.enter(order,margin)
  }
  log.writeInterval(rsiSignal,market,setup.bankroll,position,margin,order,orderSent)
}

async function getMarketCsv() {
  var market = await bitmex.getMarket(15,96)
  var rsis = await strategy.getRsi(market.closes,setup.rsi.length)
  var csv = 'Date,Open,High,Low,Close,Rsi\n'
  market.candles.forEach((candle,i) => {
    csv += //new Date(candle.time).toUTCString()
    candle.time+','+candle.open+','+candle.high+','+candle.low+','+candle.close+','+rsis[i]+'\n'
  })
  return csv
}

function getOrderCsv(order,execution,enterOrder) {
  var status = order.ordStatus.toUpperCase()
  var side = execution=='ENTER'?(order.side=='Buy'?'LONG':'SHORT'):(order.side=='Buy'?'SHORT':'LONG')
  var takeProfit = 0
  if (execution == 'EXIT') {
    if (side == 'LONG' && order.price > enterOrder.price) {
      takeProfit = order.price
    }
    else if (side == 'SHORT' && order.price < enterOrder.price) {
      takeProfit = order.price
    }
  }
  return (status=='NEW'?order.timestamp:order.transactTime)+','+
    execution+'-'+side+'-'+status+','+
    order.price+','+order.orderQty+',0,'+takeProfit+'\n'
}

// function getOrderNewFilledCsv(order,execution) {
//   var csv = getOrderCsv(order,execution,'NEW')
//   if (order.ordStatus == 'Filled') {
//     csv += getOrderCsv(order,execution,'FILLED')
//   }
//   return csv
// }

async function getTradeCsv() {
  // var trades = await sheets.getTrades()
  var yesterday = new Date().getTime() - (48*60*60000)
  var orders = await bitmex.getOrders(yesterday)
  var csv = 'Date,Type,Price,Quantity,StopLoss,TakeProfit\n'
  for (var i = 0; i < orders.length; i++) {
    var order = orders[i]
    var nextOrder = orders[i+1]
    csv += getOrderCsv(order,'ENTER')
    if (nextOrder && nextOrder.orderQty === order.orderQty && nextOrder.side !== order.side) {
      csv += getOrderCsv(nextOrder,'EXIT',order)
      i++
    }
  }
  /*
  trades.forEach(t => {
    // { date: data[2].date, type: "buy", price: data[2].low, quantity: 1000 }
    csv += //new Date(t[0]).toUTCString()
    t[0]+','+'ENTER-'+t[4]+','+t[5]+','+t[18]+','+t[6]+','+t[7]+'\n'
    if (t[9] && t[9].length > 0) {
      csv += //new Date(t[9]).toUTCString()
      t[9]+','+'EXIT-'+t[4]+','+t[10]+','+t[18]+','+t[6]+','+t[7]+'\n'
    }
  })*/
  return csv
}

async function start() {
  await log.init()
  await bitmex.init(log.writeExit)
  await server.init(getMarketCsv,getTradeCsv)

  next()
  var now = new Date().getTime()
  var interval = 15*60000
  var delay = 20000 // bitmex bucket data delay. it will be faster with WS
  var startIn = interval-now%(interval) + delay
  var startInSec = startIn % 60000
  var startInMin = (startIn - startInSec) / 60000
  console.log('next one in ' + startInMin + ':' + Math.floor(startInSec/1000) + ' minutes')
  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startIn)
}

start()