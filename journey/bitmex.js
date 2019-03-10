const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const shoes = require('./shoes')

const BitMEXRealtimeAPI = require('bitmex-realtime-api')

var client, exitTradeCallback, marketCache
var binSize = 5
var pendingOrder

async function connectWebSocketClient() {
  var ws = new BitMEXRealtimeAPI({
    testnet: shoes.bitmex.test,
    apiKeyID: shoes.bitmex.key,
    apiKeySecret: shoes.bitmex.secret,
    maxTableLen: 1
  })
  ws.on('error', console.error);
  ws.on('open', () => console.log('Connection opened.'));
  ws.on('close', () => console.log('Connection closed.'));
  // ws.on('initialize', () => console.log('Client initialized, data is flowing.'));
  
  ws.addStream('XBTUSD', 'execution', async function(data, symbol, tableName) {
    var exec = data[0]
    if (exec) {
      console.log('Execution', exec.ordStatus, exec.ordType, exec.execType, exec.price, exec.stopPx, exec.orderQty)
      if (exec.ordStatus === 'Filled') {
        console.log(exec)
        switch(exec.ordType) {
          case 'Limit':
            if (pendingOrder) {
              enterStops(pendingOrder)
              pendingOrder = null
            }
            break;
          case 'StopLimit':
          case 'LimitIfTouched':
          case 'Stop':
            exitTradeCallback([exec.timestamp,exec.price])
            // let position = await getPosition()
            // if (position.currentQty === 0) {
              // client.Order.Order_cancelAll({symbol:'XBTUSD'})
              //let margin = await getMargin()
              //console.log('Margin', margin.availableMargin/100000000, margin.marginBalance/100000000, margin.walletBalance/100000000)
              // exitTradeCallback([exec.timestamp,exec.price])
            // }
            break;
        }
      }

    }
  })

  // heartbeat
  setInterval(_ => {
    ws.socket.send('ping')
  },60000)

  return ws
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

async function getPosition() {
  var response = await client.Position.Position_get()  
  .catch(function(e) {
    console.log('Error:', e.statusText)
    debugger
  })
  var positions = JSON.parse(response.data.toString())
  return positions[0] || {currentQty:0}
}

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

async function enterStops(order) {
  let candelAllOrdersResponse = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  .catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Cancelled - All Orders')
  
  let stopLossOrderResponse = await client.Order.Order_new({ordType:'StopLimit',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly',
    orderQty:-order.positionSizeUSD,
    price:order.stopLoss,
    stopPx:order.stopLossTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - StopLimit Order ')

  let takeProfitOrderResponse = await client.Order.Order_new({ordType:'LimitIfTouched',symbol:'XBTUSD',execInst:'LastPrice,ReduceOnly',
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
  console.log('Margin', margin.availableMargin/100000000, margin.marginBalance/100000000, margin.walletBalance/100000000)

  console.log('ENTER ', JSON.stringify(order))

  pendingOrder = order

  let candelAllOrdersResponse = await client.Order.Order_cancelAll({symbol:'XBTUSD'})
  .catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Cancelled - All Orders')

  let updateLeverageResponse = await client.Position.Position_updateLeverage({symbol:'XBTUSD',leverage:order.leverage})
  .catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Updated - Leverage ')

  let limitOrderResponse = await client.Order.Order_new({ordType:'Limit',symbol:'XBTUSD',
    orderQty:order.positionSizeUSD,
    price:order.entryPrice
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - Limit Order ')

  return true
}

async function init(exitTradeCb) {
  exitTradeCallback = exitTradeCb
  client = await authorize().catch(e => {
    console.error(e)
    debugger
  })
  connectWebSocketClient()
  // inspect(client.apis)
}

module.exports = {
  init: init,
  getMarket: getTradeBucketed,
  getPosition: getPosition,
  getMargin: getMargin,
  // getOrder: getOrder,
  enter: enter
}