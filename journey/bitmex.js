const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const shoes = require('./shoes')
const log = require('./log')

const BitMEXRealtimeAPI = require('bitmex-realtime-api')

const EXECINST_REDUCEONLY = ',ReduceOnly'
const RETRYON_CANCELED = 'Canceled'

var client, checkPositionCallback, marketCache, marketWithCurrentCandleCache
var binSize = 5

var ws, wsHeartbeatTimeout
var lastInstrument = {}, lastPosition = {}, lastOrders = []
var lastBid, lastAsk, lastQty

var currentCandle, currentCandleTimeOffset

function heartbeat() {
  setInterval(_ => {
    ws.socket.send('ping')
  },60000)
}

async function wsAddStream(table, handler) { try {
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
      clearInterval(checkValueInterval)
      reject()
    }, 5000)
  })
} catch(e) {console.error(e.stack||e);debugger} }

async function connect() { try {
  ws = new BitMEXRealtimeAPI({
    testnet: shoes.bitmex.test,
    apiKeyID: shoes.bitmex.key,
    apiKeySecret: shoes.bitmex.secret,
    maxTableLen:100
  })
  ws.on('error', console.error);
  ws.on('open', () => console.log('Connection opened.'));
  ws.on('close', () => console.log('Connection closed.'));
  // ws.on('initialize', () => console.log('Client initialized, data is flowing.'));

  var newOrders = await getNewOrders()
  if (newOrders.length == 0) {
    // Order stream will not work without an open order.
    // It's okay to leave this dummy stop market around.
    // It will get canceled later.
    console.log('Adding dummy stop market')
    await orderStopMarket(1,-1)
  }
  await wsAddStream('order',handleOrder)
  await wsAddStream('position',handlePosition)
  await wsAddStream('instrument',handleInstrument)

  heartbeat()
} catch(e) {console.error(e.stack||e);debugger} }

async function pruneCanceledOrders(orders) {
  var found, pruned
  do {
    found = orders.findIndex(order => {return order.ordStatus == 'Canceled'})
    if (found >= 0) {
      orders.splice(found,1)
      pruned = true
    }
  } while(found >= 0)
  return pruned
}

async function handleOrder(data) { try {
  lastOrders = data
  lastOrders.forEach((order,i) => {
    console.log('ORDER '+i,order.ordStatus,order.ordType,order.side,order.price,order.orderQty)
  })

  if (!pruneCanceledOrders(data)) {
    checkPositionCallback(lastInstrument.timestamp, lastPosition.currentQty, 
      lastInstrument.bidPrice, lastInstrument.askPrice, lastInstrument.fundingTimestamp, lastInstrument.fundingRate)
  }
} catch(e) {console.error(e.stack||e);debugger} }

function handlePosition(data) {
  lastPosition = data[0]

  var qty = lastPosition.currentQty
  if (qty != lastQty) {
    console.log('position',lastPosition.currentQty)
    checkPositionCallback(lastInstrument.timestamp, lastPosition.currentQty, 
      lastInstrument.bidPrice, lastInstrument.askPrice, lastInstrument.fundingTimestamp, lastInstrument.fundingRate)
  }

  lastQty = lastPosition.currentQty
}

async function appendCandleLastPrice() {
  var candleTimeOffset = getCandleTimeOffset()
  if (candleTimeOffset >= currentCandleTimeOffset) {
    addTradeToCandle(new Date(lastInstrument.timestamp).getTime(),lastInstrument.lastPrice)
  }
  else {
    startNextCandle()
  }
  currentCandleTimeOffset = candleTimeOffset
}

async function handleInstrument(data) { try {
  lastInstrument = data[0]
  
  var bid = lastInstrument.bidPrice
  var ask = lastInstrument.askPrice

  appendCandleLastPrice()
  
  if (bid !== lastBid || ask !== lastAsk) {
    checkPositionCallback(lastInstrument.timestamp, lastPosition.currentQty, 
      bid, ask, lastInstrument.fundingTimestamp, lastInstrument.fundingRate)
  }

  lastBid = bid
  lastAsk = ask
} catch(e) {console.error(e.stack||e);debugger} }

