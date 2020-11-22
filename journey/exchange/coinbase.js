var crypto = require('crypto')
const https = require('https')
var WebSocket = require('websocket').w3cwebsocket;
const coinbasedata = require('./coinbasedata')
const winston = require('winston')
const shoes = require('../shoes')
const {symbol,exchange,setup} = shoes
// const strategy = require('../strategy/' + shoes.strategy + '_strategy')
const oneDayMS = 24*60*60000
const oneCandleMs = setup.candle.interval*60000
const name = 'coinbase'
const symbols = {
  XBTUSD: 'BTC-USD'
}

var mock, strategy
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global

var position = {exchange:name}
var lastCandle, lastOrders = []

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

function handleOrder(orders) { try {
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
      if (o.ordType == 'Stop' && o.execInst == 'Close,LastPrice' && o.ordStatus == 'New' && o.stopPx > 1) {
        position.currentStopPx = o.stopPx
      }
    }
    else {
      console.warn('handleOrder invalid order',o)
    }
  })

  if (!mock) {
    lastOrders.forEach((order,i) => {
      console.log('handleOrder',order)
    })
    console.log('---------------------')
  }
  pruneOrders(lastOrders)
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleOrderSubscription(o) { try {
  let order = await request('GET','/orders/'+o.order_id)
  let orders = translateOrders([order])
  handleOrder(orders)
} catch(e) {logger.error(e.stack||e);debugger} }

async function updatePosition() { try {
  var accountUSD = await request('GET','/accounts/' + exchange.coinbase.account_ids.USD)
  var quote = await getQuote()
  position.marginBalance = accountUSD.balance * 100000000 / quote.lastPrice
} catch(e) {logger.error(e.stack||e);debugger} }

