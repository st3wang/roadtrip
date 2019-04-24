const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const BitMEXRealtimeAPI = require('bitmex-realtime-api')
const winston = require('winston')
const shoes = require('./shoes')
const {symbol,account,setup} = shoes
const oneCandleMS = setup.candle.interval*60000
const candleLengthMS = setup.candle.interval*setup.candle.length*60000

var client, checkPositionCallback, checkPositionParams = {}
var marketCache, marketWithCurrentCandleCache
var binSize = 1
if (setup.candle.interval >= 5) {
  binSize = 5
}

var ws
var lastMargin = {}, lastInstrument = {}, lastPosition = {}, lastOrders = [], lastXBTUSDInstrument = {}
var lastBid, lastAsk, lastQty, lastRates = {}

var currentCandle, currentCandleTimeOffset

const colorizer = winston.format.colorize();

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date().toISOString()
  return info;
});

function orderString({ordStatus,ordType,side,cumQty,orderQty,price=NaN,stopPx,execInst}) {
  return ordStatus+' '+ordType+' '+side+' '+cumQty+'/'+orderQty+' '+price+' '+stopPx+' '+execInst
}

function orderStringBulk(orders) {
  if (orders.reduce) {
    return orders.reduce((a,c) => {
      return a + '\n' + orderString(c)
    },'')
  }
  else {
    return orderString(orders)
  }
}

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
          let prefix = timestamp.substring(5).replace(/[T,Z]/g,' ')+'['+colorizer.colorize(level,'bmx')+'] '
          let line = (typeof message == 'string' ? message : JSON.stringify(message)) + ' '
          switch(message) {
            case 'orderNewBulk':
            case 'orderAmendBulk':
            case 'orderBulkRetry':
            case 'orderQueue':
            case 'order': {
              line += (splat[0].obj ? orderStringBulk(splat[0].obj) : ('splat[0].obj is null ' + JSON.stringify(splat[0])))
            } break
            case 'cancelAll': {
              line += splat[0].obj.length
            } break
            case 'handleOrder':
            case 'pruneOrders': {
              line += (splat[0] ? orderString(splat[0]) : 'splat[0] is null')
            } break
            case 'orderNewBulk error':
            case 'orderAmendBulk error': {
              let {status,obj} = splat[0]
              line += status + ' ' + obj.error.message + ' ' + JSON.stringify(splat[1])
            } break
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

function heartbeat() {
  setInterval(_ => {
    ws.socket.send('ping')
  },60000)
}

async function wsAddStream(sym, table, handler) { try {
  console.log('wsAddStream',sym,table)
  ws.addStream(sym, table, handler)
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
      reject('wsAddStream '+table+' timeout')
    }, 5000)
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function connect() { try {
  ws = new BitMEXRealtimeAPI({
    testnet: shoes.test,
    apiKeyID: account.key,
    apiKeySecret: account.secret,
    maxTableLen:100
  })
  ws.on('error', (e) => logger.error(e));
  ws.on('open', () => console.log('Connection opened.'));
  ws.on('close', () => console.log('Connection closed.'));
  // ws.on('initialize', () => console.log('Client initialized, data is flowing.'));

  await wsAddStream(symbol,'margin',handleMargin)
  await wsAddStream(symbol,'order',handleOrder)
  await wsAddStream(symbol,'position',handlePosition)
  await wsAddStream(symbol,'instrument',handleInstrument)
  if (symbol == 'XBTUSD') {
    lastCoinPairRate = 1
  }
  else {
    await wsAddStream('XBTUSD','instrument',handleXBTUSDInstrument)
  }

  heartbeat()
} catch(e) {logger.error(e.stack||e);debugger} }

async function pruneOrders(orders) { try {
  var found, pruned
  var yesterday = new Date().getTime() - 14400000
  var prunedCanceledOrder = false
  do {
    found = orders.findIndex(order => {
      switch (order.ordStatus) {
        case 'Canceled':
          prunedCanceledOrder = true
          return true
        case 'Filled':
          return (new Date(order.timestamp).getTime() < yesterday)
      }
      return false
    })
    if (found >= 0) {
      logger.info('pruneOrders',orders[found])
      orders.splice(found,1)
    }
  } while(found >= 0)
  return prunedCanceledOrder
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleMargin(data) { try {
  lastMargin = data[0]
  // checkPositionParams.walletBalance = lastWallet.amount
  // checkPositionParams.availableMargin = lastMargin.availableMargin
  // checkPositionParams.marginBalance = lastMargin.marginBalance
  checkPositionParams.walletBalance = lastMargin.walletBalance
  // console.log(checkPositionParams.availableMargin, checkPositionParams.marginBalance, checkPositionParams.walletBalance)
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleOrder(orders) { try {
  orders.forEach(o => {
    if (o.orderID) {
      let lastOrderIndex = lastOrders.findIndex(lo => {
        return (lo.orderID == o.orderID)
      })
      if (lastOrderIndex >= 0) {
        lastOrders[lastOrderIndex] = o
      }
      else {
        lastOrders.push(o)
      }
    }
    else {
      logger.error('handleOrder invalid order',o)
    }
  })

  lastOrders.forEach((order,i) => {
    logger.info('handleOrder',order)
    // console.log('ORDER '+i,order.ordStatus,order.ordType,order.side,order.price,order.stopPx,order.cumQty+'/'+order.orderQty)
  })
  console.log('---------------------')

  var prunedCanceledOrder = pruneOrders(orders)
  pruneOrders(lastOrders)
  if (!prunedCanceledOrder) {
    checkPositionParams.caller = 'order'
    checkPositionCallback(checkPositionParams)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

function handlePosition(data) {
  lastPosition = data[0]

  var qty = lastPosition.currentQty
  if (qty != lastQty) {
    checkPositionParams.positionSize = qty
    checkPositionParams.caller = 'position'
    checkPositionCallback(checkPositionParams)
  }

  lastQty = lastPosition.currentQty
}

async function handleInstrument(data) { try {
  lastInstrument = data[0]
  lastRates[lastInstrument.symbol] = lastInstrument.lastPrice
  
  var bid = lastInstrument.bidPrice
  var ask = lastInstrument.askPrice

  appendCandleLastPrice()
  
  if (bid !== lastBid || ask !== lastAsk) {
    checkPositionParams.bid = bid
    checkPositionParams.ask = ask
    checkPositionParams.lastPrice = lastInstrument.lastPrice
    checkPositionParams.fundingTimestamp = lastInstrument.fundingTimestamp
    checkPositionParams.fundingRate = lastInstrument.fundingRate
    checkPositionParams.caller = 'instrument'
    checkPositionCallback(checkPositionParams)
  }

  lastBid = bid
  lastAsk = ask
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleXBTUSDInstrument(data) {
  lastCoinPairInstrument = data[0]
  lastRates[lastCoinPairInstrument.symbol] = lastCoinPairInstrument.lastPrice
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

function getCandleTimeOffset() {
  return ((new Date().getTime()) % oneCandleMS)
}

function startNextCandle() {
  var now = new Date().getTime()
  var candleTimeOffset = now % oneCandleMS
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
    askPrice: lastInstrument.askPrice,
    lastPrice: lastInstrument.lastPrice
  }
}

async function authorize() { try {
  console.log('Authorizing')
  let swaggerClient = await new SwaggerClient({
    url: shoes.swagger,
    usePromise: true
  })
  swaggerClient.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(account.key, account.secret));
  console.log('Authorized')
  return swaggerClient
} catch(e) {logger.error(e.stack||e);debugger} }

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
  var totalMinutes = interval*length
  var maxPageSize = binSize*100
  var pageIncrement = totalMinutes/Math.ceil(totalMinutes/maxPageSize)*60000
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
  let timeMs = new Date(group[0].timestamp).getTime()-(binSize*60000)
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
  let response = await client.Trade.Trade_getBucketed({symbol:symbol, binSize:'1m', 
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
} catch(e) {logger.error(e.stack||e); debugger} }

var getTradeBucketedRequesting 

async function getTradeBucketed(interval,length) { try {
  if (getTradeBucketedRequesting) {
    await getTradeBucketedRequesting
  }
  let pages = getPageTimes(interval,length,binSize)
  getTradeBucketedRequesting = Promise.all(pages.map(async (page,i) => {
    let response = await client.Trade.Trade_getBucketed({symbol: symbol, binSize: binSize+'m', 
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
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarket() { try {
  if (marketCache) {
    // update current candle
    appendCandleLastPrice()
  }
  else {
    marketCache = await getTradeBucketed(setup.candle.interval,setup.candle.length)
  }
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarketWithCurrentCandle() { try {
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
    var market = await getMarket()
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
} catch(e) {logger.error(e.stack||e);debugger} }

async function getTradeHistory(startTime) { try {
  startTime = startTime || (new Date().getTime() - (candleLengthMS))
  let response = await client.Execution.Execution_getTradeHistory({symbol: symbol,
    startTime: new Date(startTime).toISOString(),
    columns:'commission,execComm,execCost,execType,foreignNotional,homeNotional,orderQty,lastQty,cumQty,price,ordType,ordStatus'
  })
  let data = JSON.parse(response.data)
  data.forEach(d => {
    console.log(d.timestamp,d.execType,d.price,d.orderQty)
  })
  debugger
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getFundingHistory(startTime) { try {
  startTime = startTime || (new Date().getTime() - (candleLengthMS))
  let response = await client.Funding.Funding_get({symbol: symbol,
    startTime: new Date(startTime).toISOString()
  })
  let data = JSON.parse(response.data)
  // data.forEach(d => {
  //   console.log(d.timestamp,d.fundingRate)
  // })
  // debugger
  return data
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getNewOrders(startTime) { try {
  startTime = startTime || (new Date().getTime() - (candleLengthMS))
  let response = await client.Order.Order_getOrders({symbol: symbol,
    startTime: new Date(startTime).toISOString(),
    filter: '{"ordStatus":"New"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType'
  })
  let orders = JSON.parse(response.data)
  return orders
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getOrders(startTime) { try {
  startTime = startTime || (new Date().getTime() - (candleLengthMS))
  let response = await client.Order.Order_getOrders({symbol: symbol,
    startTime: new Date(startTime).toISOString(),
    // filter: '{"ordType":"Limit"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType,execInst,cumQty'
  })
  let orders = JSON.parse(response.data)
  orders = orders.filter(order => {
    return (order.ordStatus != 'Canceled' && order.ordType != 'Funding')
  })
  return orders
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getCurrentCandle() {
  return currentCandle
}

async function cancelAll() { try {
  var response = await client.Order.Order_cancelAll({symbol:symbol})
  if (response && response.status == 200) {
    response.data = undefined
    response.statusText = undefined
    logger.info('cancelAll',response)
    handleOrder(response.obj)
  }
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function cancelOrders(orders) { try {
  var orderID = orders.map(o => {
    return o.orderID
  })
  var response = await client.Order.Order_cancel({symbol:symbol,
    orderID: orderID
  })
  if (response && response.status == 200) {
    response.data = undefined
    response.statusText = undefined
    logger.info('cancelOrder',response)
    handleOrder(response.obj)
  }
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function updateLeverage(leverage) { try {
  console.log('Updating Leverage',leverage)
  var response = await client.Position.Position_updateLeverage({symbol:symbol,leverage:leverage})
  console.log('Updated Leverage')
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function order(orders,cancelAllBeforeOrder) { try {
  if (!orders || orders.length == 0) {
    return
  }

  var valid = orders.reduce((a,c) => {
    return a && (c.price || c.stopPx)
  },true)
  if (!valid) {
    return
  }

  let response = await orderQueue({
    orders:orders,
    cancelAllBeforeOrder:cancelAllBeforeOrder
  })
  
  logger.info('order',response)
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function wait(ms) {
  return new Promise((resolve,reject) => {
    setTimeout(_ => resolve(true), ms)
  })
}

var pendingLimitOrderRetry, orderQueueArray = []

function popOrderQueue(ord) {
  var index = orderQueueArray.indexOf(ord);
  if (index > -1) {
    orderQueueArray.splice(index, 1);
  }
}

async function orderQueue(ord) { try {
  logger.info('orderQueue -->',ord)
  var foundPendingQueue = orderQueueArray.find(o => {
    if (o.orders.length != ord.orders.length || o.obsoleted) return false
    for (var i = 0; i < o.orders.length; i++) {
      let oi = o.orders[i], ordsi = ord.orders[i]
      if (oi.price != ordsi.price || oi.orderQty != ordsi.orderQty || oi.execInst != ordsi.execInst) {
        return false
      }
    }
    return true
    // return (o.price == ord.price && o.size == ord.size && o.execInst == ord.execInst && !ord.obsoleted)
  })
  if (foundPendingQueue) {
    logger.warn('orderQueue Duplicate')
    return ({obj:{ordStatus:'Duplicate'}}) 
  }
  orderQueueArray.forEach(o => {
    logger.info('newer order, obsolete old ones',o)
    o.obsoleted = true
  })
  orderQueueArray.push(ord)
  while (pendingLimitOrderRetry) {
    logger.info('await pendingLimitOrderRetry',pendingLimitOrderRetry.ord)
    await pendingLimitOrderRetry
  }
  // your turn, see if there is a newer order
  if (ord.obsoleted) {
    logger.info('orderQueue obsoleted',ord)
    popOrderQueue(ord)
    return ({obj:{ordStatus:'Obsoleted'}})
  }

  pendingLimitOrderRetry = orderBulkRetry(ord)
  pendingLimitOrderRetry.ord = ord
  var response = await pendingLimitOrderRetry
  pendingLimitOrderRetry = null
  logger.info('orderQueue',response)
  popOrderQueue(ord)
  return response
} catch(e) {logger.error(e.stack||(e));debugger} }

async function orderBulkRetry(ord) { try {
  if (ord.cancelAllBeforeOrder) {
    // new entry
    await cancelAll()
  }
  
  var retry = false,
      response, 
      count = 0,
      waitTime = 4
      // canceledCount = 0
  do {
    response = await orderBulk(ord.orders) 
    count++
    waitTime *= 2
    if (response.status == 503 && ord.cancelAllBeforeOrder) {
      // retry overloaded status only with the entry order
      retry = true
    }
    // if cancelled retry with new quote 
    // this means the quote move to a better price before the order reaches bitmex server
    // switch (response.obj.ordStatus) {
    //   case 'Overloaded': {
    //     retry = true
    //   } break
    //   case 'Canceled': {
    //     logger.warn('orderBulkRetry Canceled')
    //     retry = false
    //   } break
      // This cause entry price to be closer to stop loss and it may exceed the stop loss
      // It's better to check with the signal 
      // case 'Canceled': {
      //   retry = true
      //   canceledCount++
      //   if (canceledCount > 2) {
      //     let {price,orderQty,execInst} = response.obj
      //     let existingOrder = findNewLimitOrder(price,orderQty,execInst)
      //     if (existingOrder) {
      //       logger.warn('orderLimitRetry canceled duplicate order',ord)
      //       response.obj.ordStatus = 'Duplicate'
      //       retry = false
      //     }
      //   }
      // } break
    //   default:
    //     retry = false
    // }
  } while(retry && count < 7 && !ord.obsoleted && await wait(waitTime))
  if (ord.obsoleted) {
    logger.info('orderBulkRetry obsoleted',ord)
  }
  logger.info('orderBulkRetry', response)
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderBulk(orders) { try {
  orders.forEach(o => {
    o.symbol = symbol
  })

  var response

  // Test amend on take profit orders
  if (orders[0].ordType == 'Limit' && orders[0].execInst == 'ParticipateDoNotInitiate,ReduceOnly') {
    let ordersToAmend = findOrdersToAmend(orders)
    if (ordersToAmend.length == 0) {
      response = await orderNewBulk(orders)
    }
    else if (ordersToAmend.length == orders.length) {
      response = await orderAmendBulk(ordersToAmend)
    }
    else {
      let ordersToNew = orders.filter(o => {
        return !ordersToAmend.find(a => {return (o == a)})
      })
      response = await orderAmendBulk(ordersToAmend)
      let newResponse = await orderNewBulk(ordersToNew)
      if (response.status == 200 && newResponse.status == 200 && 
        Array.isArray(response.obj) && Array.isArray(newResponse.obj)) {
        response.obj = response.obj.concat(newResponse.obj)
      }
      else if (newResponse.status == 200) {
        response = newResponse
      }
    }
  }
  else {
    response = await orderNewBulk(orders)
  }

  if (response && response.status == 200) {
    handleOrder(response.obj)
  }
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderNewBulk(orders) { try {
  var orderTooSmall = orders.find(o => {
    let absQtyBTC = Math.abs(o.orderQty/getRate('XBTUSD'))
    return absQtyBTC < setup.bankroll.minOrderSizeBTC
  })
  if (orderTooSmall) {
    return ({status:400})
  }
  var response = await client.Order.Order_newBulk({orders:JSON.stringify(orders)})
  .catch(function(e) {
    e.data = undefined
    e.statusText = undefined
    logger.error('orderNewBulk error',e,orders)
    if (e.obj.error.message.indexOf('The system is currently overloaded') >= 0) {
      return e
    }
    else if (e.obj.error.message.indexOf('Duplicate') >= 0) {
      return e
    }
    else {
      debugger
      return e
    }
  })

  if (response && response.status == 200) {
    response.data = undefined
    response.statusText = undefined
    logger.info('orderNewBulk',response)
  }
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderAmendBulk(orders) { try {
  let response = await client.Order.Order_amendBulk({orders:JSON.stringify(orders)})
  .catch(function(e) {
    e.data = undefined
    e.statusText = undefined
    console.error('orderAmendBulk error',e)
    logger.error('orderAmendBulk error',e,orders)
    if (e.obj.error.message.indexOf('The system is currently overloaded') >= 0) {
      return e
    }
    else if (e.obj.error.message.indexOf('Duplicate') >= 0) {
      return e
    }
    else if (e.obj.error.message.indexOf('open sell orders exceed current position')) {
      return e
    }
    else {
      debugger
      return e
    }
  })

  if (response && response.status == 200) {
    response.data = undefined
    response.statusText = undefined
    logger.info('orderAmendBulk',response)
  }
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

function findOrder(status,{price:p,stopPx:spx,orderQty:q,execInst:e,ordType:t,side:sd},haystacks) {  
  sd = sd || (q > 0 ? 'Buy' : 'Sell')
  q = Math.abs(q)
  
  var orders = haystacks.filter(({price,stopPx,execInst,ordType,ordStatus,side}) => {
    return (side == sd && ordType == t && execInst == e && ordStatus.search(status) >=0)
  })
  if (orders.length == 0) return

  switch(t) {
    case 'Limit':          
      if (status.source == 'Fill') {
        // For finding cumQty
        return orders.filter(({price}) => {
          return (price == p)
        })
      }
      switch(e) {
        case 'ParticipateDoNotInitiate':{
          // Entry orderQty may not be exact, depending on the margin. We can ignore similar entry orders with similar orderQty.
          return orders.find(({price, orderQty}) => {
            return (price == p && orderQty >= (q*0.98) && orderQty <= (q*1.02))
          })
        }
        case 'Close,ParticipateDoNotInitiate':
          // Target Stop Limit
          return true
        default:{
          // Exit Target 
          return orders.find(({price, orderQty}) => {
            // Exit orderQty has to be exact
            return (price == p && orderQty == q)
          })
        }
      }
    case 'LimitIfTouched':
    case 'Stop':
    case 'StopLimit':
      return orders.find(({stopPx}) => {
        // Use stopPx for stop orders
        return (stopPx == spx)
      })
  }
}

function findOrders(status,needles,haystacks) {
  if (!needles) return []
  haystacks = haystacks || lastOrders
  var foundOrders = []
  needles.forEach(needle => {
    let found = findOrder(status,needle,haystacks)
    if (found) {
      foundOrders.push(found)
    }
  })
  return foundOrders
}

function findOrdersToAmend(orders) {
  var {ordType:t,execInst:e,side:sd} = orders[0]
  var ordersToAmend = []

  var openOrders = lastOrders.filter(({ordStatus,ordType,execInst,side}) => {
    return (ordStatus.search(/New|PartiallyFilled/) >= 0 && ordType == t && execInst == e && side == sd)
  })

  orders.forEach(o => {
    var orderToAmend = openOrders.find(a => {
      return (a.price == o.price)
    })
    if (orderToAmend) {
      o.orderID = orderToAmend.orderID
      if (o.ordStatus == 'PartiallyFilled') {
        o.orderQty += orderToAmend.cumQty
      }
      ordersToAmend.push(o)
    }
  })

  return ordersToAmend
}

function getCumQty(ords,since) {
  if (!ords) return
  var existingEntryOrders = findOrders(/Fill/,ords)
  var sinceTime = new Date(since).getTime()
  return existingEntryOrders.reduce((a,c) => {
    return c.reduce((aa,cc) => {
      var orderTime = new Date(cc.timestamp).getTime()
      return (orderTime < sinceTime ? aa : aa + (cc.cumQty*(cc.side=='Buy'?1:-1)))
    },a)
  },0)
}

function getRate(symbol) {
  return lastRates[symbol]
}

async function initMarket() { try {
  console.log('Initializing market')
  await getMarket()
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
} catch(e) {logger.error(e.stack||e);debugger} }

async function initOrders() { try {
  console.log('Initializing orders')
  var orders = await getOrders()
  await handleOrder(orders)

  var newOrders = await getNewOrders()
  if (newOrders.length == 0) {
    // Order stream will not work without an open order.
    // It's okay to leave this dummy stop market around.
    // It will get canceled later.
    console.log('Adding dummy stop market')
    await orderBulk([{
      stopPx: 1,
      side: 'Sell',
      ordType: 'Stop',
      execInst: 'Close,LastPrice'
    }])
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function init(checkPositionCb) { try {
  checkPositionCallback = checkPositionCb
  client = await authorize()
  // inspect(client.apis)
  await initMarket()
  await initOrders()
  await updateLeverage(0) // cross margin

  await connect()

  // await getTradeHistory()


  // await getOrderBook()

  // await getFundingHistory(yesterday)
  // await getInstrument()
  // await getOrders(yesterday)
} catch(e) {logger.error(e.stack||e);debugger} }

module.exports = {
  init: init,
  getMarket: getMarket,
  getMarketWithCurrentCandle: getMarketWithCurrentCandle,
  getPosition: getPosition,
  getInstrument: getInstrument,
  getQuote: getQuote,

  getOrders: getOrders,
  getTradeHistory: getTradeHistory,
  getFundingHistory: getFundingHistory, 
  getCurrentCandle: getCurrentCandle,
  getNextFunding: getNextFunding,
  getRate: getRate,

  // findNewLimitOrders: findNewLimitOrders,
  // findNewOrFilledOrder: findNewOrFilledOrder,
  // findNewOrFilledOrders: findNewOrFilledOrders,
  findOrders: findOrders,
  getCumQty: getCumQty,

  getCandleTimeOffset: getCandleTimeOffset,

  checkPositionParams: checkPositionParams,

  order: order,
  cancelAll: cancelAll,
  cancelOrders: cancelOrders
}