const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const shoes = require('./shoes')
const winston = require('winston')

const BitMEXRealtimeAPI = require('bitmex-realtime-api')

const EXECINST_REDUCEONLY = ',ReduceOnly'

var client, checkPositionCallback, checkPositionParams = {}
var marketCache, marketWithCurrentCandleCache
var binSize = 5

var ws
var lastInstrument = {}, lastPosition = {}, lastOrders = []
var lastBid, lastAsk, lastQty

var currentCandle, currentCandleTimeOffset

const colorizer = winston.format.colorize();

const isoTimestamp = winston.format((info, opts) => {
  info.timestamp = new Date().toISOString()
  return info;
});

function orderString({ordStatus,ordType,side,cumQty,orderQty,price=NaN,stopPx,execInst}) {
  return ordStatus+' '+ordType+' '+side+' '+cumQty+'/'+orderQty+' '+price+' '+stopPx+' '+execInst
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
          let line = message + ' '
          switch(message) {
            case 'orderStopMarket':
            case 'orderStopMarketRetry':
            case 'orderLimit':
            case 'orderLimitRetry':
            case 'orderQueue':
            case 'orderEnter':
            case 'orderExit': {
              line += (splat[0].obj ? orderString(splat[0].obj) : ('splat[0].obj is null ' + JSON.stringify(splat[0])))
            } break
            case 'cancelAll': {
              line += splat[0].obj.length
            } break
            case 'handleOrder':
            case 'pruneOrders': {
              line += (splat[0] ? orderString(splat[0]) : 'splat[0] is null')
            } break
            case 'orderLimit error':
            case 'orderStopMarket error': {
              let {status,obj} = splat[0]
              line += status + ' ' + obj.error.message + ' ' + JSON.stringify(splat[1])
            } break
            default: {
              line += (splat ? `${JSON.stringify(splat)}` : '')
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
      reject('wsAddStream '+table+' timeout')
    }, 5000)
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function connect() { try {
  ws = new BitMEXRealtimeAPI({
    testnet: shoes.bitmex.test,
    apiKeyID: shoes.bitmex.key,
    apiKeySecret: shoes.bitmex.secret,
    maxTableLen:100
  })
  ws.on('error', logger.error);
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
  await wsAddStream('margin',handleMargin)
  await wsAddStream('order',handleOrder)
  await wsAddStream('position',handlePosition)
  await wsAddStream('instrument',handleInstrument)

  heartbeat()
} catch(e) {logger.error(e.stack||e);debugger} }

async function pruneOrders(orders) { try {
  var found, pruned
  var yesterday = new Date().getTime() - 28800000
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
  checkPositionParams.availableMargin = lastMargin.availableMargin
  checkPositionParams.walletBalance = lastMargin.walletBalance
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleOrder(data) { try {
  lastOrders = data
  lastOrders.forEach((order,i) => {
    logger.info('handleOrder',order)
    // console.log('ORDER '+i,order.ordStatus,order.ordType,order.side,order.price,order.stopPx,order.cumQty+'/'+order.orderQty)
  })
  console.log('---------------------')

  var prunedCanceledOrder = pruneOrders(data)
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

function findNewLimitOrder(p,s,e) {
  s = Math.abs(s)
  return lastOrders.find((order) => {
    let {ordStatus,ordType,price,orderQty,execInst,timestamp} = order
    if (ordType == 'Limit') {
      switch (ordStatus) {
        case 'New': {
          return (price == p && orderQty == s && execInst == e)
        }
        case 'Filled': {
          if (execInst == e && price > (p*0.999) && price < (p*1.001) && orderQty > (s*0.98) && orderQty < (s*1.02)) {
            let ordTime = new Date(timestamp).getTime
            let now = new Date().getTime()
            logger.warn('findNewLimitOrder found filled',order)
            return (now - ordTime < 10000)
          }
        }
      }
    }
  })
}

async function authorize() { try {
  console.log('Authorizing')
  let swaggerClient = await new SwaggerClient({
    url: shoes.bitmex.swagger,
    usePromise: true
  })
  swaggerClient.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(shoes.bitmex.key, shoes.bitmex.secret));
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
} catch(e) {logger.error(e.stack||e); debugger} }

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
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarket(interval,length) { try {
  if (marketCache) {
    // update current candle
    appendCandleLastPrice()
  }
  else {
    marketCache = await getTradeBucketed(interval,length)
  }
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

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
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMargin() { try {
  return lastMargin
  // var response = await client.User.User_getMargin() 
  // var margin = JSON.parse(response.data.toString())
  // return margin
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

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
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

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
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getNewOrders(startTime) { try {
  startTime = startTime || (new Date().getTime() - (24*60*60000))
  let response = await client.Order.Order_getOrders({symbol: 'XBTUSD',
    startTime: new Date(startTime).toISOString(),
    filter: '{"ordStatus":"New"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType'
  })
  let orders = JSON.parse(response.data)
  return orders
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

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
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getCurrentCandle() {
  return currentCandle
}

async function cancelAll() { try {
  // logger.info('Cancelling All Orders')
  let response = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  response.data = undefined
  response.statusText = undefined
  logger.info('cancelAll',response)
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function updateLeverage(leverage) { try {
  console.log('Updating Leverage',leverage)
  let response = await client.Position.Position_updateLeverage({symbol:'XBTUSD',leverage:leverage})
  console.log('Updated Leverage')
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderEnter(signal) { try {
  if (!signal.entryPrice || !signal.positionSizeUSD) {
    return
  }

  let response = await orderQueue({
    cid:signal.timestamp+'ENTER',
    price:signal.entryPrice,
    size:signal.positionSizeUSD,
    execInst:''
  })
  
  logger.info('orderEnter',response)

  switch (response.obj.ordStatus) {
    case 'Canceled':
    case 'Overloaded':
    case 'Duplicate':
      return false
  }

  await orderStopMarketRetry(signal.stopLoss,-signal.positionSizeUSD)
  // handle response
  return true
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderExit(timestamp,price,size) { try {
  if (!price || !size) {
    return
  }

  var cid = ''
  var response = await orderQueue({cid:cid,price:price,size:size,execInst:EXECINST_REDUCEONLY})
  logger.info('orderExit', response)
  return response
} catch(e) {logger.error(e.stack||e);debugger} }

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
    return (o.price == ord.price && o.size == ord.size && o.execInst == ord.execInst && !ord.obsoleted)
  })
  if (foundPendingQueue) {
    return ({obj:{ordStatus:'Duplicate'}}) 
  }
  orderQueueArray.forEach(o => {
    logger.info('newer order, obsolete old one',o)
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

  pendingLimitOrderRetry = orderLimitRetry(ord)
  pendingLimitOrderRetry.ord = ord
  var response = await pendingLimitOrderRetry
  pendingLimitOrderRetry = null
  logger.info('orderQueue',response)
  popOrderQueue(ord)
  return response
} catch(e) {logger.error(e.stack||(e));debugger} }

async function orderLimitRetry(ord) { try {
  if (!ord.execInst || ord.execInst.length == 0) {
    await cancelAll()
  }
  var {cid,price,size,execInst} = ord
  var retry = false,
      response, 
      count = 0,
      waitTime = 2,
      canceledCount = 0
  do {
    response = await orderLimit(cid,price,size,execInst) 
    count++
    waitTime *= 2
    // if cancelled retry with new quote 
    // this means the quote move to a better price before the order reaches bitmex server
    switch (response.obj.ordStatus) {
      case 'Overloaded': {
        retry = true
      } break
      case 'Canceled': {
        retry = true
        canceledCount++
        if (canceledCount > 2) {
          let {price,orderQty,execInst} = order.response.obj
          let existingOrder = findNewLimitOrder(price,orderQty,execInst)
          if (existingOrder) {
            logger.warn('orderLimitRetry canceled duplicate order',ord)
            response.obj.ordStatus = 'Duplicate'
            retry = false
          }
        }
      } break
      default:
        retry = false
    }
  } while(retry && count < 10 && !ord.obsoleted && await wait(waitTime))
  if (ord.obsoleted) {
    logger.info('orderLimitRetry obsoleted',ord)
  }
  logger.info('orderLimitRetry', response)
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderLimit(cid,price,size,execInst) { try {
  if (size > 0) {
    if (price > lastInstrument.bidPrice) {
      logger.warn('orderLimit price',price,'is more than last bidPrice',lastInstrument.bidPrice)
      price = lastInstrument.bidPrice
    }
  }
  else {
    if (price < lastInstrument.askPrice) {
      logger.warn('orderLimit price',price,'is less than last askPrice',lastInstrument.askPrice)
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
    e.data = undefined
    e.statusText = undefined
    logger.error('orderLimit error',e,{cid:cid,price:price,size:size,execInst:execInst})
    if (e.obj.error.message.indexOf('The system is currently overloaded') >= 0) {
      return ({obj:{ordStatus:'Overloaded'}})
    }
    else if (e.obj.error.message.indexOf('Duplicate') >= 0) {
      return ({obj:{ordStatus:'Duplicate'}})
    }
    else {
      debugger
      return e
    }
  })
  
  if (response) {
    response.data = undefined
    response.statusText = undefined
    logger.info('orderLimit',response)
    return response
  }
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderStopMarketRetry(price,size) { try {
  retryOn = 'Canceled,Overloaded'
  let response, 
      count = 0,
      waitTime = 2
  do {
    response = await orderStopMarket(price,size)
    count++
    waitTime *= 2
    // if cancelled retry with new quote 
    // this means the quote move to a better price before the order reaches bitmex server
  } while((retryOn.indexOf(response.obj.ordStatus) >= 0) && count < 10 && await wait(waitTime))
  logger.info('orderStopMarketRetry', response)
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderStopMarket(price,size) { try {
  let response = await client.Order.Order_new({ordType:'StopMarket',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly',
    orderQty:size,
    stopPx:price 
  }).catch(function(e) {
    e.data = undefined
    e.statusText = undefined
    logger.error('orderStopMarket error',e,{price:price,size:size})
    if (e.obj.error.message.indexOf('The system is currently overloaded') >= 0) {
      return {obj:{ordStatus:'Overloaded'}}
    }
    else if (e.obj.error.message.indexOf('Duplicate') >= 0) {
      return {obj:{ordStatus:'Duplicate'}}
    }
    else {
      debugger
      return e
    }
  })

  if (response) {
    response.data = undefined
    response.statusText = undefined
    logger.info('orderStopMarket',response)
    return response
  }
} catch(e) {logger.error(e.stack||e);debugger} }

function findNewLimitOrder(p,s,e) {
  s = Math.abs(s)
  return lastOrders.find((order) => {
    let {ordStatus,ordType,price,orderQty,execInst} = order
    return (price == p && orderQty == s && execInst == e && ordType == 'Limit' && ordStatus == 'New')
  })
}

function findNewOrFilledOrder(t,p,s,e) {
  s = Math.abs(s)
  return lastOrders.find((order) => {
    let {ordStatus,ordType,price,stopPx,orderQty,execInst,timestamp} = order
    price = price || stopPx
    if (ordType == t) {
      switch (ordStatus) {
        case 'New': {
          return (price == p && orderQty == s && execInst == e)
        }
        case 'Filled': {
          if (execInst == e && price > (p*0.999) && price < (p*1.001) && orderQty > (s*0.98) && orderQty < (s*1.02)) {
            let ordTime = new Date(timestamp).getTime()
            let now = new Date().getTime()
            logger.warn('findNewOrFilledOrder found filled',order)
            return (now - ordTime < 10000)
          }
        }
      }
    }
  })
}

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
} catch(e) {logger.error(e.stack||e);debugger} }

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
} catch(e) {logger.error(e.stack||e);debugger} }

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
  findNewOrFilledOrder: findNewOrFilledOrder,
  getCandleTimeOffset: getCandleTimeOffset,

  checkPositionParams: checkPositionParams,

  orderEnter: orderEnter,
  orderStopMarketRetry: orderStopMarketRetry,
  orderExit: orderExit,
  cancelAll: cancelAll
}