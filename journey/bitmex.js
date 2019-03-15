const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const shoes = require('./shoes')
const log = require('./log')

const BitMEXRealtimeAPI = require('bitmex-realtime-api')

const EXECINST_REDUCEONLY = ',ReduceOnly'
const RETRYON_CANCELED = 'Canceled'

var client, exitTradeCallback, marketCache
var binSize = 5

var ws, wsHeartbeatTimeout
var entryOrder
var lastQuote = {}

function heartbeat() {
  setInterval(_ => {
    ws.socket.send('ping')
  },60000)
}

async function wsAddStream(table, handler) {
  ws.addStream('XBTUSD', table, handler)
  await new Promise((resolve,reject) => {
    var checkValueInterval = setInterval(_ => {
      if (ws._data && ws._data[table]) {
        console.log(table + ' data is flowing')
        clearInterval(checkValueInterval)
        clearTimeout(timeout)
        resolve()
      }
    },200)
    var timeout = setTimeout(_ => {
      console.log(table + ' timeout')
      clearInterval(checkValueInterval)
      resolve()
    }, 3000)
  })
}

async function wsConnect() {
  ws = new BitMEXRealtimeAPI({
    testnet: shoes.bitmex.test,
    apiKeyID: shoes.bitmex.key,
    apiKeySecret: shoes.bitmex.secret,
    maxTableLen: 1
  })
  ws.on('error', console.error);
  ws.on('open', () => console.log('Connection opened.'));
  ws.on('close', () => console.log('Connection closed.'));
  // ws.on('initialize', () => console.log('Client initialized, data is flowing.'));
  heartbeat()

  await wsAddStream('order',handleOrder)
  await wsAddStream('position',handlePosition)
  // await wsAddStream('quote',handleQuote)
  await wsAddStream('instrument',handleInstrument)

  ws.addStream('.XBTUSDPI8H', 'quote', data => {
    debugger
  })
}

function handleOrder(data) {
}

function handlePosition(data) {
}

// function handleQuote(data) {
//   console.log('QUOTE', data[0].bidPrice, data[0].askPrice)
//   checkPosition(ws._data.position.XBTUSD[0].currentQty,
//     data[0].bidPrice, data[0].askPrice, entryOrder)
// }

async function handleInstrument(data) {
  var instrument = data[0]
  var bid = instrument.bidPrice
  var ask = instrument.askPrice
  var quote = {
    bidPrice: instrument.bidPrice,
    askPrice: instrument.askPrice
  }
  if (bid !== lastQuote.bidPrice || ask !== lastQuote.askPrice) {
    checkPosition(ws._data.position.XBTUSD[0].currentQty, bid, ask, entryOrder)
  }
  lastQuote = {
    bidPrice: bid,
    askPrice: ask
  }

  var fundingTime = new Date(instrument.fundingTime).getTime()
  var checkFundingPositionTime = fundingTime - 1800000
  var now = new Date().getTime()
  if (now > checkFundingPositionTime) {
    var position = _data.position.XBTUSD[0]
    var fundingStopLoss = await checkFundingPosition(position.currentQty, instrument.fundingRate, bid, ask, entryOrder)
    if (fundingStopLoss) {
      await orderStopLoss('',stopFundingLoss.price,stopFundingLoss.size)
    }
  }
}

function getQuote() {
  return lastQuote
  // return ws._data.quote.XBTUSD[0]
}

function getFunding(instrument) {
  return {
    fundingRate: instrument.fundingRate,
    fundingTimestamp: instrument.fundingTimestamp
  }
}

function getInstrument() {
  return ws._data.instrument.XBTUSD[0]
}

function getPosition() {
  return ws._data.position.XBTUSD[0]
}

function getOpenOrder() {
  if (ws._data.order && ws._data.order.XBTUSD[0].ordStatus == 'New') {
    return ws._data.order.XBTUSD[0]
  }
}

function getOpenOrderMatching(price,size) {
  var openOrder = getOpenOrder()
  if (openOrder && openOrder.price == price && Math.abs(openOrder.orderQty) == Math.abs(size)) {
    return openOrder
  }
}

var stopLossOrderRequesting, takeProfitOrderRequesting

