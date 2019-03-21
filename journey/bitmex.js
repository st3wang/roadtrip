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
var entryOrder, lastInstrument = {}, lastPosition = {}, lastOrders = []

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
      console.log(table + ' timeout')
      clearInterval(checkValueInterval)
      resolve()
    }, 3000)
  })
} catch(e) {console.error(e.stack||e);debugger} }

async function wsConnect() { try {
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
  heartbeat()

  await wsAddStream('order',handleOrder)
  await wsAddStream('position',handlePosition)
  await wsAddStream('instrument',handleInstrument)

  ws.addStream('.XBTUSDPI8H', 'quote', data => {
    debugger
  })
} catch(e) {console.error(e.stack||e);debugger} }

function handleOrder(data) {
  lastOrders = data
  lastOrders.forEach((order,i) => {
    console.log('ORDER',i,order.ordStatus,order.ordType,order.side,order.price,order.orderQty)
  })
}

function handlePosition(data) {
  lastPosition = data[0]
  // if (data[0].leverage !== entryOrder.leverage) {
  //   console.log('handlePosition existing leverage',data[0].leverage,'entryOrder leverage',entryOrder.leverage)
  //   updateLeverage(entryOrder.leverage)
  // }
}

function isFundingWindow(instrument) {
  var fundingTime = new Date(instrument.fundingTimestamp).getTime()
  var checkFundingPositionTime = fundingTime - 1800000
  var now = new Date().getTime()
  return (now > checkFundingPositionTime)
}

function startNextCandle() {
  var now = new Date().getTime()
  var candleTimeOffset = now % 900000
  var currentCandleTime = now - candleTimeOffset
  var currentCandleISOString = new Date(currentCandleTime).toISOString()

  if (marketCache.candles[marketCache.candles.length-1].time == currentCandleISOString) {
    return
  }

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
        lastCandle.lows[lastIndex] = lastCandle.low = price
      }
      if (time > lastCandle.lastTradeTimeMs) {
        lastCandle.lastTradeTimeMs = time
        lastCandle.closes[lastIndex] = lastCandle.close = price
      }
    }
  }
}

async function handleInstrument(data) { try {
  var instrument = data[0]
  var bid = instrument.bidPrice
  var ask = instrument.askPrice
  var price = instrument.lastPrice

  var now = new Date().getTime()
  var candleTimeOffset = now % 900000
  if (candleTimeOffset >= currentCandleTimeOffset) {
    addTradeToCandle(new Date(instrument.timestamp).getTime(),price)
  }
  else {
    startNextCandle()
  }
  currentCandleTimeOffset = candleTimeOffset
  
  if (bid !== lastInstrument.bidPrice || ask !== lastInstrument.askPrice) {
    checkPosition(lastPosition.currentQty, bid, ask, entryOrder)
  }

  if (isFundingWindow(instrument)) {
    var fundingStopLoss = await checkFundingPosition(lastPosition.currentQty, instrument.fundingRate, bid, ask, entryOrder)
    if (fundingStopLoss) {
      await orderStopLoss('',fundingStopLoss.price,fundingStopLoss.size)
    }
  }
  lastInstrument = instrument
} catch(e) {console.error(e.stack||e);debugger} }

function getNextFunding() {
  return {
    fundingRate: lastInstrument.fundingRate,
    timestamp: lastInstrument.fundingTimestamp
  }
}

