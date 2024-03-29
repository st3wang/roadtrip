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
  XBTUSD: 'BTC-USD',
  BTCUSDC: 'BTC-USDC',
  COMPUSD: 'COMP-USD',
  UMAUSD: 'UMA-USD',
  IOTXUSD: 'IOTX-USD',
  RENUSD: 'REN-USD',
  CRVUSD: 'CRV-USD',
  QUICKUSD: 'QUICK-USD',
  PAXUSD: 'PAX-USD',
  XTZUSD: 'XTZ-USD',
  GTCUSD: 'GTC-USD',
  DASHUSD: 'DASH-USD',
  TRBUSD: 'TRB-USD',
  YFIUSD: 'YFI-USD',
  OXTUSD: 'OXT-USD',
  BALUSD: 'BAL-USD',
  CHZUSD: 'CHZ-USD',
  AXSUSD: 'AXS-USD',
  ANKRUSD: 'ANKR-USD',
  TRUUSD: 'TRU-USD',
  QNTUSD: 'QNT-USD',
  XLMUSD: 'XLM-USD',
  FORTHUSD: 'FORTH-USD',
  MASKUSD: 'MASK-USD',
  ETCUSD: 'ETC-USD',
  DOGEUSD: 'DOGE-USD',
  ALGOUSD: 'ALGO-USD',
  ZRXUSD: 'ZRX-USD',
  BANDUSD: 'BAND-USD',
  OGNUSD: 'OGN-USD',
  SUSHIUSD: 'SUSHI-USD',
  REPUSD: 'REP-USD',
  CLVUSD: 'CLV-USD',
  GRTUSD: 'GRT-USD',
  REQUSD: 'REQ-USD',
  BATUSD: 'BAT-USD',
  OMGUSD: 'OMG-USD',
  COTIUSD: 'COTI-USD',
  RLCUSD: 'RLC-USD',
  BNTUSD: 'BNT-USD',
  MATICUSD: 'MATIC-USD',
  UNIUSD: 'UNI-USD',
  DAIUSD: 'DAI-USD',
  LTCUSD: 'LTC-USD',
  SNXUSD: 'SNX-USD',
  ETHUSD: 'ETH-USD',
  TRIBEUSD: 'TRIBE-USD',
  NKNUSD: 'NKN-USD',
  LRCUSD: 'LRC-USD',
  BTCUSD: 'BTC-USD',
  ICPUSD: 'ICP-USD',
  STORJUSD: 'STORJ-USD',
  NMRUSD: 'NMR-USD',
  DOTUSD: 'DOT-USD',
  CTSIUSD: 'CTSI-USD',
  BCHUSD: 'BCH-USD',
  SOLUSD: 'SOL-USD',
  MKRUSD: 'MKR-USD',
  MIRUSD: 'MIR-USD',
  BONDUSD: 'BOND-USD',
  FARMUSD: 'FARM-USD',
  FETUSD: 'FET-USD',
  ENJUSD: 'ENJ-USD',
  ATOMUSD: 'ATOM-USD',
  SKLUSD: 'SKL-USD',
  KNCUSD: 'KNC-USD',
  '1INCHUSD': '1INCH-USD',
  EOSUSD: 'EOS-USD',
  ADAUSD: 'ADA-USD',
  MANAUSD: 'MANA-USD',
  ZECUSD: 'ZEC-USD',
  LINKUSD: 'LINK-USD',
  MLNUSD: 'MLN-USD',
  AAVEUSD: 'AAVE-USD',
  KEEPUSD: 'KEEP-USD',
  ORNUSD: 'ORN-USD',
  LPTUSD: 'LPT-USD',
  NUUSD: 'NU-USD',
  YFIIUSD: 'YFII-USD',
  FILUSD: 'FIL-USD'
}

var mock, strategy, ws, wsKeepAliveInterval
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer, wait} = global

var position = {exchange:name}
var lastCandle, lastOrders = []

function orderString({timestamp,ordStatus,ordType,side,cumQty,orderQty,price=NaN,stopPx,execInst}) {
  return timestamp+' '+ordStatus+' '+ordType+' '+side+' '+cumQty+'/'+orderQty+' '+price+' '+stopPx+' '+execInst
}

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
        logger.info('coinbase pruneOrders',orderString(orders[found]))
      }
      orders.splice(found,1)
    }
  } while(found >= 0)
  return prunedCanceledOrder
} catch(e) {logger.error(e.stack||e);debugger} }

function handleOrder(orders) { try {
  if (!orders) {
    console.log('handleOrder orders is ', orders)
    return
  }
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
      if (o.ordType == 'Stop' && o.execInst == 'LastPrice,Close' && o.ordStatus == 'New' && o.stopPx > 1) {
        position.currentStopPx = o.stopPx
      }
    }
    else {
      console.warn('handleOrder invalid order',o)
    }
  })

  if (!mock) {
    lastOrders.forEach((o,i) => {
      console.log('coinbase handleOrder',orderString(o))
    })
    console.log('---------------------')
  }
  pruneOrders(lastOrders)
} catch(e) {logger.error(e.stack||e);debugger} }