async function orderStopLoss(created,price,size) {
  // FIXME: need to check price and size. if different request new order
  // TODO: implement order queue and only send the latest request
  if (stopLossOrderRequesting) {
    // console.log('stopLossOrderRequesting')
    return
  }

  // var cid = created + 'EXIT-'  
  var cid = ''
  var responseData
  var openStopLossOrder = getOpenOrderMatching(price,size)

  if (openStopLossOrder) {
    //console.log('Order with the same price and size is already opened')
    return

    // Different price or size with the same id
    // if (openOrder.clOrdID == cid) {
    //   console.log('Amend orderStopLoss',cid,price,size)
    //   stopLossOrderRequesting = true
    //   responseData = await amendLimit(cid,price,size) 
    //   stopLossOrderRequesting = false
    //   console.log('orderStopLoss response status', responseData.ordStatus)
    //   return responseData
    // }
  }

  console.log('New orderStopLoss',cid,price,size)
  stopLossOrderRequesting = true
  var responseData = await orderLimitRetry(cid,price,size,EXECINST_REDUCEONLY)
  stopLossOrderRequesting = false
  console.log('orderStopLoss response status', responseData.ordStatus)
  if (responseData.ordStatus == 'Canceled') {
    console.log('Orderbook jumped right back. No need to stop.')
  }
  return responseData
}

async function orderTakeProfit(created,price,size) {
  if (takeProfitOrderRequesting) {
    //console.log('takeProfitOrderRequesting')
    return
  }

  var openTakeProfitOrder = getOpenOrderMatching(price,size)
  if (openTakeProfitOrder) {
    //console.log('Order already opened')
    return
  }

  // var cid = created + 'EXIT+'
  var cid = ''
  console.log('orderTakeProfit',cid,price,size)

  takeProfitOrderRequesting = true
  var responseData = await orderLimitRetry(cid,price,size,EXECINST_REDUCEONLY,RETRYON_CANCELED)
  takeProfitOrderRequesting = false
  console.log('orderTakeProfit response status', responseData.ordStatus)
  return responseData
}

async function checkPosition(positionSize,bid,ask,order) {
  if (positionSize > 0) {  
    if (!order) {
      throw new Error('Error: No order in the memory. Need to load one up.')
      // load existing order
      return
    }

    // LONG
    if (ask <= order.stopLoss) {
      // console.log('LONG STOP LOSS')
      var responseData = await orderStopLoss(order.created,ask,-positionSize)
    }
    else if (ask >= order.takeProfitTrigger) {
      // console.log('LONG TAKE PROFIT')
      var responseData = await orderTakeProfit(order.created,order.takeProfit,-positionSize)
    }
    else {
      // console.log('LONG IN POSITION')
    }
  } 
  else if (positionSize < 0) {
    // SHORT 
    if (bid >= order.stopLoss) {
      // console.log('SHORT STOP LOSS')
      var responseData = await orderStopLoss(order.created,bid,-positionSize)
    }
    else if (bid <= order.takeProfitTrigger) {
      // console.log('SHORT TAKE PROFIT')
      var responseData = await orderTakeProfit(order.created,order.takeProfit,-positionSize)
    }
    else {
      // console.log('SHORT IN POSITION')
    }
  }
  else {
    var openEntryOrder = getOpenOrderMatching(order.entryPrice,order.positionSizeUSD)
    if (openEntryOrder) {
      // Check our order in the orderbook. Cancel the order if it has reached the target.
      if (order.positionSizeUSD > 0) {
        // LONG
        if (ask >= order.takeProfit) {
          console.log('Missed LONG trade', bid, ask, JSON.stringify(openOrder), order)
          debugger
          await cancelAllOrders()
        }
      }
      else {
        // SHORT
        if (bid <= order.takeProfit) {
          console.log('Missed SHORT trade', bid, ask, JSON.stringify(openOrder), order)
          debugger
          await cancelAllOrders()
        }
      }
    }
  }
}

async function checkFundingPosition(positionSizeUSD,fundingRate,bid,ask,order) {
  if (positionSizeUSD > 0) {  
    if (fundingRate > 0) {
      console.log('FUNDING LONG has to pay')
      return {price:ask,size:-positionSizeUSD,fundingRate:fundingRate}
    }
  } 
  else if (positionSizeUSD < 0) {
    if (fundingRate < 0) {
      console.log('FUNDING SHORT has to pay')
      return {price:bid,size:-positionSizeUSD,fundingRate:fundingRate}
    }
  }
  else {
    // Check if there is an open entry order that has to pay funding
    var openEntryOrder = getOpenOrderMatching(order.entryPrice,order.positionSizeUSD)
    if (openEntryOrder && 
      // to avoid stakeoverflow
      openEntryOrder.orderQty !== 0) {
      var fundingStopLoss = await checkFundingPosition(order.positionSizeUSD,fundingRate,bid,ask,order)
      if (fundingStopLoss) {
        await cancelAllOrders()
      }
    }
  }
}

