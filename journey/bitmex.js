const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const SwaggerClient = require("swagger-client")
const shoes = require('./shoes');

const BitMEXRealtimeAPI = require('bitmex-realtime-api');

var client, wsClient, exitTradeCallback

function connectWebSocketClient() {
  wsClient = new BitMEXRealtimeAPI({
    testnet: shoes.bitmex.test,
    apiKeyID: shoes.bitmex.key,
    apiKeySecret: shoes.bitmex.secret,
    maxTableLen: 1
  })
  wsClient.on('error', console.error);
  wsClient.on('open', () => console.log('Connection opened.'));
  wsClient.on('close', () => console.log('Connection closed.'));
  wsClient.on('initialize', () => console.log('Client initialized, data is flowing.'));
  
  wsClient.addStream('XBTUSD', 'execution', async function(data, symbol, tableName) {
    var exec = data[0]
    if (exec) {
      console.log('Execution', exec.ordStatus, exec.ordType, exec.execType, exec.price, exec.stopPx, exec.orderQty)
      if (exec.ordStatus === 'Filled' && (exec.ordType === 'StopLimit' || exec.ordType === 'LimitIfTouched')) {
        console.log(exec)
        let position = await getPosition()
        if (position.currentQty === 0) {
          client.Order.Order_cancelAll({symbol:'XBTUSD'})
          let margin = await getMargin()
          console.log('Margin', margin.availableMargin/100000000, margin.marginBalance/100000000, margin.walletBalance/100000000)
          exitTradeCallback([exec.timestamp,exec.price])
        }
      }
    }
  })

  // heartbeat
  setInterval(_ => {
    wsClient.socket.send('ping')
  },60000)
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

function getPageTimes(length,interval,binSize) {
  var current = new Date()
  var currentMS = current.getTime()
  var offset = (length * 60000) + (currentMS % (interval * 60000))
  var bitMexOffset = binSize * 60000 // bitmet bucket time is one bucket ahead
  offset -= bitMexOffset
  var offsetIncrement = 8*60*60000
  var end = offsetIncrement - bitMexOffset
  var pages = []
  for (; offset > end; offset-=offsetIncrement) {
    pages.push({
      startTime: new Date(currentMS - offset).toISOString(),
      endTime: new Date(currentMS - (offset-offsetIncrement+1)).toISOString()
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

async function getMarket(length,interval) {
  let binSize = 5
  let pages = getPageTimes(length,interval,binSize)
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
    // candles:candles,
    opens:opens,
    highs:highs,
    lows:lows,
    closes:closes
  }
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

async function enter(order,margin) {
  console.log('Margin', margin.availableMargin/100000000, margin.marginBalance/100000000, margin.walletBalance/100000000)

  console.log('ENTER ', JSON.stringify(order))

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

  let stopLossOrderResponse = await client.Order.Order_new({ordType:'StopLimit',symbol:'XBTUSD',execInst:'LastPrice',
    orderQty:-order.positionSizeUSD,
    price:order.stopLoss,
    stopPx:order.stopLossTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - StopLimit Order ')

  let takeProfitOrderResponse = await client.Order.Order_new({ordType:'LimitIfTouched',symbol:'XBTUSD',execInst:'LastPrice',
    orderQty:-order.positionSizeUSD,
    price:order.takeProfit,
    stopPx:order.takeProfitTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - TakeProfitLimit Order ')

  let stopMarketOrderResponse = await client.Order.Order_new({ordType:'StopMarket',symbol:'XBTUSD',execInst:'LastPrice',
    orderQty:-order.positionSizeUSD,
    stopPx:order.stopMarketTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Submitted - StopMarket Order ')

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
  getMarket: getMarket,
  getPosition: getPosition,
  getMargin: getMargin,
  enter: enter
}