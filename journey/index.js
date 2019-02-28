const util = require('util')
const fs = require('fs');
const SwaggerClient = require("swagger-client")
const _ = require('lodash')
const BitMEXAPIKeyAuthorization = require('./lib/BitMEXAPIKeyAuthorization')
const padStart = require('string.prototype.padstart');
const talib = require('talib');
const shoes = require('./shoes');

const talibExecute = util.promisify(talib.execute)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

var client
const BitMEXRealtimeAPI = require('bitmex-realtime-api');
// See 'options' reference below
const wsClient = new BitMEXRealtimeAPI({
  testnet: true,
  apiKeyID: shoes.key,
  apiKeySecret: shoes.secret,
  maxTableLen: 1
});

// handle errors here. If no 'error' callback is attached. errors will crash the client.
wsClient.on('error', console.error);
wsClient.on('open', () => console.log('Connection opened.'));
wsClient.on('close', () => console.log('Connection closed.'));
wsClient.on('initialize', () => console.log('Client initialized, data is flowing.'));

wsClient.addStream('XBTUSD', 'execution', async function(data, symbol, tableName) {
  var exec = data[0]
  if (exec) {
    console.log('Execution', exec.ordStatus, exec.ordType, exec.execType, exec.price, exec.stopPx, exec.orderQty)
    if (exec.ordStatus === 'Filled' && (exec.ordType === 'StopLimit' || exec.ordType === 'LimitIfTouched')) {
      await client.Order.Order_cancelAll({symbol:'XBTUSD'})
      .catch(function(e) {
        console.log(e.statusText)
        debugger
      })
      let margin = await getMargin()
      console.log('Margin', margin.availableMargin/100000000, margin.marginBalance/100000000, margin.walletBalance/100000000)
    }
  }
});

if (!fs.existsSync('log')) {
  fs.mkdirSync('log');
}
if (!fs.existsSync('log/condition.csv')) {
  fs.writeFileSync('log/condition.csv','time,prsi,rsi,close,signalCondition,position,orderType\n',writeFileOptions)
}
if (!fs.existsSync('log/enter.csv')) {
  fs.writeFileSync('log/enter.csv','Time,Capital,Risk,R/R,Type,Entry,Stop,Target,Exit,P/L,StopPercent,Stop,Target,BTC,USD,BTC,USD,Leverage,BTC,Price,USD,Percent\n',writeFileOptions)
}