function testCheckPosition() {
  var interval = 500
  var order = {
    entryPrice: 3900,
    positionSizeUSD: 1000,
    stopLossTrigger: 3860.5,
    stopLoss: 3860,
    takeProfitTrigger: 4000.5,
    takeProfit: 40001
  }
  var testArgs1 = [
    [order.positionSizeUSD,order.entryPrice,order.entryPrice+0.5,order],
    [order.positionSizeUSD,order.entryPrice+1,order.entryPrice+1.5,order],
    [order.positionSizeUSD,order.stopLoss,order.stopLoss+0.5,order],
    [order.positionSizeUSD,order.stopLoss,order.stopLoss+0.5,order],
    [order.positionSizeUSD,order.stopLoss+1,order.stopLoss+1.5,order],
    // [order.positionSizeUSD,order.stopLoss-2,order.stopLoss-1.5,order]
  ]
  testArgs1.forEach((args,i) => {
    setTimeout(() => {
      checkPosition.apply(this, args);
    }, interval*(i+1))
  })
}

async function authorize() {
  let swaggerClient = await new SwaggerClient({
    // Switch this to `www.bitmex.com` when you're ready to try it out for real.
    // Don't forget the `www`!
    url: shoes.bitmex.swagger,
    usePromise: true
  })
  // Comment out if you're not requesting any user data.
  swaggerClient.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(shoes.bitmex.key, shoes.bitmex.secret));
  return swaggerClient
}

function inspect(client) {
  console.log("Inspecting BitMEX API...");
  Object.keys(client).forEach(function(model) {
    if (!client[model].operations) return;
    console.log("Available methods for %s: %s", model, Object.keys(client[model].operations).join(', '));
  });
  console.log("------------------------\n");
}

function getPageTimes(interval,length,binSize) {
  var current = new Date()
  var currentMS = current.getTime()
  var offset = (length * interval * 60000) + (currentMS % (interval * 60000))
  var bitMexOffset = binSize * 60000 // bitmet bucket time is one bucket ahead
  offset -= bitMexOffset
  var pageIncrement = 8*60*60000
  var pages = []
  if (offset > pageIncrement) {
    var end = pageIncrement - bitMexOffset
    for (; offset > end; offset-=pageIncrement) {
      pages.push({
        startTime: new Date(currentMS - offset).toISOString(),
        endTime: new Date(currentMS - (offset-pageIncrement+1)).toISOString()
      })
    }
  }
  else {
    pages.push({
      startTime: new Date(currentMS - offset).toISOString(),
      endTime: new Date(currentMS - (offset-(length*interval*60000)+1)).toISOString()
    })
  }
  return pages
}

function toCandle(group) {
  try {
    var open = group[0].open
    let candle = {
      time: group[0].timestamp,
      open: open,
      high: open,
      low: open,
      close: group[group.length-1].close
    }
    candle = group.reduce((a,c) => {
      if (c.high > a.high) a.high = c.high
      if (c.low < a.low) a.low = c.low
      return a
    },candle)
    if (!candle || !candle.open || !candle.close || !candle.high || !candle.low) {
      debugger
    }
    return candle
  }
  catch(e) {
    debugger
  }
}

async function getTradeBucketed(interval,length) {
  let pages = getPageTimes(interval,length,binSize)
  await Promise.all(pages.map(async (page,i) => {
    let response = await client.Trade.Trade_getBucketed({symbol: 'XBTUSD', binSize: binSize+'m', 
      startTime:page.startTime,endTime:page.endTime})
      .catch(error => {
        console.log(error)
        debugger
      })
    page.buckets = JSON.parse(response.data.toString());
  }))
  let buckets = pages.reduce((a,c) => a.concat(c.buckets),[])
  let increment = interval/binSize
  var candles = []
  var opens = [], highs = [], lows = [], closes = []
  for (var i = 0; i < buckets.length; i+=increment) {
    let group = buckets.slice(i,i+increment)
    let candle = toCandle(group)
    candles.push(candle)
    opens.push(candle.open)
    highs.push(candle.high)
    lows.push(candle.low)
    closes.push(candle.close)
  }
  return {
    candles:candles,
    opens:opens,
    highs:highs,
    lows:lows,
    closes:closes
  }
}