function getInstrument() {
  return ws._data.instrument.XBTUSD[0]
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

function getOpenLimitOrderMatching(price,size) {
  size = Math.abs(size)
  return lastOrders.find(order => {
    return (order.ordStatus == 'New' && order.ordType == 'Limit' && 
      order.price == price && openLimitOrder.orderQty == size)
  })
}

var stopLossOrderRequesting, takeProfitOrderRequesting

async function orderStopLoss(created,price,size) { try {
  // FIXME: need to check price and size. if different request new order
  // TODO: implement order queue and only send the latest request
  if (stopLossOrderRequesting) {
    // console.log('stopLossOrderRequesting')
    return
  }

  // var cid = created + 'EXIT-'  
  var cid = ''
  var responseData
  var openStopLossOrder = getOpenLimitOrderMatching(price,size)

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
  var responseData = await orderLimitRetry(cid,price,size,EXECINST_REDUCEONLY,RETRYON_CANCELED)
  stopLossOrderRequesting = false
  console.log('orderStopLoss response status', responseData.ordStatus)
  // if (responseData.ordStatus == 'Canceled') {
  //   console.log('Orderbook jumped right back. No need to stop.')
  // }
  return responseData
} catch(e) {console.error(e.stack||e);debugger} }

async function orderTakeProfit(created,price,size) { try {
  if (takeProfitOrderRequesting) {
    //console.log('takeProfitOrderRequesting')
    return
  }

  var openTakeProfitOrder = getOpenLimitOrderMatching(price,size)
  if (openTakeProfitOrder) {
    //console.log('Order already opened')
    return
  }

  // var cid = created + 'EXIT+'
  var cid = ''
  console.log('New orderTakeProfit',cid,price,size)

  takeProfitOrderRequesting = true
  var responseData = await orderLimitRetry(cid,price,size,EXECINST_REDUCEONLY,RETRYON_CANCELED)
  takeProfitOrderRequesting = false
  console.log('orderTakeProfit response status', responseData.ordStatus)
  return responseData
} catch(e) {console.error(e.stack||e);debugger} }

async function checkPosition(positionSize,bid,ask,order) { try {
  if (positionSize > 0) {  
    if (!order) {
      throw new Error('Error: No order in the memory. Need to load one up.')
      // load existing order
      return
    }

    // LONG
    if (ask <= order.stopLoss) {
      // console.log('LONG STOP LOSS')
      // use ask for chasing stop loss
      var responseData = await orderStopLoss(order.created,order.stopLoss,-positionSize)
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
      // use bid for chasing stop loss
      var responseData = await orderStopLoss(order.created,order.stopLoss,-positionSize)
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
    var openEntryOrder = order ? getOpenLimitOrderMatching(order.entryPrice,order.positionSizeUSD) : null
    if (openEntryOrder) {
      // Check our order in the orderbook. Cancel the order if it has reached the target.
      if (order.positionSizeUSD > 0) {
        // LONG
        if (ask >= order.takeProfit) {
          console.log('Missed LONG trade', bid, ask, JSON.stringify(openEntryOrder), order)
          await cancelAllOrders()
        }
      }
      else {
        // SHORT
        if (bid <= order.takeProfit) {
          console.log('Missed SHORT trade', bid, ask, JSON.stringify(openEntryOrder), order)
          await cancelAllOrders()
        }
      }
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

async function checkFundingPosition(positionSizeUSD,fundingRate,bid,ask,order) { try {
  if (positionSizeUSD > 0) {  
    if (fundingRate > 0) {
      return {price:ask,size:-positionSizeUSD,fundingRate:fundingRate}
    }
  } 
  else if (positionSizeUSD < 0) {
    if (fundingRate < 0) {
      return {price:bid,size:-positionSizeUSD,fundingRate:fundingRate}
    }
  }
  else {
    // Check if there is an open entry order that has to pay funding
    var openEntryOrder = getOpenLimitOrderMatching(order.entryPrice,order.positionSizeUSD)
    if (openEntryOrder && 
      // to avoid stakeoverflow
      openEntryOrder.orderQty !== 0) {
      var fundingStopLoss = await checkFundingPosition(order.positionSizeUSD,fundingRate,bid,ask,order)
      if (fundingStopLoss) {
        await cancelAllOrders()
      }
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }

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

async function authorize() { try {
  let swaggerClient = await new SwaggerClient({
    // Switch this to `www.bitmex.com` when you're ready to try it out for real.
    // Don't forget the `www`!
    url: shoes.bitmex.swagger,
    usePromise: true
  })
  // Comment out if you're not requesting any user data.
  swaggerClient.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(shoes.bitmex.key, shoes.bitmex.secret));
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

async function getTradeBucketed(interval,length) { try {
  let pages = getPageTimes(interval,length,binSize)
  await Promise.all(pages.map(async (page,i) => {
    let response = await client.Trade.Trade_getBucketed({symbol: 'XBTUSD', binSize: binSize+'m', 
      startTime:page.startTime,endTime:page.endTime})
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
} catch(e) {console.error(e.stack||e);debugger} }

async function getMarket(interval,length) { try {
  if (marketCache) {
    // update current candle
    handleInstrument(ws._data.instrument.XBTUSD)
  }
  else {
    marketCache = await getTradeBucketed(interval,length)
  }
  return marketCache
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

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

async function cancelAllOrders() { try {
  console.log('Cancelling All Orders')
  let response = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  console.log('Cancelled All Orders')
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function updateLeverage(leverage) { try {
  console.log('Updating Leverage',leverage)
  let response = await client.Position.Position_updateLeverage({symbol:'XBTUSD',leverage:leverage})
  console.log('Updated Leverage ')
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function enter(order,margin) { try {
  console.log('Margin','available',margin.availableMargin/100000000,'balance',margin.marginBalance/100000000,'wallet',margin.walletBalance/100000000)

  if (lastPosition.currentQty != 0) {
    console.log('Already in a position',lastPosition.currentQty)
    return
  }

  if (isFundingWindow(lastInstrument)) {
    var fundingStopLoss = await checkFundingPosition(order.positionSizeUSD,lastInstrument.fundingRate)
    if (fundingStopLoss) {
      console.log('Funding ' + order.type + ' has to pay. Do not enter.',JSON.stringify(fundingStopLoss))
      return
    }
  }

  await cancelAllOrders()

  console.log('ENTER ', JSON.stringify(order))

  let responseData = await orderLimitRetry(order.created+'ENTER',order.entryPrice,order.positionSizeUSD,'',RETRYON_CANCELED)
  if (responseData.ordStatus === 'Canceled' || responseData.ordStatus === 'Overloaded') {
    return false
  }

  entryOrder = order
  await orderStopMarket(order.stopMarketTrigger,-order.positionSizeUSD)
  log.writeEntryOrder(order)

  return true
} catch(e) {console.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

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
} catch(e) {console.error(e.stack||e);debugger} }

async function initOrders() { try {
  entryOrder = log.readEntryOrder()
} catch(e) {console.error(e.stack||e);debugger} }

async function init(exitTradeCb) { try {
  exitTradeCallback = exitTradeCb
  client = await authorize()
  await initMarket()
  await updateLeverage(0) // cross margin

  // inspect(client.apis)
  // await getTradeHistory()
  await initOrders()
  await wsConnect()

  // await getOrderBook()

  // await getFundingHistory(yesterday)
  // await getInstrument()
  // await getOrders(yesterday)

  // await orderLimitRetry('',3888,1000,'',RETRYON_CANCELED)
  // debugger
  // testCheckPosition()
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  init: init,
  getMarket: getMarket,
  getPosition: getPosition,
  getMargin: getMargin,
  getQuote: getQuote,
  enter: enter,
  getOrders: getOrders,
  getTradeHistory: getTradeHistory,
  getFundingHistory: getFundingHistory,
  getCurrentCandle: getCurrentCandle,
  getNextFunding: getNextFunding
}