function getCandleTimeOffset() {
  return ((new Date().getTime()) % 900000)
}

function startNextCandle() {
  var now = new Date().getTime()
  var candleTimeOffset = now % 900000
  var currentCandleTime = now - candleTimeOffset
  var currentCandleISOString = new Date(currentCandleTime).toISOString()

  if (marketCache.candles[marketCache.candles.length-1].time == currentCandleISOString) {
    return
  }

  marketWithCurrentCandleCache = null

  marketCache.opens.shift()
  marketCache.highs.shift()
  marketCache.lows.shift()
  marketCache.closes.shift()
  marketCache.candles.shift()

  marketCache.opens.push(currentCandle.open)
  marketCache.highs.push(currentCandle.high)
  marketCache.lows.push(currentCandle.low)
  marketCache.closes.push(currentCandle.close)
  marketCache.candles.push(currentCandle)

  let open = currentCandle.close
  currentCandle = {
    time:currentCandleISOString,
    startTimeMs: currentCandleTime,
    endTimeMs: currentCandleTime + 899999,
    lastTradeTimeMs: currentCandleTime,
    open:open, high:open, low:open, close: open
  }
}

function addTradeToCandle(time,price) {
  if (!time || !price) return

  if (time >= currentCandle.startTimeMs && time <= currentCandle.endTimeMs) {
    if (price > currentCandle.high) {
      currentCandle.high = price
    }
    else if (price < currentCandle.low) {
      currentCandle.low = price
    }
    if (time > currentCandle.lastTradeTimeMs) {
      currentCandle.lastTradeTimeMs = time
      currentCandle.close = price
    }
  }
  else {
    let lastIndex = marketCache.candles.length - 1
    let lastCandle = marketCache.candles[lastIndex]
    // console.log('add trade to lastCandle', new Date().toISOString(), new Date(time).toISOString(), price, JSON.stringify(lastCandle))
    if (time >= lastCandle.startTimeMs && time <= lastCandle.endTimeMs) {
      if (price > lastCandle.high) {
        marketCache.highs[lastIndex] = lastCandle.high = price
      }
      else if (price < lastCandle.low) {
        marketCache.lows[lastIndex] = lastCandle.low = price
      }
      if (time > lastCandle.lastTradeTimeMs) {
        lastCandle.lastTradeTimeMs = time
        marketCache.closes[lastIndex] = lastCandle.close = price
      }
    }
  }
}

function getNextFunding() {
  return {
    fundingRate: lastInstrument.fundingRate,
    timestamp: lastInstrument.fundingTimestamp
  }
}

function getInstrument() {
  return lastInstrument
}

function getPosition() {
  return lastPosition
}

function getQuote() {
  return {
    bidPrice: lastInstrument.bidPrice,
    askPrice: lastInstrument.askPrice
  }
}

function findNewLimitOrder(price,size) {
  size = Math.abs(size)
  return lastOrders.find(order => {
    return (order.ordStatus == 'New' && order.ordType == 'Limit' && 
      order.price == price && order.orderQty == size)
  })
}

var exitRequesting

// async function orderStopLoss(created,price,size) { try {
//   // FIXME: need to check price and size. if different request new order
//   // TODO: implement order queue and only send the latest request
//   if (stopLossOrderRequesting) {
//     // console.log('stopLossOrderRequesting')
//     return
//   }

//   // var cid = created + 'EXIT-'  
//   var cid = ''
//   var responseData
//   var openStopLossOrder = getNewLimitOrderMatching(price,size)

//   if (openStopLossOrder) {
//     //console.log('Order with the same price and size is already opened')
//     return

