const BitMEXAPIKeyAuthorization = require('../lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const BitMEXRealtimeAPI = require('bitmex-realtime-api')
const winston = require('winston')
const shoes = require('../shoes')
const email = require('../email/email.js')
const {symbol,exchange,setup} = shoes
const oneCandleMs = setup.candle.interval*60000
const oneCandleEndMs = oneCandleMs-1
const oneDayMS = 24*60*60000
const name = 'bitmex'
const symbols = {
  XBTUSD: 'XBTUSD'
}

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

var client, checkPositionCallback, position = {exchange:name}
var marketCache, marketWithCurrentCandleCache
var binSize = 1
var binSizeString = '1m'
if (setup.candle.interval >= 60) {
  binSize = 60
  binSizeString = '1h'
}
else if (setup.candle.interval >= 5) {
  binSize = 5
  binSizeString = '5m'
}
var bitmexOffset = binSize * 60000 // bitmet bucket time is one bucket ahead

var ws
var lastMargin = {}, lastInstrument = {}, lastPosition = {}, lastOrders = [], lastXBTUSDInstrument = {}
var lastBid, lastAsk, lastQty, lastRates = {}

var lastCandle, currentCandle

const {getTimeNow, isoTimestamp, colorizer} = global

function orderString({timestamp,ordStatus,ordType,side,cumQty,orderQty,price=NaN,stopPx,execInst}) {
  return timestamp+' '+ordStatus.padEnd(8)+' '+ordType.padEnd(6)+' '+side.padEnd(4)+' '+(cumQty+'/'+(orderQty||'0')).padEnd(11)+' '+((price || stopPx)+'').padEnd(8)+' '+execInst
}

function orderStringBulk(orders) {
  if (orders.reduce) {
    return orders.reduce((a,c) => {
      return a + '<-- response: ' + orderString(c)
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
            case 'order': 
            case 'cancelOrder' : {
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
            case 'orderAmendBulk error': 
            case 'orderBulkRetry error': 
            case 'orderQueue error':
            case 'order error': {
              let {status,obj,errObj} = splat[0]
              if (!obj) {
                obj = {
                  error: errObj
                }
              }
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
    apiKeyID: exchange.bitmex.key,
    apiKeySecret: exchange.bitmex.secret,
    maxTableLen:100
  })
  // 'Unable to parse incoming data:' is coming from heartbeat ping
  ws.on('error', (e) => {if (e == 'Unable to parse incoming data:') return; logger.error(e);debugger});
  ws.on('open', () => console.log('Connection opened.'));
  ws.on('close', () => console.log('Connection closed.'));
  // ws.on('initialize', () => console.log('Client initialized, data is flowing.'));

  await wsAddStream(symbol,'margin',handleMargin)
  await wsAddStream(symbol,'order',handleOrder)
  await wsAddStream(symbol,'position',handlePosition)
  await wsAddStream(symbol,'instrument',handleInstrument)
  if (symbol != 'XBTUSD') {
    await wsAddStream('XBTUSD','instrument',handleXBTUSDInstrument)
  }

  heartbeat()
} catch(e) {logger.error(e.stack||e);debugger} }

async function pruneOrders(orders) { try {
  var found, pruned
  var yesterday = getTimeNow() - oneDayMS
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
      if (!mock) {
        logger.info('pruneOrders',orders[found])
      }
      orders.splice(found,1)
    }
  } while(found >= 0)
  return prunedCanceledOrder
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleMargin(accounts) { try {
  lastMargin = accounts.find(account => {
    return account.walletBalance > 0 && account.currency == 'XBt'
  })
  position.walletBalance = lastMargin.walletBalance
  position.marginBalance = lastMargin.marginBalance
  position.unrealisedPnl = lastMargin.unrealisedPnl
  // check every tick
  // position.caller = 'margin'
  // await checkPositionCallback(position)
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleOrder(orders) { try {
  orders.forEach(o => {
    if (o.orderID) {
      let lastOrderIndex = lastOrders.findIndex(lo => {
        return (lo.orderID == o.orderID)
      })
      let lastOrder
      if (lastOrderIndex >= 0) {
        lastOrder = lastOrders[lastOrderIndex]
        lastOrders[lastOrderIndex] = o
      }
      else {
        lastOrders.push(o)
      }
      if (o.ordType == 'Stop' && o.execInst == 'LastPrice,Close' && o.stopPx > 1) {
        switch (o.ordStatus) {
          case 'New':
            position.currentStopPx = o.stopPx
            break;
          case 'Filled':
            if (lastOrder && lastOrder.ordStatus == 'New') {
              if (!mock && !shoes.test) {
                email.send('MoonBoy Exit ' + o.side + ' ' + o.price + ' ' + o.orderQty, JSON.stringify(o, null, 2))
              }
            }
            break;
        }
      }
    }
    else {
      logger.error('handleOrder invalid order',o)
    }
  })

  if (!mock) {
    lastOrders.forEach((order,i) => {
      logger.info('handleOrder',order)
    })
    console.log('---------------------')
  }

  var prunedCanceledOrder = pruneOrders(orders)
  pruneOrders(lastOrders)
  if (!prunedCanceledOrder) {
    position.caller = 'order'
    await checkPositionCallback(position)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function handlePosition(data) {
  lastPosition = data[0]

  var qty = lastPosition.currentQty
  if (qty != lastQty) {
    position.lastPositionSize = lastQty
    position.positionSize = qty
    if (lastQty != undefined) {
      position.caller = 'position'
      await checkPositionCallback(position)
    }
  }

  lastQty = lastPosition.currentQty
}

async function handleInstrument(data) { try {
  lastInstrument = data[0]
  lastRates[lastInstrument.symbol] = lastInstrument.lastPrice
  
  var bid = lastInstrument.bidPrice
  var ask = lastInstrument.askPrice

  appendCandleLastPrice()
  
  if (mock || bid !== lastBid || ask !== lastAsk) {
    position.bid = bid
    position.ask = ask
    position.lastPrice = lastInstrument.lastPrice
    position.fundingTimestamp = lastInstrument.fundingTimestamp
    position.fundingRate = lastInstrument.fundingRate
    if (mock) {
      position.caller = 'instrument'
      await checkPositionCallback(position)
    }
  }

  lastBid = bid
  lastAsk = ask
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleXBTUSDInstrument(data) {
  lastCoinPairInstrument = data[0]
  lastRates[lastCoinPairInstrument.symbol] = lastCoinPairInstrument.lastPrice
}

async function handleInterval(data) {  
  getCurrentMarket() // to start a new candle if necessary
  position.caller = 'interval'
  await checkPositionCallback(position)
}

async function appendCandleLastPrice() {
  startNextCandle()
  addTradeToCandle(new Date(lastInstrument.timestamp).getTime(),lastInstrument.lastPrice)
}

function getCandleTimeOffset() {
  return ((getTimeNow()) % oneCandleMs)
}

function startNextCandle() {
  var now = getTimeNow()
  var newCandleTime = now - (now % oneCandleMs)

  if (newCandleTime == currentCandle.startTimeMs) {
    return
  }
  else if (newCandleTime < currentCandle.startTimeMs) {
    logger.error('invalid candle time', newCandleTime, currentCandle)
    throw new Error('invalid candle time')
  }

  var newCandleISOString = new Date(newCandleTime).toISOString()

  if (marketCache.candles[marketCache.candles.length-1].time == newCandleISOString) {
    return
  }

  marketWithCurrentCandleCache = null

  lastCandle = currentCandle

  var {opens,highs,lows,closes,candles} = marketCache
  opens.shift()
  highs.shift()
  lows.shift()
  closes.shift()
  candles.shift()

  opens.push(currentCandle.open)
  highs.push(currentCandle.high)
  lows.push(currentCandle.low)
  closes.push(currentCandle.close)
  candles.push(currentCandle)


  let open = currentCandle.close
  currentCandle = {
    time:newCandleISOString,
    startTimeMs: newCandleTime,
    endTimeMs: newCandleTime + oneCandleEndMs,
    lastTradeTimeMs: newCandleTime,
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
    if (time >= currentCandle.lastTradeTimeMs) {
      currentCandle.lastTradeTimeMs = time
      currentCandle.close = price
    }
  }
  else {
    if (time >= lastCandle.startTimeMs && time <= lastCandle.endTimeMs) {
      let lastIndex = marketCache.candles.length - 1
      if (price > lastCandle.high) {
        marketCache.highs[lastIndex] = lastCandle.high = price
      }
      else if (price < lastCandle.low) {
        marketCache.lows[lastIndex] = lastCandle.low = price
      }
      if (time >= lastCandle.lastTradeTimeMs) {
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

async function getQuote() {
  return {
    bidPrice: lastInstrument.bidPrice,
    askPrice: lastInstrument.askPrice,
    lastPrice: lastInstrument.lastPrice
  }
}

async function authorize() { try {
  console.log('Authorizing')

  const authorization = new BitMEXAPIKeyAuthorization(exchange.bitmex.key, exchange.bitmex.secret)

  let swaggerClient = await new SwaggerClient({
    url: shoes.swagger,
    requestInterceptor(req) {
      // Despite swagger seeing that JSON is the expected type, it will still build formdata bodies
      // Long saga, may be fixed in https://github.com/swagger-api/swagger-js/pull/1500
      req.headers['Content-Type'] = "application/x-www-form-urlencoded";
      // Unfortunately, swagger-client removed custom authorizations in version 3.
      // We implement our authorization as an interceptor instead.
      if (typeof authorization !== 'undefined') {
        authorization.apply(req);
      }
    }
  })

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

function getPageTimes({interval,startTime,endTime}) {
  var startTimeMs = new Date(startTime).getTime()
  var endTimeMs = new Date(endTime).getTime()
  var length = (endTimeMs - startTimeMs) / (interval*60000)
  var offset = (length * interval * 60000) + (endTimeMs % (interval * 60000))
  offset -= bitmexOffset
  var totalMinutes = interval*length
  var maxPageSize = binSize*100
  var pageIncrement = totalMinutes/Math.ceil(totalMinutes/maxPageSize)*60000
  var pages = []
  if (offset > pageIncrement) {
    var end = pageIncrement - bitmexOffset
    for (; offset >= end; offset-=pageIncrement) {
      pages.push({
        startTime: new Date(endTimeMs - offset).toISOString(),
        endTime: new Date(endTimeMs - (offset-pageIncrement)).toISOString()
      })
    }
  }
  else {
    pages.push({
      startTime: new Date(endTimeMs - offset).toISOString(),
      endTime: new Date(endTimeMs - (offset-(length*interval*60000))).toISOString()
    })
  }
  return pages
}

function toCandle(group) {
  var open = group[0].open
  let timeMs = new Date(group[0].timestamp).getTime() - oneCandleMs
  let candle = {
    time: new Date(timeMs).toISOString(),
    startTimeMs: timeMs,
    endTimeMs: timeMs + oneCandleEndMs,
    lastTradeTimeMs: timeMs + oneCandleEndMs,
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

async function getUserExecutionHistory(start,end) { try {
  var requestTime = new Date(start).getTime() + 12*60*60000
  const endTime = new Date(end).getTime() + 36*60*60000
  const executions = []
  while (requestTime < endTime) {
    let timestamp = new Date(requestTime).toISOString()
    let response = await client.apis.User.User_getExecutionHistory({
      symbol: 'XBTUSD',
      timestamp: timestamp
    })
    response.obj.forEach(o => {
      if (!executions.find(e => {return e.execID == o.execID})) {
        executions.push(o)
      }
    })
    requestTime += 12*60*60*1000
  }
  return executions
} catch(e) {logger.error(e.stack||e); debugger} }

async function getCurrentTradeBucketed(interval) { try {
  interval = interval || 15
  let now = getTimeNow()
  let candleTimeOffset = now % (interval*60000)
  let startTime = new Date(now - candleTimeOffset + 60000).toISOString()
  let response = await client.apis.Trade.Trade_getBucketed({symbol:symbol, binSize:binSizeString, 
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
  candle.endTimeMs = timeMs + oneCandleEndMs
  candle.lastTradeTimeMs = timeMs // accepting new trade data
  return {candle:candle,candleTimeOffset:candleTimeOffset}
} catch(e) {logger.error(e.stack||e); debugger} }

var getTradeBucketedRequesting 

async function getTradeBucketed(sp) { try {
  var {interval,startTime,endTime} = sp
  if (getTradeBucketedRequesting) {
    await getTradeBucketedRequesting
  }
  let pages = getPageTimes(sp)
  getTradeBucketedRequesting = Promise.all(pages.map(async (page,i) => {
    let response = await client.apis.Trade.Trade_getBucketed({symbol: symbol, binSize: '1h', 
      startTime:page.startTime,endTime:page.endTime})
    page.buckets = JSON.parse(response.data.toString())
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

async function getMarket(sp) {
  return await getTradeBucketed(sp)
}

function getLastCandle() {
  return lastCandle
}

async function updatePosition() {
  // the position is updated via ws
}

async function getCurrentMarket() { try {
  if (marketCache) {
    // update current candle
    appendCandleLastPrice()
  }
  else {
    let now = getTimeNow()
    let length = setup.candle.length
    let startTime = new Date(now-length*oneCandleMs).toISOString()
    let endTime = new Date(now-oneCandleMs).toISOString()
    marketCache = await getTradeBucketed({
      symbol: symbol,
      interval: setup.candle.interval,
      startTime: startTime,
      endTime: endTime
    })
    lastCandle = marketCache.candles[marketCache.candles.length-1]
    // console.log('now',new Date(now).toISOString())
    // console.log('startTime',startTime)
    // console.log('endTime',endTime)
  }
  // console.log(marketCache.candles.length)
  // console.log(marketCache.candles[0].time)
  // console.log(marketCache.candles[marketCache.candles.length-1].time)
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

async function getWalletHistory() { try {
  let response = await client.apis.User.User_getWalletHistory({
    currency: 'XBt'
  })
  return response.obj
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

// async function getTradeHistory(startTime) { try {
//   startTime = startTime || (getTimeNow() - (candleLengthMS))
//   let response = await client.apis.Execution.Execution_getTradeHistory({symbol: symbol,
//     startTime: new Date(startTime).toISOString(),
//     columns:'commission,execComm,execCost,execType,foreignNotional,homeNotional,orderQty,lastQty,cumQty,price,ordType,ordStatus'
//   })
//   let data = JSON.parse(response.data)
//   data.forEach(d => {
//     console.log(d.timestamp,d.execType,d.price,d.orderQty)
//   })
//   debugger
// } catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getFundingHistory(startTime) { try {
  startTime = startTime || (getTimeNow() - oneDayMS)
  let response = await client.apis.Funding.Funding_get({symbol: symbol,
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
  startTime = startTime || (getTimeNow() - oneDayMS)
  let response = await client.apis.Order.Order_getOrders({symbol: symbol,
    startTime: new Date(startTime).toISOString(),
    filter: '{"ordStatus":"New"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType'
  })
  let orders = JSON.parse(response.data)
  return orders
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getOrders({startTime,endTime}) { try {
  startTime = startTime || new Date(getTimeNow() - oneDayMS).toISOString()
  endTime = endTime || new Date(getTimeNow()).toISOString()
  let response = await client.apis.Order.Order_getOrders({symbol: symbol,
    startTime: startTime,
    endTime: endTime,
    // filter: '{"ordType":"Limit"}',
    columns: 'price,orderQty,ordStatus,side,stopPx,ordType,execInst,cumQty,transactTime'
  })
  let orders = JSON.parse(response.data)
  // orders = orders.filter(order => {
  //   return (order.ordStatus != 'Canceled' && order.ordType != 'Funding')
  // })
  return orders
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function getCurrentCandle() {
  return currentCandle
}

async function cancelAll() { try {
  var response = await client.apis.Order.Order_cancelAll({symbol:symbol})
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
  var response = await client.apis.Order.Order_cancel({symbol:symbol,
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
  var response = await client.apis.Position.Position_updateLeverage({symbol:symbol,leverage:leverage})
  console.log('Updated Leverage')
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function order(orders,cancelAllBeforeOrder) { try {
  if (!orders || orders.length == 0) {
    return {statusText:'Order is empty'}
  }

  var valid = orders.reduce((a,c) => {
    return a && (c.price || c.stopPx)
  },true)
  if (!valid) {
    return {statusText:'Order is missing price or stopPx'}
  }

  if (cancelAllBeforeOrder) {
    let cOrders = findOrders(/New/,lastOrders)
    if (cOrders.length > 0) {
      let execInstMap = orders.map(o => {return o.execInst})
      cOrders = cOrders.filter(o => {
        return execInstMap.indexOf(o.execInst) >= 0
      })
      if (cOrders.length > 0) {
        if (cOrders[0].execInst != 'ParticipateDoNotInitiate,ReduceOnly' ||
            cOrders[0].price != orders[0].price) {
          await cancelOrders(cOrders)
        }
      }
    }
    // await cancelAll()
  }
  
  if (!mock) {
    logger.info('order -->',orders)
  }

  var responses = []
  for (let i = 0; i < orders.length; i++) {
    responses[i] = await orderQueue({
      orders:[orders[i]],
      cancelAllBeforeOrder:cancelAllBeforeOrder
    })
  }
  
  if (!mock) {
    responses.forEach(response => {
      if (response.status == 200) {
        logger.info('order', response)
      }
      else {
        logger.error('order error', response, orders)
      }
    })
  }
  return responses[0]
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
  if (!mock) {
    logger.info('orderQueue -->',ord)
  }
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
    return ({
      status: 400,
      obj:{
        ordStatus:'Duplicate',
        error: {message: 'Duplicate'}
      }
    }) 
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
  if (!mock) {
    if (response.status == 200) {
      logger.info('orderQueue', response)
    }
    else {
      logger.error('orderQueue error', response, ord)
    }
  }
  popOrderQueue(ord)
  return response
} catch(e) {logger.error(e.stack||(e));debugger} }

async function orderBulkRetry(ord) { try {
  if (!mock) {
    logger.info('orderBulkRetry -->', ord)
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

    // retry overloaded status only with the entry order
    retry = (response.status == 503 && ord.cancelAllBeforeOrder) 
            && count < 8 && !ord.obsoleted

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
  } while(retry && await wait(waitTime))
  if (ord.obsoleted) {
    logger.info('orderBulkRetry obsoleted',ord)
  }
  if (!mock) {
    if (response.status == 200) {
      logger.info('orderBulkRetry', response)
    }
    else {
      logger.error('orderBulkRetry error', response, ord)
    }
  }
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderBulk(orders) { try {
  if (!mock) {
    logger.info('orderBulk -->', orders)
  }
  orders.forEach(o => {
    o.symbol = symbol
  })

  var response

  if (orders[0].execInst == 'ParticipateDoNotInitiate,ReduceOnly' ||
      orders[0].execInst == 'LastPrice,Close') {
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

function getOrderQtyBTC(order) {
  return Math.abs(order.orderQty/getRate('XBTUSD'))
}

function ordersTooSmall(orders){
  return orders.filter(o => {
    return getOrderQtyBTC(o) < setup.bankroll.minOrderSizeBTC
  })
}

async function orderNewBulk(orders) { try {
  if (!mock) {
    logger.info('orderNewBulk -->', orders)
  }
  var tooSmall = ordersTooSmall(orders)
  if (tooSmall.length > 0) {
    return ({status:400,message:'orderTooSmall'})
  }
  if (orders.length > 1) {
    debugger
  }
  var response = await client.apis.Order.Order_new(orders[0])
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
    response.obj = [response.obj] // bulk order was removed
    response.data = undefined
    response.statusText = undefined
    logger.info('orderNewBulk',response)
  }
  return response
} catch(e) {logger.error(e.stack||(e.url+'\n'+e.statusText));debugger} }

async function orderAmendBulk(orders) { try {
  // TODO change it to Order_amend
  let response = await client.apis.Order.Order_amend(orders[0]) //Bulk({orders:JSON.stringify(orders)})
  .catch(function(e) {
    e.data = undefined
    e.statusText = undefined
    // console.error('orderAmendBulk error',e)
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
    else if (e.obj.error.message.indexOf('Invalid amend: orderQty, leavesQty, price, stopPx unchanged')) {
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
      else if (status.source == '.+') {
        // For UI
        return orders.find(({price}) => {
          return (price == p)
        })
      }
      switch(e) {
        case 'ParticipateDoNotInitiate': {
          // Entry orderQty may not be exact, depending on the margin. We can ignore similar entry orders with similar orderQty.
          return orders.find(({price, orderQty}) => {
            return (p == 'any' || (price == p && orderQty >= (q*0.98) && orderQty <= (q*1.02)))
          })
        }
        case 'Close,ParticipateDoNotInitiate': {
          // Close toolong or funding
          // The close orderQty was sent as null. Bitmex server filled it as available position qty.
          return orders.find(({price}) => {
            return (price == p)
          })
        }
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
        return (stopPx != 1 && (spx == 'any' || stopPx == spx))
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
      if(o.execInst == 'LastPrice,Close') {
        return (a.stopPx != 1 && (a.execInst == o.execInst && a.side == o.side && a.ordType && o.ordType))
      }
      else {
        return (a.price == o.price)
      } 
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

const makerFee = -0.0002
const takerFee = 0.00075
function getCost({side,cumQty,price,execInst}) {
  var foreignNotional = (side == 'Buy' ? -cumQty : cumQty)
  var homeNotional = (-foreignNotional / price) * 100000000
  var coinPairRate = 1 //lastPrice/XBTUSDRate
  var fee = execInst.indexOf('ParticipateDoNotInitiate') >= 0 ? makerFee : takerFee
  var execComm = Math.round(Math.abs(homeNotional * coinPairRate) * fee * 100000000)
  return [homeNotional,foreignNotional,execComm]
}

async function initMarket() { try {
  console.log('Initializing market')
  await getCurrentMarket()
  let currentTradeBucketed = await getCurrentTradeBucketed(setup.candle.interval)
  currentCandle = currentTradeBucketed.candle
  if (!currentTradeBucketed.candle.open) {
    var open = marketCache.closes[marketCache.closes.length-1]
    currentCandle.open = currentCandle.high = currentCandle.low = currentCandle.close = open
  }
  console.log('Initialized market')
} catch(e) {logger.error(e.stack||e);debugger} }

async function initOrders() { try {
  console.log('Initializing orders')
  var orders = await getOrders({})
  await handleOrder(orders)

  var newOrders = await getNewOrders()
  if (newOrders.length == 0) {
    // Order websocket stream will time out when there is no open order.
    // It's okay to leave this dummy stop market around.
    // It will get canceled later.
    console.log('Adding dummy stop market to activate order websocket stream')
    await orderBulk([{
      stopPx: 1,
      side: 'Sell',
      ordType: 'Stop',
      execInst: 'LastPrice,Close'
    }])
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function getHistoryCSV(start,end) {
  const startTime = new Date(start).getTime()
  const endTime = new Date(end).getTime()
  var allTransactions = [], deposits = [], trades = [], fundings = []

  var walletTransactions = await getWalletHistory()
  walletTransactions = walletTransactions.filter(t => {
    let transactTime = new Date(t.transactTime).getTime() 
    return (transactTime >= startTime && transactTime <= endTime)// && (t.transactType != 'RealisedPNL')
  })
  walletTransactions.forEach(t => {
    let wt = {
      time: t.transactTime,
      type: t.transactType,
      side: '',
      size: t.amount,
      price: 0,
      cost: (t.transactType == 'Deposit' ? t.amount : 0),
      feeRate: 0,
      feePaid: 0,
      balance: t.walletBalance
    }
    allTransactions.push(wt)
    // if (wt.type == 'Deposit') {
      deposits.push(wt)
    // }
  })
debugger
  var executionTransactions = await getUserExecutionHistory(start,end)
  console.log(executionTransactions.length)
  executionTransactions.forEach(t => {
    if (t.execType == 'Settlement') return
    let et = {
      time: t.transactTime,
      type: t.execType,
      side: t.side,
      size: t.lastQty,
      price: t.price,
      cost: (t.execType == 'Funding' ? 0 : -t.execCost),
      feeRate: t.commission,
      feePaid: t.execComm,
      balance: 0
    }
    allTransactions.push(et)
    if (et.type == 'Trade') {
      trades.push(et)
    }
    else if (et.type == 'Funding') {
      fundings.push(et)
    }
    else {
      debugger
    }
  })

  var allTransactionsCSV = getTransactionCSV(allTransactions)
  console.log(allTransactionsCSV)
  debugger

  // var depositsCSV = getTransactionCSV(deposits)
  // console.log(depositsCSV)

  // var tradesCSV = getTransactionCSV(trades)
  // console.log(tradesCSV)

  // var fundingsCSV = getTransactionCSV(fundings)
  // console.log(fundingsCSV)

  // var allTransactionsCSV = `Date,Type,Side,Size,Price,Cost,FeeRate,FeePaid,Balance
  // 2023-01-20T23:10:44.260Z,Deposit,,1000000,0,1000000,0,0,1000000
  // 2023-01-25T19:00:27.537Z,Trade,Buy,200,22714.5,880494,0.0002,176,0
  // 2023-01-25T20:00:00.000Z,Funding,,200,22756.09,0,0.0001,88,0
  // 2023-01-26T04:00:00.000Z,Funding,,200,23136.47,0,0.0001,86,0
  // 2023-01-26T05:25:22.012Z,Deposit,,26441059,0,26441059,0,0,27441059
  // 2023-01-26T12:00:00.000Z,RealisedPNL,,-350,0,0,0,0,27440709
  // 2023-01-26T12:00:00.000Z,Funding,,200,22991.63,0,0.0001,87,0
  // 2023-01-26T20:00:00.000Z,Funding,,200,23072.61,0,0.0001,87,0
  // 2023-01-27T04:00:00.000Z,Funding,,200,22773.76,0,0.0001,88,0
  // 2023-01-27T12:00:00.000Z,RealisedPNL,,-262,0,0,0,0,27440447
  // 2023-01-27T12:00:00.000Z,Funding,,200,22972.29,0,0.0001,87,0
  // 2023-01-27T20:00:00.000Z,Funding,,200,23257.23,0,0.00008,69,0
  // 2023-01-28T04:00:00.000Z,Funding,,200,23121.72,0,-0.000013,-11,0
  // 2023-01-28T12:00:00.000Z,RealisedPNL,,-145,0,0,0,0,27440302
  // 2023-01-28T12:00:00.000Z,Funding,,200,22982.97,0,0.0001,87,0
  // 2023-01-28T20:00:00.000Z,Funding,,200,23043.38,0,0.0001,87,0
  // 2023-01-28T20:02:29.022Z,Trade,Buy,9300,23032,40378647,0.0002,8075,0
  // 2023-01-29T04:00:00.000Z,Funding,,9500,23196.37,0,0.000077,3154,0
  // 2023-01-29T12:00:00.000Z,RealisedPNL,,-11403,0,0,0,0,27428899
  // 2023-01-29T12:00:00.000Z,Funding,,9500,23434.38,0,0.0001,4054,0
  // 2023-01-29T17:00:43.819Z,Trade,Buy,2300,23580,9754024,0.0002,1950,0
  // 2023-01-29T20:00:00.000Z,Funding,,11800,23905.23,0,0.0001,4936,0
  // 2023-01-30T01:34:08.952Z,Deposit,,24098808,0,24098808,0,0,51527707
  // 2023-01-30T04:00:00.000Z,Funding,,11800,23700.24,0,0.0001,4979,0
  // 2023-01-30T12:00:00.000Z,RealisedPNL,,-15919,0,0,0,0,51511788
  // 2023-01-30T12:00:00.000Z,Funding,,11800,23085.57,0,0.0001,5111,0
  // 2023-01-30T19:10:03.307Z,Trade,Sell,11800,22874.5,-51585824,0.00075,38689,0
  // 2023-01-31T03:02:16.005Z,Trade,Buy,5700,22842,24954030,0.0002,4990,0
  // 2023-01-31T04:00:00.000Z,Funding,,5700,22833.29,0,0.000094,2347,0
  // 2023-01-31T05:00:28.734Z,Trade,Buy,1800,22857.5,7874874,0.0002,1574,0
  // 2023-01-31T05:00:28.740Z,Trade,Buy,2400,22857.5,10499832,0.0002,2099,0
  // 2023-01-31T05:00:28.745Z,Trade,Buy,1300,22857.5,5687409,0.0002,1137,0
  // 2023-01-31T12:00:00.000Z,RealisedPNL,,-628606,0,0,0,0,50883182
  // 2023-01-31T12:00:00.000Z,Funding,,11200,22862.85,0,-0.000067,-3282,0
  // 2023-01-31T14:02:11.434Z,Trade,Buy,3800,23107.5,16444880,0.0002,3288,0
  // 2023-01-31T18:00:13.861Z,Trade,Buy,3100,23135,13399626,0.0002,2679,0
  // 2023-01-31T18:00:14.184Z,Trade,Buy,600,23135,2593476,0.0002,518,0
  // 2023-01-31T20:00:00.000Z,Funding,,18700,23167.45,0,0.000034,2744,0
  // 2023-02-01T04:00:00.000Z,Funding,,18700,23129.15,0,-0.000081,-6549,0
  // 2023-02-01T12:00:00.000Z,RealisedPNL,,602,0,0,0,0,50883784
  // 2023-02-01T12:00:00.000Z,Funding,,18700,23075.19,0,-0.000067,-5430,0
  // 2023-02-01T20:00:00.000Z,Funding,,18700,23384.38,0,-0.000037,-2959,0
  // 2023-02-02T04:00:00.000Z,Funding,,18700,23857.79,0,0.0001,7838,0
  // 2023-02-02T12:00:00.000Z,RealisedPNL,,551,0,0,0,0,50884335
  // 2023-02-02T12:00:00.000Z,Funding,,18700,23828.6,0,0.0001,7848,0
  // 2023-02-02T20:00:00.000Z,Funding,,18700,23808.05,0,0.0001,7854,0
  // 2023-02-03T04:00:00.000Z,Funding,,18700,23534.59,0,0.0001,7946,0
  // 2023-02-03T12:00:00.000Z,RealisedPNL,,-23648,0,0,0,0,50860687
  // 2023-02-03T12:00:00.000Z,Funding,,18700,23537.38,0,0.0001,7945,0
  // 2023-02-03T20:00:00.000Z,Funding,,18700,23312.98,0,0.000078,6257,0
  // 2023-02-04T04:00:00.000Z,Funding,,18700,23344.22,0,-0.000017,-1362,0
  // 2023-02-04T04:10:42.887Z,Deposit,,544998,0,544998,0,0,51405685
  // 2023-02-04T12:00:00.000Z,RealisedPNL,,-12840,0,0,0,0,51392845
  // 2023-02-04T12:00:00.000Z,Funding,,18700,23363.93,0,0.000079,6323,0
  // 2023-02-04T20:00:00.000Z,Funding,,18700,23430.03,0,0.0001,7981,0
  // 2023-02-05T04:00:00.000Z,Funding,,18700,23347.1,0,-0.00003,-2403,0
  // 2023-02-05T11:33:58.931Z,Deposit,,1002023,0,1002023,0,0,52394868
  // 2023-02-05T12:00:00.000Z,RealisedPNL,,-11901,0,0,0,0,52382967
  // 2023-02-05T12:00:00.000Z,Funding,,18700,23365.75,0,-0.00015,-12005,0
  // 2023-02-05T20:00:00.000Z,Funding,,18700,22898.02,0,-0.000102,-8330,0
  // 2023-02-06T04:00:00.000Z,Funding,,18700,22901.18,0,-0.000019,-1551,0
  // 2023-02-06T05:27:30.131Z,Trade,Sell,18700,22678.5,-82456902,0.00075,61842,0
  // 2023-02-06T12:00:00.000Z,RealisedPNL,,-1042731,0,0,0,0,51340236
  // 2023-02-06T12:02:21.496Z,Trade,Buy,500,22877.5,2185555,0.0002,437,0
  // 2023-02-06T12:02:21.780Z,Trade,Buy,10100,22877.5,44148211,0.0002,8829,0
  // 2023-02-06T20:00:00.000Z,Funding,,10600,23030.3,0,0.0001,4603,0
  // 2023-02-06T22:10:43.825Z,Deposit,,19193967,0,19193967,0,0,70534203
  // 2023-02-07T04:00:00.000Z,Funding,,10600,22877.45,0,0.0001,4633,0
  // 2023-02-07T06:04:07.731Z,Trade,Buy,4400,22926,19192184,0.0002,3838,0
  // 2023-02-07T06:04:07.734Z,Trade,Buy,7900,22926,34458694,0.0002,6891,0
  // 2023-02-07T10:01:54.509Z,Trade,Buy,500,23004,2173535,0.0002,434,0
  // 2023-02-07T10:01:54.662Z,Trade,Buy,1500,23004,6520605,0.0002,1304,0
  // 2023-02-07T10:01:54.664Z,Trade,Buy,1700,23004,7390019,0.0002,1478,0
  // 2023-02-07T10:01:54.666Z,Trade,Buy,1900,23004,8259433,0.0002,1651,0
  // 2023-02-07T10:01:54.667Z,Trade,Buy,4500,23004,19561815,0.0002,3912,0
  // 2023-02-07T12:00:00.000Z,RealisedPNL,,-38010,0,0,0,0,70496193
  // 2023-02-07T12:00:00.000Z,Funding,,33000,22979.18,0,0.00001,1436,0
  // 2023-02-07T13:01:00.095Z,Trade,Buy,100,23007,434650,0.0002,86,0
  // 2023-02-07T13:01:00.109Z,Trade,Buy,2500,23007,10866250,0.0002,2173,0
  // 2023-02-07T13:01:00.116Z,Trade,Buy,7400,23007,32164100,0.0002,6432,0
  // 2023-02-07T20:00:00.000Z,Funding,,43000,23092.81,0,-0.00003,-5586,0
  // 2023-02-08T04:00:00.000Z,Funding,,43000,23262.1,0,0.000062,11461,0
  // 2023-02-08T12:00:00.000Z,RealisedPNL,,-16002,0,0,0,0,70480191
  // 2023-02-08T12:00:00.000Z,Funding,,43000,23160.81,0,0.000019,3528,0
  // 2023-02-08T20:00:00.000Z,Funding,,43000,22876.33,0,0.000079,14849,0
  // 2023-02-09T03:03:32.432Z,Trade,Sell,36400,22663,-160614272,0.00075,120460,0
  // 2023-02-09T03:03:32.432Z,Trade,Sell,6600,22663,-29120454,0.00075,21840,0
  // `

    var lines = allTransactionsCSV.trim().split('\n')
    var allTransactions = []
    lines.shift()
    lines.forEach(line => {
      line = line.trim()

      let values = line.split(',')
      allTransactions.push({
          time: values[0],
          type: values[1],
          side: values[2],
          size: parseFloat(values[3]),
          price: parseFloat(values[4]),
          cost: parseFloat(values[5]),
          feeRate: parseFloat(values[6]),
          feePaid: parseFloat(values[7]),
          balance: parseFloat(values[8])
      })
    })

    var sells = allTransactions.filter((t,i) => {
      t.exitPrice = 0
      t.exitCost = 0
      t.pnlBTC = 0
      t.pnlBTCPercent = 0
      t.pnlUSDEnter = 0
      t.pnlUSDEnterPercent = 0
      t.pnlUSDExit = 0
      t.pnlUSDExitPercent = 0
      if (t.type == 'Trade' && t.side == 'Sell') {
        t.index = i
        return true
      }
      else {
        return false
      }
    })

    sells.forEach(sell => {
      let sellSize = sell.size
      for (let i = sell.index-1; i > 0; i--) {
        let t = allTransactions[i]
        if (t.type == 'Trade' && t.side == 'Buy') {
          let buySize = 0
          if (!t.exitPrice) {
            buySize = t.size
          }
          else if (t.pendingSellSize) {
            buySize = t.pendingSellSize
          }
          if (buySize > 0) {
            let balanceBTC
            for (let j = i - 1; j >= 0; j--) {
              let tBalance = allTransactions[j]
              if (tBalance.balance > 0) {
                balanceBTC = tBalance.balance / 100000000
                j = -1
              }
            }
            let balanceUSD = balanceBTC * t.price
            t.exitPrice = sell.price
            t.exitCost = - Math.round(t.size / sell.price * 100000000)
            t.pnlBTC = (t.cost + t.exitCost) / 100000000
            t.pnlBTCPercent = ((t.pnlBTC / balanceBTC * 10000) / 100).toFixed(2)
            t.pnlUSDEnter = t.pnlBTC * t.price
            t.pnlUSDEnterPercent = ((t.pnlUSDEnter / balanceUSD * 10000) / 100).toFixed(2)
            t.pnlUSDExit = t.pnlBTC * sell.price 
            t.pnlUSDExitPercent = ((t.pnlUSDExit / balanceUSD * 10000) / 100).toFixed(2)
            sellSize -= buySize
            if (sellSize == 0) {
              i = -1
            }
            else if (sellSize < 0) {
              t.pendingSellSize = -sellSize
              i = -1
            }
          }
        }
      }
    })
    allTransactionsCSV = getTransactionCSV(allTransactions)
  console.log(allTransactionsCSV)
  debugger
}

function getTransactionCSV(transactions) {
  transactions.sort((a,b) => {
    return (new Date(a.time).getTime() - new Date(b.time).getTime())
  })
  var csv = 'Date,Type,Side,Size,Price,Cost,FeeRate,FeePaid,Balance,exitPrice,exitCost,pnlBTC,pnlBTCPercent,pnlUSDEnter,pnlUSDEnterPercent,pnlUSDExit,pnlUSDExitPercent'
  transactions.forEach(t => {
    csv += '\n' + t.time + ',' + t.type + ',' + t.side + ',' + t.size + ',' + t.price + ',' + t.cost + ',' + t.feeRate + ',' + t.feePaid + ',' + t.balance + ',' + t.exitPrice + ',' + t.exitCost + ',' + t.pnlBTC + ',' + t.pnlBTCPercent + ',' + t.pnlUSDEnter + ',' + t.pnlUSDEnterPercent + ',' + t.pnlUSDExit + ',' +t.pnlUSDExitPercent
  })
  return csv
}

async function init(strategy,checkPositionCb) { try {
  console.log('bitmex init')
  lastMargin = {}
  lastInstrument = {}
  lastPosition = {}
  lastOrders = []
  lastXBTUSDInstrument = {}
  lastRates = {}
  marketCache = null

  checkPositionCallback = checkPositionCb
  client = await authorize()
  if (!client) {
    console.log('failed authorize')
    return
  }
  // inspect(client.apis)
  // await getHistoryCSV('2023-01-20T00:00:00.000Z','2023-03-23T00:00:00.000Z')
  // await cancelAll()
  // var testOrder = await order([
  //   {
  //     stopPx: 30200,
  //     side: 'Sell',
  //     ordType: 'Stop',
  //     execInst: 'LastPrice,Close'
  //   }
  // ])
  // debugger
  // [
  //   {
  //     price: 30259.5,
  //     side: 'Buy',
  //     orderQty: 84700,
  //     ordType: 'Limit',
  //     execInst: 'ParticipateDoNotInitiate'
  //   },
  //   {
  //     stopPx: 29954.5,
  //     side: 'Sell',
  //     ordType: 'Stop',
  //     execInst: 'LastPrice,Close'
  //   }
  // ]
  // debugger
  await initMarket()
  await initOrders()
  await updateLeverage(0) // cross margin
  await connect(handleInterval,handleMargin,handleOrder,handlePosition,handleInstrument,handleXBTUSDInstrument)
} catch(e) {logger.error(e.stack||e);debugger} }

if (mock) {
  authorize = mock.authorize
  getTradeBucketed = mock.getTradeBucketed
  getCurrentTradeBucketed = mock.getCurrentTradeBucketed
  initOrders = mock.initOrders
  updateLeverage = mock.updateLeverage
  connect = mock.connect
  cancelAll = mock.cancelAll
  orderNewBulk = mock.orderNewBulk
  orderAmendBulk = mock.orderAmendBulk
  cancelOrders = mock.cancelOrders
  getOrders = mock.getOrders
  getWalletHistory = mock.getWalletHistory
}

module.exports = {
  name: name,
  symbols: symbols,
  init: init,
  getMarket: getMarket,
  updatePosition: updatePosition,
  getCurrentMarket: getCurrentMarket,
  getPosition: getPosition,
  getInstrument: getInstrument,
  getQuote: getQuote,

  getOrders: getOrders,
  getFundingHistory: getFundingHistory, 
  getWalletHistory: getWalletHistory,
  getCurrentCandle: getCurrentCandle,
  getNextFunding: getNextFunding,
  getRate: getRate,

  findOrders: findOrders,
  getCumQty: getCumQty,
  ordersTooSmall: ordersTooSmall,

  getCandleTimeOffset: getCandleTimeOffset,
  getLastCandle: getLastCandle,

  position: position,

  order: order,
  cancelAll: cancelAll,
  cancelOrders: cancelOrders,

  lastOrders: lastOrders,
  getCost: getCost
}