async function getMarket(interval,length) {
  if (!marketCache) {
    marketCache = await getTradeBucketed(interval,length)
  }
  else {
    var now = new Date().getTime()
    var candles = marketCache.candles
    // candles[candles.length-1] = candles[candles.length-2]
    var opens = marketCache.opens
    var highs = marketCache.highs
    var lows = marketCache.lows
    var closes = marketCache.closes
    var lastCandle = candles[candles.length-1]
    var lastCandleTime = new Date(lastCandle.time).getTime()
    var missingLength = Math.floor((((now-lastCandleTime)/60000)+binSize)/interval)
    // includes last candle
    var missing = await getTradeBucketed(interval,missingLength)
    
    var firstMissingCandle = missing.candles[0]
    if (firstMissingCandle.time !== lastCandle.time || 
      firstMissingCandle.open !== lastCandle.open || 
      firstMissingCandle.high !== lastCandle.high || 
      firstMissingCandle.low !== lastCandle.low || 
      firstMissingCandle.close !== lastCandle.close) {
      console.log('last candle data mismatched')
    }
    else {
      console.log('last candle data matched')
    }

    candles.splice(0,missingLength-1)
    opens.splice(0,missingLength-1)
    highs.splice(0,missingLength-1)
    lows.splice(0,missingLength-1)
    closes.splice(0,missingLength-1)
    candles.splice(-1,1)
    opens.splice(-1,1)
    highs.splice(-1,1)
    lows.splice(-1,1)
    closes.splice(-1,1)
    marketCache = {
      candles: candles.concat(missing.candles),
      opens: opens.concat(missing.opens),
      highs: highs.concat(missing.highs),
      lows: lows.concat(missing.lows),
      closes: lows.concat(missing.closes)
    }
  }
  return marketCache
}

// async function getPosition() {
//   var response = await client.Position.Position_get()  
//   .catch(function(e) {
//     console.log('Error:', e.statusText)
//     debugger
//   })
//   var positions = JSON.parse(response.data.toString())
//   return positions[0] || {currentQty:0}
// }

async function getMargin() {
  var response = await client.User.User_getMargin()  
  .catch(function(e) {
    console.log('Error:', e.statusText)
    debugger
  })
  var margin = JSON.parse(response.data.toString())
  return margin
}

// async function getOrders() {
//   var response = await client.User.Order_getOrders()  
//   .catch(function(e) {
//     console.log('Error:', e.statusText)
//     debugger
//   })
//   var orders = JSON.parse(response.data.toString())
//   return orders
// }

async function cancelAllOrders() {
  let response = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  .catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Cancelled - All Orders')
}