async function handleOrderSubscription(o) { try {
  var waitTime = 5000
  await wait(waitTime)
  var order = await request('GET','/orders/'+o.order_id)
  while (order && order.message == 'NotFound' && waitTime < 20000) {
    console.log('handleOrderSubscription waitTime',waitTime)
    waitTime *= 2
    await wait(waitTime)
    order = await request('GET','/orders/'+o.order_id)
  }
  if (order && !order.message) {
    let orders = translateOrders([order])
    handleOrder(orders)
  }
  else {
    console.log('handleOrderSubscription order is ', order)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function updatePosition() { try {
  var accounts = await request('GET','/accounts')
  var retryGetAccounts = 0
  while (!accounts && retryGetAccounts < 15) {
    retryGetAccounts++
    console.log('retryGetAccounts',retryGetAccounts)
    await wait(1000)
    accounts = await request('GET','/accounts')
  } 
  if (!accounts) {
    console.error('coinbase updatePosition unable to get accounts')
  }
  const accountUSD = accounts.find(a => {return a.currency == 'USD' && a.balance > 0})
  const accountBTC = accounts.find(a => {return a.currency == 'BTC'})
  const balanceUSD = accountUSD.balance*1
  const balanceBTC = accountBTC.balance*1
  var {lastPrice} = await getQuote()

  const allDoneOrders = await coinbasedata.readAllOrders()
  allDoneOrders.sort((a,b) => {
    let aTime = new Date(a.created_at).getTime()
    let bTime = new Date(b.created_at).getTime()
    return bTime - aTime
  })

  var countBalanceBTC = balanceBTC
  var i = 0, activeTradeOrders = [], totalCostUSD = 0
  
  while (countBalanceBTC > 0) {
    let o = allDoneOrders[i]
    if (!o.stop) {
      if (o.status != 'done') {
        // update the order status. make sure it's not already filled.
        o = await request('GET','/orders/'+(o.id || o.order_id),undefined,true)
        allDoneOrders[i] = o
      }
      if (o.status == 'done') {
        let size = parseFloat(o.size)
        let valueUSD = size * o.price
        let costUSD = valueUSD + (o.fill_fees*1)
        countBalanceBTC = Math.round((countBalanceBTC - size)*10000000000)/10000000000
        activeTradeOrders.push(o)
        totalCostUSD += costUSD
      }
    }
    i++
  }
  var totalCostBTC = Math.round(((totalCostUSD) / lastPrice) * 100000000)

  position.marginBalance = Math.round((balanceUSD / lastPrice + balanceBTC) * 100000000)
  position.walletBalance = Math.round(((balanceUSD + totalCostUSD) / lastPrice) * 100000000)
  position.unrealisedPnl = Math.round((balanceBTC) * 100000000) - totalCostBTC
  position.positionSize = Math.round(balanceBTC*lastPrice)
  position.lastPrice = lastPrice
} catch(e) {logger.error(e.stack||e);debugger} }

async function getCurrentMarket(symbol) { try {
  const now = getTimeNow()
  const length = setup.candle.length
  const startTime = new Date(now-length*oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  const endTime = new Date(now-oneCandleMs).toISOString().substr(0,14)+'00:00.000Z'
  var marketCache
  if (mock) {
    marketCache = await coinbasedata.readMarket(symbol || symbols.XBTUSD,60,startTime,endTime)
  }
  else {
    marketCache = await coinbasedata.getMarket(symbol || symbols.XBTUSD,60,startTime,endTime)
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

function getCost({side,cumQty,price,execInst}) {
  var foreignNotional = (side == 'Buy' ? -cumQty : cumQty)
  var homeNotional = -foreignNotional / price
  var coinPairRate = 1 //lastPrice/XBTUSDRate
  var fee = 0.005
  var execComm = Math.round(Math.abs(homeNotional * coinPairRate) * fee * 100000000)
  return [homeNotional,foreignNotional,execComm]
}

async function request(method,path,body,noCache) { try {
  if (!noCache && method == 'GET' && path.startsWith('/orders') && path.length > 8) {
    var cachedOrder = await coinbasedata.readOrder(path.replace('/orders/',''))
    if (cachedOrder && cachedOrder.status == 'done') return cachedOrder
    await wait(200) // rate limit
  }
  return new Promise((resolve,reject) => {
    var timestamp = Math.round(Date.now() / 1000)
    body = body ? JSON.stringify(body) : body
  
    var what = timestamp + method + path + (body || '')
    var key = Buffer.from(exchange.coinbase.secret, 'base64')
    var hmac = crypto.createHmac('sha256', key)
    var signedMessage = hmac.update(what).digest('base64')

    const options = {
      method: method,
      hostname: exchange.coinbase.api,
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
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => {data += chunk})
      res.on('end', async() => {
        let value = JSON.parse(data)
        // if (path !== '/accounts' && !path.startsWith('/products')) {
        //   console.log('request end',method,path,value)
        // }
        if (value.id && 
            ((method == 'GET' && path.startsWith('/orders') && path.length > 8) ||
            (method == 'POST' && path.startsWith('/orders')))) {
          let ords = translateOrders([value])
          value.translatedOrder = ords[0]
          // write order cache
          coinbasedata.writeOrder(value)
        }
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
    bidPrice: ticker.bid*1,
    askPrice: ticker.ask*1,
    lastPrice: ticker.price*1
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function getBook(symbol) { try {
  // GET /products/<product-id>/book
  var orders = await request('GET','/products/' + symbols[symbol] + '/book?level=2')
  var book = {
    asks: [],
    bids: []
  }
  if (orders && orders.asks && orders.bids) {
    orders.asks.forEach(o => {
      book.asks.push({
        price: parseFloat(o[0]),
        size: parseFloat(o[1])
      })
    })
    orders.bids.forEach(o => {
      book.bids.push({
        price: parseFloat(o[0]),
        size: parseFloat(o[1])
      })
    })
  }
  else {
    debugger
  }
  return book
} catch(e) {logger.error(e.stack||e);debugger} }

async function getProducts() {
  var products = await request('GET','/products/')
  var symbols = []
  products.forEach(p => {
    if (p.quote_currency == 'USD') {
      symbols.push(p.base_currency + p.quote_currency)
    }
  })
  debugger
}

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
    if (o.translatedOrder) {
      return o.translatedOrder
    }
    let price = o.price*1
    let order = {
      cumQty: 1*(o.filled_size || o.size) * price,
      orderID: o.id || o.order_id,
      orderQty: 1*(o.size) * price,
      price: price,
      side: capitalizeFirstLetter(o.side),
      symbol: o.product_id,
      transactTime: o.created_at,
      timestamp: o.created_at,
      ordStatus: o.ordStatus || orderStatusMap[o.status]
    }
    if (o.stop == 'loss') {
      order.ordType = 'Market'
      order.execInst = 'LastPrice,Close'
      order.stopPx = o.stop_price
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
  for (let i = 0; i < orders.length; i++) {
    coinbasedata.writeOrder(orders[i])
  }
  const fills = await request('GET','/fills?product_id=BTC-USD')
  for (let i = 0; i < fills.length; i++) {
    if (!fills[i].order_id) debugger
    let o = await request('GET','/orders/'+fills[i].order_id)
    if (o) {
      o.ordStatus = 'Filled'
      if (new Date(o.done_at).getTime() > endTime) {
        orders.push(o)
      }
    }
  }
  return translateOrders(orders)
} catch(e) {logger.error(e.stack||e);debugger} }

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
      price: 777, // execute at market price
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
  var accountBTC = await request('GET','/accounts/' + exchange.coinbase.account_ids.BTC)
  var retryGetAccountBTC = 0
  while (!accountBTC && retryGetAccountBTC < 15) {
    retryGetAccounts++
    console.log('retryGetAccountBTC', retryGetAccountBTC)
    await wait(1000)
    accountBTC = await request('GET','/accounts/' + exchange.coinbase.account_ids.BTC)
  } 
  if (!accountBTC) {
    console.error('coinbase checkStopLoss unable to get accountBTC')
  }
  const availableBTC = 1*(accountBTC.available)
  const balanceBTC = 1*(accountBTC.balance)
  if (balanceBTC > 0) {
    const openStopLossOrders = await getOpenStopLossOrders()
    const entrySignal = await strategy.getEntrySignal(name)
    if (availableBTC > 0 || openStopLossOrders.length != 1 || 
      1*(openStopLossOrders[0].stop_price) != entrySignal.closeOrders[0].stopPx) {
      await cancelExit(openStopLossOrders)
      await orderExit(entrySignal.closeOrders[0], balanceBTC)
    }
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function subscribe() { try { 
  ws = new WebSocket(exchange.coinbase.ws)
  
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
        // console.log(data)
        if (data.reason == 'filled') {
          await request('GET','/orders/'+data.order_id,undefined,true)
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
    console.log('Coinbase WS closed. Reconnecting in 1000ms')
    setTimeout(subscribe, 1000)
  }
  
  ws.onerror = () => {
    console.error('Connection Error')
  }

  if (!wsKeepAliveInterval) {
    wsKeepAliveInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send('{"type":"unsubscribe","channels":["heartbeat"]}')
      }
      else {
        console.log('ws.readyState', ws.readyState)
      }
    }, 3000)
  }
} catch(e) {logger.error(e.stack||e);debugger} }

async function init(stg) { try {
  console.log('coinbase init')
  strategy = stg
  // const accounts = await request('GET','/accounts')
  // debugger
  // await request('POST','/orders',{
  //   product_id: 'BTC-USD',
  //   side: 'sell',
  //   price: 1, // execute at market price
  //   stop: 'loss',
  //   stop_price: 1000,
  //   size: 0.01
  // })
  // debugger
  // handleOrder(await getOrders({endTime:getTimeNow() - oneDayMS}))
  // await updatePosition()
  // await subscribe()
  // await checkStopLoss()
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
  getBook: getBook,
  getProducts: getProducts,
  getLastCandle: getLastCandle,
  getCurrentCandle: getCurrentCandle,
  getRate: getRate,
  order: order
}