async function getCurrentMarket() { try {
  const now = getTimeNow()
  const length = setup.candle.length
  const startTime = new Date(now-length*oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  const endTime = new Date(now-oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  var marketCache
  if (mock) {
    marketCache = await coinbasedata.readMarket(symbols.XBTUSD,60,startTime,endTime)
  }
  else {
    marketCache = await coinbasedata.getMarket(symbols.XBTUSD,60,startTime,endTime)
  }
  lastCandle = marketCache.candles[setup.candle.length-1]
  // console.log('coinbase',new Date(now).toISOString())
  // console.log('startTime',startTime)
  // console.log('endTime',endTime)
  // console.log(marketCache.candles.length)
  // console.log(marketCache.candles[0].time)
  // console.log(marketCache.candles[marketCache.candles.length-1].time)
  return marketCache
} catch(e) {logger.error(e.stack||e);debugger} }

const makerFee = -0.00025
const takerFee = 0.00075
function getCost({side,cumQty,price,execInst}) {
  var foreignNotional = (side == 'Buy' ? -cumQty : cumQty)
  var homeNotional = -foreignNotional / price
  var coinPairRate = 1 //lastPrice/XBTUSDRate
  var fee = execInst.indexOf('ParticipateDoNotInitiate') >= 0 ? makerFee : takerFee
  var execComm = Math.round(Math.abs(homeNotional * coinPairRate) * fee * 100000000)
  return [homeNotional,foreignNotional,execComm]
}

async function request(method,path,body) { try {
  return new Promise((resolve,reject) => {
    var timestamp = Math.round(Date.now() / 1000)
    body = body ? JSON.stringify(body) : body
  
    var what = timestamp + method + path + (body || '')
    var key = Buffer.from(exchange.coinbase.secret, 'base64')
    var hmac = crypto.createHmac('sha256', key)
    var signedMessage = hmac.update(what).digest('base64')

    const options = {
      method: method,
      hostname: 'api-public.sandbox.pro.coinbase.com',
      // hostname: 'api.pro.coinbase.com',
      path: path,
      agent: false,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'CB-ACCESS-KEY': exchange.coinbase.key,
        'CB-ACCESS-SIGN': signedMessage,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'CB-ACCESS-PASSPHRASE': exchange.coinbase.passphrase,
        'Content-Type': 'application/',
      }
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
      options.headers['Content-Length'] = body.length
    }
    // const options = {
    //   hostname: 'encrypted.google.com',
    //   port: 443,
    //   path: '/',
    //   method: 'GET'
    // }
    const req = https.request(options, (res) => {
      // console.log('statusCode:', res.statusCode);
      // console.log('headers:', res.headers);
      let data = ''
      res.on('data', (chunk) => {data += chunk})
      res.on('end', () => {
        let value = JSON.parse(data)
        resolve(value)
      })
    })
    req.on('error', (e) => {
      console.error(e.message)
    })
    if (body) req.write(body)
    req.end()
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function getQuote() { try {
  // GET /products/<product-id>/ticker
  var ticker = await request('GET','/products/' + symbols[shoes.symbol] + '/ticker')
  return {
    bidPrice: parseFloat(ticker.bid),
    askPrice: parseFloat(ticker.ask),
    lastPrice: parseFloat(ticker.price)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function getCurrentCandle() { try {
  const now = getTimeNow()
  const start = new Date(now - (now % oneCandleMs)).toISOString()
  var market = await coinbasedata.getMarket(symbols[shoes.symbol], setup.candle.interval, start, start)
  return market.candles[0]
} catch(e) {logger.error(e.stack||e);debugger} }

function getLastCandle() {
  return lastCandle
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

const orderStatusMap = {
  open: 'New',
  active: 'New',
  done: 'Filled'
}

function translateOrders(orders) { try {
  const ords = orders.map(o => {
    let price = parseFloat(o.price)
    let order = {
      cumQty: parseFloat(o.filled_size || o.size) * price,
      orderID: o.id || o.order_id,
      orderQty: parseFloat(o.size) * price,
      price: price,
      side: capitalizeFirstLetter(o.side),
      symbol: o.product_id,
      transactTime: o.created_at,
      timestamp: o.created_at,
      ordStatus: o.ordStatus || orderStatusMap[o.status],
      ordType: capitalizeFirstLetter(o.type)
    }
    if (o.stop == 'loss') {
      order.ordType = 'Market'
      order.execInst = 'Close,LastPrice'
    }
    else {
      order.ordType = capitalizeFirstLetter(o.type)
      order.execInst = o.post_only ? 'ParticipateDoNotInitiate' : ''
    }
    return order
  })
  return ords
} catch(e) {logger.error(e.stack||e);debugger} }

async function getOrders({startTime,endTime}) { try {
  const orders = await request('GET','/orders')
  const fills = await request('GET','/fills?product_id=BTC-USD')
  for (let i = 0; i < fills.length; i++) {
    let o = await request('GET','/orders/'+fills[i].order_id)
    if (o) {
      o.ordStatus = 'Filled'
      orders.push(o)
    }
  }
  return translateOrders(orders)
} catch(e) {logger.error(e.stack||e);debugger} }
/*
created_at:'2020-11-16T02:15:40.325734Z'
executed_value:'0.0000000000000000'
fill_fees:'0.0000000000000000'
filled_size:'0.00000000'
id:'fa17bcb3-ca64-40b9-aa2c-ef5b2fc89600'
post_only:true
price:'888.00000000'
product_id:'BTC-USD'
profile_id:'b94f350d-755e-4285-8de5-8af773ca4a68'
settled:false
side:'buy'
size:'1.00000000'
status:'open'
time_in_force:'GTC'
type:'limit'

created_at:'2020-11-18T04:01:45.014Z'
fee:'0.9021930000000000'
liquidity:'M'
order_id:'b6394036-1376-46f5-9ae4-9f8d90e01a39'
price:'18043.86000000'
product_id:'BTC-USD'
profile_id:'6fa33f91-8ead-471a-a477-6c86840b63b8'
settled:true
side:'buy'
size:'0.01000000'
trade_id:19245305
usd_volume:'180.4386000000000000'
user_id:'5a4063bcd96aa305d74c4691'

// see base_strategy.js getEntryExitOrders
'Close,ParticipateDoNotInitiate' // close toolong or funding
'Close,LastPrice' // stop order
'ParticipateDoNotInitiate,ReduceOnly' // take profit order
execInst:'ParticipateDoNotInitiate' // 
ordStatus:'Filled'
ordType:'Limit'
stopPx:null
timestamp:'2020-11-15T09:00:34.397Z'
transactTime:'2020-11-15T09:00:06.078Z'
*/

function isPriceEqual(a,b) {
  return (a >= (b*0.99) && a <= (b*1.01))
}

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
            return (p == 'any' || (isPriceEqual(price,p) && orderQty >= (q*0.98) && orderQty <= (q*1.02)))
          })
        }
        case 'Close,ParticipateDoNotInitiate': {
          // Close toolong or funding
          // The close orderQty was sent as null. Bitmex server filled it as available position qty.
          return orders.find(({price}) => {
            return isPriceEqual(price,p)
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
        return (stopPx != 1 && (spx == 'any' || isPriceEqual(stopPx,spx)))
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

function getRate() {
  return 
}

async function cancelAll() { try  {
  const canceledOrderIds = await request('DELETE','/orders/')
  handleOrder(canceledOrderIds.map(oid => {
    return {
      orderID: oid,
      ordStatus: 'Canceled'
    }
  }))
} catch(e) {logger.error(e.stack||e);debugger} }

async function order(ords, cancelAllBeforeOrder) { try {
  if (cancelAllBeforeOrder) {
    await cancelAll()
  }
  const enterOrders = ords.filter(ord => {
    return ord.execInst == 'ParticipateDoNotInitiate'
  })
  const responses = await Promise.all(enterOrders.map(ord => {
    return orderEntry(ord)
  }))
  const response = responses.reduce((a,r) => {
    if (!r.created_at) return {status:400,message:r}
    else return a
  }, {status:200})
  response.orders = responses
  return response
  // res = await order({
  //   side: 'sell',
  //   product_id: 'BTC-USD',
  //   size: 0.01,
  //   stop: 'loss',
  //   stop_price: 16000,
  //   price: 1
  // })
} catch(e) {logger.error(e.stack||e);debugger} }

async function orderEntry(ord) { try {
  return new Promise(async(resolve,reject) => {
    let o = {
      product_id: 'BTC-USD',
      side: ord.side.toLowerCase(),
      price: ord.price,
      type: ord.ordType.toLowerCase(),
      post_only: true,
      size: Math.round(ord.orderQty / ord.price * 100000000) / 100000000
    }
    resolve(await request('POST','/orders', o))
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function orderExit(ord,size) { try {
  return new Promise(async(resolve,reject) => {
    let o = {
      product_id: 'BTC-USD',
      side: ord.side.toLowerCase(),
      price: 1, // execute at market price
      stop: 'loss',
      stop_price: ord.stopPx,
      size: size
    }
    resolve(await request('POST','/orders', o))
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function getOpenStopLossOrders() { try {
  const openOrders = await request('GET','/orders',{status:'open'})
  return openOrders.filter(o => {return o.stop == 'loss'})
} catch(e) {logger.error(e.stack||e);debugger} }

async function cancelExit(openStopLossOrders) { try {
  if (!openStopLossOrders || openStopLossOrders.length == 0) return
  const canceledOrderIds = await Promise.all(openStopLossOrders.map(o => {
    return request('DELETE','/orders/'+o.id)
  }))
  handleOrder(canceledOrderIds.map(oid => {
    return {
      orderID: oid,
      ordStatus: 'Canceled'
    }
  }))
} catch(e) {logger.error(e.stack||e);debugger} }

async function checkStopLoss() { try {
  const accountBTC = await request('GET','/accounts/' + exchange.coinbase.account_ids.BTC)
  const availableBTC = parseFloat(accountBTC.available)
  const balanceBTC = parseFloat(accountBTC.balance)
  const openStopLossOrders = await getOpenStopLossOrders()
  const entrySignal = await strategy.getEntrySignal(name)
  if (balanceBTC > 0) {
    if (availableBTC > 0 || openStopLossOrders.length != 1 || 
      parseFloat(openStopLossOrders[0].stop_price) != entrySignal.closeOrders[0].stopPx) {
      await cancelExit(openStopLossOrders)
      await orderExit(entrySignal.closeOrders[0], balanceBTC)
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function subscribe() { try { 
  var ws = new WebSocket('wss://ws-feed-public.sandbox.pro.coinbase.com')
  
  ws.onopen = () => {
    console.log('Coinbase WebSocket Connected')
    if (ws.readyState === ws.OPEN) {
      var timestamp = Math.round(Date.now() / 1000)
      var product_ids = ['BTC-USD']
      var channels = ['user']
      var what = timestamp + 'GET' + '/users/self/verify'
      var key = Buffer.from(exchange.coinbase.secret, 'base64')
      var hmac = crypto.createHmac('sha256', key)
      var signedMessage = hmac.update(what).digest('base64')

      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: product_ids,
        channels: channels,
        signature: signedMessage,
        key: exchange.coinbase.key,
        passphrase: exchange.coinbase.passphrase,
        timestamp: timestamp
      }))
    }
  }
  
  ws.onmessage = async(e) => {
    let data = JSON.parse(e.data)
    switch (data.type) {
      case 'subscriptions':
        break;
      case 'error':
        if (data.reason != 'Type has to be either subscribe or unsubscribe') {
          console.log(data)
          debugger
        }
        break;
      case 'done':
        //  reason: 'canceled',
        console.log(data)
        if (data.reason == 'filled') {
          await handleOrderSubscription(data)
          await checkStopLoss()
        }
        break;
      case 'activate':
      case 'open':
        console.log(data)
        await handleOrderSubscription(data)
        break;
      default:
        console.log(data)
    }
  }
  
  ws.onclose = () => {
    console.log('Closed')
  }
  
  ws.onerror = () => {
    console.log('Connection Error')
  }

  setInterval(() => {
    ws.send('{}')
  }, 12000)
} catch(e) {logger.error(e.stack||e);debugger} }

async function init(stg) { try {
  strategy = stg
  await updatePosition()
  await checkStopLoss()
  await subscribe()
  handleOrder(await getOrders({}))
} catch(e) {logger.error(e.stack||e);debugger} }

module.exports = {
  name: name,
  init: init,

  updatePosition: updatePosition,
  getCurrentMarket: getCurrentMarket,
  symbols: symbols,
  position: position,
  getCost: getCost,

  findOrders: findOrders,
  getQuote: getQuote,
  getLastCandle: getLastCandle,
  getCurrentCandle: getCurrentCandle,
  getRate: getRate,
  order: order
}