async function enterStops(order) {
  let candelAllOrdersResponse = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  .catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Cancelled - All Orders')
  
  let stopLossOrderResponse = await client.Order.Order_new({ordType:'StopLimit',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly,ParticipateDoNotInitiate',
    orderQty:-order.positionSizeUSD,
    price:order.stopLoss,
    stopPx:order.stopLossTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - StopLimit Order ')

  let takeProfitOrderResponse = await client.Order.Order_new({ordType:'LimitIfTouched',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly,ParticipateDoNotInitiate',
    orderQty:-order.positionSizeUSD,
    price:order.takeProfit,
    stopPx:order.takeProfitTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - TakeProfitLimit Order ')

  let stopMarketOrderResponse = await client.Order.Order_new({ordType:'StopMarket',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly',
    orderQty:-order.positionSizeUSD,
    stopPx:order.stopMarketTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - StopMarket Order ')
}

async function enter(order,margin) {
  console.log('ENTER ', JSON.stringify(order))

  console.log('Margin', margin.availableMargin/100000000, margin.marginBalance/100000000, margin.walletBalance/100000000)

  var instrument = getInstrument()
  var fundingTime = new Date(instrument.fundingTime).getTime()
  var checkFundingPositionTime = fundingTime - 1800000
  var now = new Date().getTime()
  if (now > checkFundingPositionTime) {
    var fundingStopLoss = await checkFundingPosition(order.positionSizeUSD,instrument.fundingRate)
    if (fundingStopLoss) {
      console.log('FUNDING STOP ENTER',JSON.stringify(fundingStopLoss))
      return
    }
  }

  cancelAllOrders()

  let updateLeverageResponse = await client.Position.Position_updateLeverage({symbol:'XBTUSD',leverage:order.leverage})
  .catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Updated - Leverage ')

  entryOrder = order
  pendingStopLossOrder = null
  var responseData = await orderLimitRetry(order.created+'ENTER',order.entryPrice,order.positionSizeUSD,'',RETRYON_CANCELED)
  console.log('ENTER response status', responseData.ordStatus)
  if (responseData.ordStatus === 'Canceled') {
    return false
  }

  log.writeEntryOrder(order)
  return true
}

async function wait(ms) {
  return new Promise((resolve,reject) => {
    setTimeout(_ => resolve(true), ms)
  })
}

async function orderLimitRetry(cid,price,size,execInst,retryOn) {
  retryOn += 'Overloaded'
  let responseData, 
      count = 0,
      waitTime = 2
  do {
    responseData = await orderLimit(cid,price,size,execInst)
    count++
    waitTime *= 2
    // if cancelled retry with new quote 
    // this means the quote move to a better price before the order reaches bitmex server
  } while((retryOn.indexOf(responseData.ordStatus) >= 0) && count < 10 && await wait(waitTime))
  return responseData
}

async function orderLimit(cid,price,size,execInst) {
  return new Promise(async (resolve,reject) => {
    if (size > 0) {
      if (price > lastQuote.bidPrice) {
        price = lastQuote.bidPrice
      }
    }
    else {
      if (price < lastQuote.askPrice) {
        price = lastQuote.askPrice
      }
    }
  
    let response 
    response = await client.Order.Order_new({ordType:'Limit',symbol:'XBTUSD',
      clOrdID: cid,
      price:price,
      orderQty:size,
      execInst:'ParticipateDoNotInitiate'+(execInst||'')
    }).catch(function(e) {
      console.log(e.statusText)
      if (e.statusText && e.statusText.indexOf('The system is currently overloaded') >= 0) {
        resolve({ordStatus:'Overloaded'})
      }
      else {
        debugger
      }
    })

    if (response && response.data) {
      var data = JSON.parse(response.data)
      console.log('Limit Order', response.data, JSON.stringify(lastQuote))
      resolve(data)
    }

    resolve({})
  })
}

async function getTradeHistory(startTime) {
  let response = await client.Execution.Execution_getTradeHistory({symbol: 'XBTUSD',
  startTime: new Date(startTime).toISOString(),
  columns:'commission,execComm,execCost,execType,foreignNotional,homeNotional,orderQty,lastQty,cumQty,price,ordType,ordStatus'
  })
  .catch(error => {
    console.log(error)
    debugger
  })
  let data = JSON.parse(response.data)
  data.forEach(d => {
    console.log(d.timestamp,d.execType,d.price,d.orderQty)
  })
  debugger
}

async function getFundingHistory(startTime) {
  let response = await client.Funding.Funding_get({symbol: 'XBTUSD',
  startTime: new Date(startTime).toISOString()
  })
  .catch(error => {
    console.log(error)
    debugger
  })
  let data = JSON.parse(response.data)
  data.forEach(d => {
    console.log(d.timestamp,d.price,d.orderQty)
  })
  debugger
}

async function getOrders() {
  let response = await client.Order.Order_getOrders({symbol: 'XBTUSD',
  startTime: new Date(1552176000000).toISOString(),
  // columns:null
  })
  .catch(error => {
    console.log(error)
    debugger
  })
  let data = JSON.parse(response.data)
  debugger
}

async function init(exitTradeCb) {
  exitTradeCallback = exitTradeCb
  client = await authorize().catch(e => {
    console.error(e)
    debugger
  })
  entryOrder = log.readEntryOrder()
  await wsConnect()

  // inspect(client.apis)
  // await getOrderBook()
  // await getOrders()

  // var openOrder = getOpenOrder()
  // debugger

  var yesterday = new Date().getTime() - (48*60*60000)
  // await getTradeHistory(yesterday)
  // await getFundingHistory(yesterday)
  // await getInstrument()

  // await orderLimitRetry('',3888,1000,'',RETRYON_CANCELED)
  // debugger
  // testCheckPosition()
}

module.exports = {
  init: init,
  getMarket: getTradeBucketed,
  getPosition: getPosition,
  getMargin: getMargin,
  getQuote: getQuote,
  enter: enter
}