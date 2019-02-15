const util = require('util')
var SwaggerClient = require("swagger-client")
var _ = require('lodash')
var BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
var padStart = require('string.prototype.padstart');
var talib = require('talib');
const talibExecute = util.promisify(talib.execute)
const shoes = require('./shoes');

var client

async function initClient() {
  let swaggerClient = await new SwaggerClient({
    // Switch this to `www.bitmex.com` when you're ready to try it out for real.
    // Don't forget the `www`!
    url: 'https://testnet.bitmex.com/api/explorer/swagger.json',
    usePromise: true
  })
  // Comment out if you're not requesting any user data.
  swaggerClient.clientAuthorizations.add("apiKey", new BitMEXAPIKeyAuthorization(shoes.key, shoes.secret));
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

function pad2(v) {
  return padStart(v,2,'0')
}

function getUTCTimeString(ms) {
  var local = new Date(ms)
  return local.getUTCFullYear() + '-' + pad2(local.getUTCMonth()+1) + '-' + pad2(local.getUTCDate()) + 'T' +
    pad2(local.getUTCHours()) + ':' + pad2(local.getUTCMinutes()) + ':00.000Z'
}

function getBucketTimes(length,interval,binSize) {
  var current = new Date()
  var currentMS = current.getTime()
  var offset = (length * 60000) + (currentMS % (interval * 60000))
  var bitMexOffset = binSize * 60000 // bitmet bucket time is one bucket ahead
  offset -= bitMexOffset
  var offsetIncrement = 8*60*60000
  var end = offsetIncrement - bitMexOffset
  var buckets = []
  for (; offset > end; offset-=offsetIncrement) {
    buckets.push({
      startTime: getUTCTimeString(currentMS - offset),
      endTime: getUTCTimeString(currentMS - (offset-offsetIncrement+1))
    })
  }
  return buckets
}

async function getRsi(data,length) {
  var result = await talibExecute({
    name: "RSI",
    inReal: data,
    startIdx: 0,
    endIdx: data.length - 1,
    optInTimePeriod: length
  })

  return Array(length).fill(0).concat(result.result.outReal)
}

async function getRsiSignal(closes,rsiLength,rsiOverbought,rsiOversold) {
  var rsis = await getRsi(closes,rsiLength)
  var len = closes.length
  var last0 = len - 1
  var last1 = len - 2
  var rsi = rsis[last0]
  var prsi = rsis[last1]
  var close = closes[last0]
  var shortCondition = prsi > rsiOverbought && rsi <= rsiOverbought 
  if (shortCondition) {
    return 'SHORT'
  }
  else {
    var longCondition = prsi < rsiOversold && rsi >= rsiOversold 
    if (longCondition) {
      return 'LONG'
    }
  }
}

function reduceCandle(group) {
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
  let pages = getBucketTimes(length,interval,binSize)
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
    let candle = reduceCandle(group)
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

function lowest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.min.apply( Math, array )
}

function highest(values,start,length) {
  start++
  var array = values.slice(start-length,start)
  return Math.max.apply( Math, array )
}

function getOrder(type,market,capitalUSD,riskPerTradePercent,profitFactor,stopLossLookBack) {
  let last = market.closes.length - 1
  let entryPrice = market.closes[last]
  let lossDistance, stopLoss, profitDistance, takeProfit, stopLossTrigger, takeProfitTrigger, lossDistancePercent, positionSizeUSD
  switch(type) {
    case 'SHORT':
      stopLoss = highest(market.highs,last,stopLossLookBack)
      lossDistance = Math.abs(stopLoss - entryPrice)
      profitDistance = lossDistance * profitFactor
      profitDistance =Math.round(profitDistance*2)/2;
      takeProfit = entryPrice - profitDistance
      stopLossTrigger = stopLoss - 0.5
      takeProfitTrigger = takeProfit + 0.5
      lossDistancePercent = lossDistance/entryPrice
      positionSizeUSD = -Math.round(capitalUSD * riskPerTradePercent / lossDistancePercent)
      break;
    case 'LONG':
      stopLoss = lowest(market.lows,last,stopLossLookBack)
      lossDistance = Math.abs(entryPrice - stopLoss)
      profitDistance = lossDistance * profitFactor
      profitDistance =Math.round(profitDistance*2)/2;
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss + 0.5
      takeProfitTrigger = takeProfit - 0.5
      lossDistancePercent = lossDistance/entryPrice
      positionSizeUSD = Math.round(capitalUSD * riskPerTradePercent / lossDistancePercent)
      break;
    default:
      debugger
  }
  return {
    type: type,
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    stopLoss: stopLoss,
    takeProfit: takeProfit,
    positionSizeUSD: positionSizeUSD,
    stopLossTrigger: stopLossTrigger,
    takeProfitTrigger: takeProfitTrigger
  }
}

async function getPosition() {
  var response = await client.Position.Position_get()  
  .catch(function(e) {
    console.log('Error:', e.statusText)
    debugger
  })
  var positions = JSON.parse(response.data.toString())
  return positions[0]
}

async function enter(order) {
  console.log('ENTER ', JSON.stringify(order))
  var response = await client.Order.Order_new({ordType:'Limit',symbol:'XBTUSD',
    orderQty:order.positionSizeUSD,
    price:order.entryPrice,
    
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('Limit Order Submitted')
  var response = await client.Order.Order_new({ordType:'StopLimit',symbol:'XBTUSD',execInst:'LastPrice',
    orderQty:-order.positionSizeUSD,
    price:order.stopLoss,
    stopPx:order.stopLossTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('StopLimit Order Submitted')
  var response = await client.Order.Order_new({ordType:'LimitIfTouched',symbol:'XBTUSD',execInst:'LastPrice',
    orderQty:-order.positionSizeUSD,
    price:order.takeProfit,
    stopPx:order.takeProfitTrigger
  }).catch(function(e) {
    console.log(e.statusText)
    debugger
  })
  console.log('TakeProfitLimit Order Submitted')
}

async function next() {
  var market = await getMarket(8*60,15)
  var rsiSignal = await getRsiSignal(market.closes,11,55,25)
  console.log(padStart(rsiSignal||'-----',5,' '),new Date().toUTCString())
  
  if (!rsiSignal) return

  var capitalUSD = 100
  var riskPerTradePercent = 0.01
  var profitFactor = 1.39
  var stopLossLookBack = 4
  var minimumStopLoss = 0.001

  var position = await getPosition()
  var positionSize = position.currentQty

  if (positionSize == 0) {
    // enter condition
    var order = getOrder(rsiSignal,market,capitalUSD,riskPerTradePercent,profitFactor,stopLossLookBack)
    if (order.lossDistancePercent >= minimumStopLoss) {
      enter(order)
    }
    else {
      console.log('lossDistance too small', trade)
    }
  }
  else {
    console.log('already in a position', JSON.stringify(position))
  }
}

async function start() {
  client = await initClient()
  // inspect(client.apis)
  next()
  var now = new Date().getTime()
  var interval = 15*60000
  var startIn = interval-now%(interval) + 2000
  console.log('next one in ' + (startIn/60000).toFixed(2) + ' minutes')
  setTimeout(_ => {
    next()
    setInterval(next,interval)
  },startIn)
}

start()