//     // Different price or size with the same id
//     // if (openOrder.clOrdID == cid) {
//     //   console.log('Amend orderStopLoss',cid,price,size)
//     //   stopLossOrderRequesting = true
//     //   responseData = await amendLimit(cid,price,size) 
//     //   stopLossOrderRequesting = false
//     //   console.log('orderStopLoss response status', responseData.ordStatus)
//     //   return responseData
//     // }
//   }

//   console.log('New orderStopLoss',cid,price,size)
//   stopLossOrderRequesting = true
//   var responseData = await orderLimitRetry(cid,price,size,EXECINST_REDUCEONLY,RETRYON_CANCELED)
//   stopLossOrderRequesting = false
//   console.log('orderStopLoss response status', responseData.ordStatus)
//   // if (responseData.ordStatus == 'Canceled') {
//   //   console.log('Orderbook jumped right back. No need to stop.')
//   // }
//   return responseData
// } catch(e) {console.error(e.stack||e);debugger} }

async function authorize() { try {
  console.log('Authorizing')
  let swaggerClient = await new SwaggerClient({
    url: shoes.bitmex.swagger,
    usePromise: true
  })
  swaggerClient.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(shoes.bitmex.key, shoes.bitmex.secret));
  console.log('Authorized')
  return swaggerClient
} catch(e) {console.error(e.stack||e);debugger} }

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
  var open = group[0].open
  let timeMs = new Date(group[0].timestamp).getTime()-300000
  let candle = {
    time: new Date(timeMs).toISOString(),
    startTimeMs: timeMs,
    endTimeMs: timeMs + 899999,
    lastTradeTimeMs: timeMs + 899999,
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

async function getCurrentTradeBucketed(interval) { try {
  interval = interval || 15
  let now = new Date().getTime()
  let candleTimeOffset = now % (interval*60000)
  let startTime = new Date(now - candleTimeOffset + 60000).toISOString()
  let response = await client.Trade.Trade_getBucketed({symbol:'XBTUSD', binSize:'1m', 
    startTime:startTime
  })
  var buckets = JSON.parse(response.data.toString());
  var candle = {}
  if (buckets && buckets[0]) {
    candle = toCandle(buckets)
  }
  let timeMs = now-candleTimeOffset
  candle.time = new Date(timeMs).toISOString()
  candle.startTimeMs = timeMs
  candle.endTimeMs = timeMs + 899999
  candle.lastTradeTimeMs = timeMs // accepting new trade data
  // debugger
  return {candle:candle,candleTimeOffset:candleTimeOffset}
} catch(e) {console.error(e.stack||e); debugger} }

var getTradeBucketedRequesting 

async function getTradeBucketed(interval,length) { try {
  if (getTradeBucketedRequesting) {
    await getTradeBucketedRequesting
  }
  let pages = getPageTimes(interval,length,binSize)
  getTradeBucketedRequesting = Promise.all(pages.map(async (page,i) => {
    let response = await client.Trade.Trade_getBucketed({symbol: 'XBTUSD', binSize: binSize+'m', 
      startTime:page.startTime,endTime:page.endTime})
    page.buckets = JSON.parse(response.data.toString());
  }))
  await getTradeBucketedRequesting
  getTradeBucketedRequesting = null
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
} catch(e) {console.error(e.stack||e);debugger} }

async function getMarket(interval,length) { try {
  if (marketCache) {
    // update current candle
    appendCandleLastPrice()
  }
  else {
    marketCache = await getTradeBucketed(interval,length)
  }
  return marketCache
} catch(e) {console.error(e.stack||e);debugger} }

async function getMarketWithCurrentCandle(interval,length) { try {
  appendCandleLastPrice()
  if (marketWithCurrentCandleCache) {
    let lastIndex = marketWithCurrentCandleCache.candles.length - 1
    marketWithCurrentCandleCache.candles[lastIndex] = currentCandle
    marketWithCurrentCandleCache.opens[lastIndex] = currentCandle.open
    marketWithCurrentCandleCache.highs[lastIndex] = currentCandle.high
    marketWithCurrentCandleCache.lows[lastIndex] = currentCandle.low
    marketWithCurrentCandleCache.closes[lastIndex] = currentCandle.close
  }
  else {
    var market = await getMarket(15,96)
    var candles = market.candles.slice(1)
    var opens = market.opens.slice(1)
    var highs = market.highs.slice(1)
    var lows = market.lows.slice(1)
    var closes = market.closes.slice(1)
  
    candles.push(currentCandle)
    opens.push(currentCandle.open)
    highs.push(currentCandle.high)
    lows.push(currentCandle.low)
    closes.push(currentCandle.close)
    marketWithCurrentCandleCache = {candles: candles, opens: opens, highs: highs, lows: lows, closes: closes}
  }
  return marketWithCurrentCandleCache
} catch(e) {console.error(e.stack||e);debugger} }

async function getMargin() { try {
  var response = await client.User.User_getMargin() 
  var margin = JSON.parse(response.data.toString())
  return margin
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getTradeHistory(startTime) { try {
  startTime = startTime || (new Date().getTime() - (24*60*60000))
  let response = await client.Execution.Execution_getTradeHistory({symbol: 'XBTUSD',
  startTime: new Date(startTime).toISOString(),
  columns:'commission,execComm,execCost,execType,foreignNotional,homeNotional,orderQty,lastQty,cumQty,price,ordType,ordStatus'
  })
  let data = JSON.parse(response.data)
  data.forEach(d => {
    console.log(d.timestamp,d.execType,d.price,d.orderQty)
  })
  debugger
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getFundingHistory(startTime) { try {
  startTime = startTime || (new Date().getTime() - (24*60*60000))
  let response = await client.Funding.Funding_get({symbol: 'XBTUSD',
  startTime: new Date(startTime).toISOString()
  })
  let data = JSON.parse(response.data)
  // data.forEach(d => {
  //   console.log(d.timestamp,d.fundingRate)
  // })
  // debugger
  return data
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getNewOrders(startTime) { try {
  startTime = startTime || (new Date().getTime() - (24*60*60000))
  let response = await client.Order.Order_getOrders({symbol: 'XBTUSD',
    startTime: new Date(startTime).toISOString(),
    filter: '{"ordStatus":"New"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType'
  })
  let orders = JSON.parse(response.data)
  return orders
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getOrders(startTime) { try {
  startTime = startTime || (new Date().getTime() - (24*60*60000))
  let response = await client.Order.Order_getOrders({symbol: 'XBTUSD',
    startTime: new Date(startTime).toISOString(),
    // filter: '{"ordType":"Limit"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType'
  })
  let orders = JSON.parse(response.data)
  orders = orders.filter(order => {
    return (order.ordStatus != 'Canceled' && order.ordType != 'Funding')
  })
  return orders
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getCurrentCandle() {
  return currentCandle
}

async function cancelAll() { try {
  console.log('Cancelling All Orders')
  let response = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  console.log('Cancelled All Orders')
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function updateLeverage(leverage) { try {
  console.log('Updating Leverage',leverage)
  let response = await client.Position.Position_updateLeverage({symbol:'XBTUSD',leverage:leverage})
  console.log('Updated Leverage ')
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function enter(signal) { try {
  await cancelAll()

  console.log('ENTER ', JSON.stringify(signal))

  let responseData = await orderLimitRetry(signal.timestamp+'ENTER',signal.entryPrice,signal.positionSizeUSD,'',RETRYON_CANCELED)
  if (responseData.ordStatus === 'Canceled' || responseData.ordStatus === 'Overloaded') {
    return false
  }

  await orderStopMarket(signal.stopMarketTrigger,-signal.positionSizeUSD)

  return true
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function exit(timestamp,price,size) { try {
  if (!price || !size || exitRequesting) {
    //console.log('exitRequesting')
    return
  }

  var newExitOrder = findNewLimitOrder(price,size)
  if (newExitOrder) {
    //console.log('Order already submitted')
    return
  }

  // var cid = timestamp + 'EXIT+'
  var cid = ''
  console.log('New exit',cid,price,size)

  exitRequesting = true
  var responseData = await orderLimitRetry(cid,price,size,EXECINST_REDUCEONLY,RETRYON_CANCELED)
  exitRequesting = false
  console.log('EXIT response status', responseData.ordStatus)
  return responseData
} catch(e) {console.error(e.stack||e);debugger} }

async function wait(ms) {
  return new Promise((resolve,reject) => {
    setTimeout(_ => resolve(true), ms)
  })
}

async function orderLimitRetry(cid,price,size,execInst,retryOn) { try {
  console.log('Ordering limit retry')
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
  console.log('Ordered limit retry status', responseData.ordStatus)
  return responseData
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderLimit(cid,price,size,execInst) { 
  return new Promise(async (resolve,reject) => { try {
    console.log('Ordering limit',price,size,execInst)
    if (size > 0) {
      if (price > lastInstrument.bidPrice) {
        console.log('orderLimit price',price,'is more than last bidPrice',lastInstrument.bidPrice)
        price = lastInstrument.bidPrice
      }
    }
    else {
      if (price < lastInstrument.askPrice) {
        console.log('orderLimit price',price,'is less than last askPrice',lastInstrument.askPrice)
        price = lastInstrument.askPrice
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

    let data = {}
    if (response && response.data) {
      data = JSON.parse(response.data)
      console.log('Ordered Limit', response.data)
    }
    else {
      console.log('Failed order limit')
    }

    resolve(data)
  } catch(e) {console.error(e.stack||e);debugger} })
}

async function orderStopMarket(price,size) { try {
  console.log('Ordering stop market')
  let response = await client.Order.Order_new({ordType:'StopMarket',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly',
    orderQty:size,
    stopPx:price 
  })
  let responseData = JSON.parse(response.data)
  console.log('Ordered stop market',responseData.ordStatus)
} catch(e) {console.error(e.stack||e);debugger} }

async function initMarket() { try {
  console.log('Initializing market')
  await getMarket(15,96)
  let currentTradeBucketed = await getCurrentTradeBucketed()
  currentCandleTimeOffset = currentTradeBucketed.candleTimeOffset
  if (currentTradeBucketed.candle.open) {
    currentCandle = currentTradeBucketed.candle
  }
  else {
    currentCandle = {}
    var open = marketCache.closes[marketCache.closes.length-1]
    currentCandle.open = currentCandle.high = currentCandle.low = currentCandle.close = open
  }
  console.log('Initialized market')
} catch(e) {console.error(e.stack||e);debugger} }

async function init(checkPositionCb) { try {
  checkPositionCallback = checkPositionCb
  client = await authorize()
  await initMarket()
  await updateLeverage(0) // cross margin

  // inspect(client.apis)
  // await getTradeHistory()
  await connect()

  // await getOrderBook()

  // await getFundingHistory(yesterday)
  // await getInstrument()
  // await getOrders(yesterday)
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  init: init,
  getMarket: getMarket,
  getMarketWithCurrentCandle: getMarketWithCurrentCandle,
  getPosition: getPosition,
  getInstrument: getInstrument,
  getMargin: getMargin,
  getQuote: getQuote,

  getOrders: getOrders,
  getTradeHistory: getTradeHistory,
  getFundingHistory: getFundingHistory,
  getCurrentCandle: getCurrentCandle,
  getNextFunding: getNextFunding,

  findNewLimitOrder: findNewLimitOrder,
  getCandleTimeOffset: getCandleTimeOffset,

  enter: enter,
  exit: exit,
  cancelAll: cancelAll
}