async function initClient() {
  let swaggerClient = await new SwaggerClient({
    // Switch this to `www.bitmex.com` when you're ready to try it out for real.
    // Don't forget the `www`!
    url: shoes.swagger,
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

// function getUTCTimeString(ms) {
//   var local = new Date(ms)
//   return local.getUTCFullYear() + '-' + pad2(local.getUTCMonth()+1) + '-' + pad2(local.getUTCDate()) + 'T' +
//     pad2(local.getUTCHours()) + ':' + pad2(local.getUTCMinutes()) + ':00.000Z'
// }

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
  var longCondition = prsi < rsiOversold && rsi >= rsiOversold 
  var signal = {
    rsis: rsis,
    length: rsiLength,
    overbought: rsiOverbought,
    oversold: rsiOversold,
    prsi: prsi,
    rsi: rsi,
    condition: '-'
  }
  if (shortCondition) {
    signal.condition = 'SHORT'
  }
  else if (longCondition) {
    signal.condition = 'LONG'
  }
  else if (prsi > rsiOverbought) {
    signal.condition = 'S'
  }
  else if (prsi < rsiOversold) {
    signal.condition = 'L'
  }
  return signal
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
    let candle = reduceCandle(group)
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

function getOrder(signal,market,bankroll,position,margin) {
  let signalCondition = signal.condition
  let positionSize = position.currentQty

  if (positionSize != 0 || signalCondition.length < 2) {
    return {type:'-'}
  }
  
  let capitalUSD = bankroll.capitalUSD
  let riskPerTradePercent = bankroll.riskPerTradePercent
  let profitFactor = bankroll.profitFactor
  let stopLossLookBack = bankroll.stopLossLookBack
  let last = market.closes.length - 1
  let entryPrice = market.closes[last]
  let availableMargin = margin.availableMargin*0.000000009
  let riskAmountUSD = capitalUSD * riskPerTradePercent
  let riskAmountBTC = riskAmountUSD / entryPrice
  let lossDistance, stopLoss, profitDistance, takeProfit, stopLossTrigger, takeProfitTrigger, 
    lossDistancePercent, positionSizeUSD, positionSizeBTC, leverage
  switch(signalCondition) {
    case 'SHORT':
      stopLoss = highest(market.highs,last,stopLossLookBack)
      lossDistance = Math.abs(stopLoss - entryPrice)
      profitDistance = -lossDistance * profitFactor
      profitDistance = Math.round(profitDistance*2)/2; // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss - 0.5
      takeProfitTrigger = takeProfit + 0.5
      lossDistancePercent = lossDistance/entryPrice
      positionSizeUSD = Math.round(riskAmountUSD / -lossDistancePercent)
      break;
    case 'LONG':
      stopLoss = lowest(market.lows,last,stopLossLookBack)
      lossDistance = -Math.abs(entryPrice - stopLoss)
      profitDistance = -lossDistance * profitFactor
      profitDistance = Math.round(profitDistance*2)/2; // round to 0.5
      takeProfit = entryPrice + profitDistance
      stopLossTrigger = stopLoss + 0.5
      takeProfitTrigger = takeProfit - 0.5
      lossDistancePercent = lossDistance/entryPrice
      positionSizeUSD = Math.round(capitalUSD * riskPerTradePercent / -lossDistancePercent)
      break;
    default:
      debugger
  }
  
  positionSizeBTC = positionSizeUSD / entryPrice
  leverage = Math.ceil(Math.abs(positionSizeBTC / availableMargin))

  return {
    type: (Math.abs(lossDistancePercent) < bankroll.minimumStopLoss) ? '-' : signalCondition,
    entryPrice: entryPrice,
    lossDistance: lossDistance,
    lossDistancePercent: lossDistance/entryPrice,
    profitDistance: profitDistance,
    stopLoss: stopLoss,
    takeProfit: takeProfit,
    stopLossTrigger: stopLossTrigger,
    takeProfitTrigger: takeProfitTrigger,
    riskAmountUSD: riskAmountUSD,
    riskAmountBTC: riskAmountBTC,
    positionSizeUSD: positionSizeUSD,
    positionSizeBTC: positionSizeBTC,
    leverage: leverage
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
  if (order.type.length < 2) {
    return
  }

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

  return true
}

function writeLog(rsiSignal,market,bankroll,position,margin,order,didEnter) {
  var isoString = new Date().toISOString()
  var signalCSV = isoString + ',' + rsiSignal.prsi.toFixed(2) + ',' + rsiSignal.rsi.toFixed(2) + ',' + market.closes[market.closes.length-1] + ',' +
    rsiSignal.condition + ',' + position.currentQty + ',' + order.type + '\n'
  console.log(signalCSV.replace('\n',''))
  fs.appendFile('log/condition.csv', signalCSV, e => {
    if (e) {
      console.log(e)
      debugger
    }
  })
  var prefix = 'log/'+isoString.replace(/\:/g,',')
  var content = JSON.stringify({rsiSignal:rsiSignal,market:market,bankroll:bankroll,position:position,margin:margin,order:order})
  fs.writeFile(prefix+'.json',content,writeFileOptions, e => {
    if (e) {
      console.log(e)
      debugger
    }
  })
  if (didEnter) {
      // Time,Capital,Risk,R/R,
      // Entry,Stop,Target,Exit,P/L,Stop,Target,BTC,USD,BTC,USD,Leverage,BTC,Price,USD,Percent
    var enterData = [isoString,bankroll.capitalUSD,bankroll.riskPerTradePercent,bankroll.profitFactor,
      order.type,order.entryPrice,order.stopLoss,order.takeProfit,'','',order.lossDistancePercent,order.lossDistance,order.profitDistance,
      order.riskAmountBTC,order.riskAmountUSD,order.positionSizeBTC,order.positionSizeUSD,order.leverage,'','','','']
    var enterCSV = enterData.toString()
    console.log(enterCSV)
    fs.appendFile('log/enter.csv', enterCSV+'\n', e => {
      if (e) {
        console.log(e)
        debugger
      }
    })
  }
}

async function next() {
  // let results = await Promise.all([
  //   getMarket(24*60,15),
  //   getPosition(),
  //   getMargin()
  // ]);
  let position = await getPosition()
  let margin = await getMargin()
  let market = await getMarket(24*60,15)
  let rsiSignal = await getRsiSignal(market.closes,11,70,35)
  let bankroll = {
    capitalUSD: 1000,
    riskPerTradePercent: 0.01,
    profitFactor: 1.69,
    stopLossLookBack: 2,
    minimumStopLoss: 0.001
  }

  // test
  // rsiSignal.condition = 'LONG'
  // position.currentQty = 0
  
  var order = getOrder(rsiSignal,market,bankroll,position,margin)
  var didEnter = await enter(order,margin)
  writeLog(rsiSignal,market,bankroll,position,margin,order,didEnter)
}

async function start() {
  client = await initClient()
  // inspect(client.apis)
  next()
  var now = new Date().getTime()
  var interval = 15*60000
  var delay = 15000 // bitmex bucket data delay. it will be faster with WS
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
