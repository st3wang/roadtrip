const path = require('path')

const base = require('./base_strategy.js')
const shoes = require('../shoes')
const setup = shoes.setup

const bitmex = require('../exchange/bitmex')
const coinbase = require('../exchange/coinbase')
const bitstamp = require('../exchange/bitstamp')
const binance = require('../exchange/binance')
const bitfinex = require('../exchange/bitfinex')
const exchanges = {bitmex: bitmex, coinbase: coinbase, bitstamp: bitstamp, binance: binance, bitfinex: bitfinex}
var tradeExchanges

const winston = require('winston')
const email = require('../email/email.js')

const oneCandleMS = setup.candle.interval*60000

var mock
if (shoes.setup.startTime) mock = require('../mock.js')

const {getTimeNow, isoTimestamp, colorizer} = global

// "DAIUSD",
const symbols = [
  // "IOTXUSD", // different network
  // "KNCUSD", // Binance is KNC v2. Coinbase is v1.
  // "REPUSD", // Binance REP is v2. Coinbase is v1, does not support REPv2 trading
  // "TRIBEUSD", // Binance TRIBE withdrawal suspended
"COMPUSD","UMAUSD",
"RENUSD","CRVUSD","QUICKUSD","XTZUSD","GTCUSD","DASHUSD","TRBUSD","YFIUSD","OXTUSD","BALUSD","CHZUSD","AXSUSD","ANKRUSD","TRUUSD","QNTUSD","XLMUSD","FORTHUSD","MASKUSD","ETCUSD","DOGEUSD","ALGOUSD","ZRXUSD","BANDUSD","OGNUSD","SUSHIUSD",
"CLVUSD","GRTUSD","REQUSD","BATUSD","OMGUSD",
"COTIUSD",
"RLCUSD","BNTUSD","MATICUSD","UNIUSD",
"LTCUSD","SNXUSD","ETHUSD",
"NKNUSD","LRCUSD","BTCUSD","ICPUSD","STORJUSD","NMRUSD","DOTUSD","CTSIUSD","BCHUSD","SOLUSD","MKRUSD","MIRUSD","BONDUSD","FARMUSD","FETUSD","ENJUSD","ATOMUSD","SKLUSD",
"1INCHUSD","EOSUSD","ADAUSD","MANAUSD","ZECUSD","LINKUSD",
"MLNUSD",
"AAVEUSD","KEEPUSD","ORNUSD","LPTUSD","NUUSD","YFIIUSD","FILUSD"
]
const startCost = 10000

function typeColor(type) {
  return (type == 'LONG' ? '\x1b[36m' : type == 'SHORT' ? '\x1b[35m' : '') + type + '\x1b[39m'
}

function getStopRisk({exchange,positionSize,lastPrice,walletBalance,marginBalance,unrealisedPnl},stopLoss) {
  // console.log(positionSize,lastPrice,walletBalance,unrealisedPnl,stopLoss)
  const lastCost = exchanges[exchange].getCost({
    side: 'Sell',
    cumQty: -positionSize,
    price: lastPrice,
    execInst: 'Close,LastPrice'
  })
  // console.log('lastCost',lastCost)
  const stopCost = exchanges[exchange].getCost({
    side: 'Sell',
    cumQty: -positionSize,
    price: stopLoss,
    execInst: 'Close,LastPrice'
  })
  // console.log('stopCost',stopCost)

  marginBalance = walletBalance + unrealisedPnl
  
  const stopDistance = lastCost[0] - stopCost[0]
  const stopDistancePercent = stopDistance / lastCost[0] || 0
  const stopBalance = walletBalance + unrealisedPnl + stopDistance
  const stopPnlPercent = Math.round((stopBalance-walletBalance) / walletBalance * 10000) / 100
  const stopRisk = stopBalance-marginBalance
  const stopRiskPercent = Math.round(stopRisk / walletBalance * 10000) / 100

  const riskPerTradePercent = setup.exchange[exchange].riskPerTradePercent * 100
  const stopDistanceRiskRatio = Math.round(stopRiskPercent/stopDistancePercent/riskPerTradePercent/10) || 0

  // console.log(stopDistance.toFixed(0), stopDistancePercent.toFixed(2), stopRisk.toFixed(0), stopRiskPercent, stopDistanceRiskRatio)
  
  return {
    stopBalance: stopBalance,
    stopPnlPercent: stopPnlPercent,
    stopRiskPercent: stopRiskPercent,
    stopDistanceRiskRatio: stopDistanceRiskRatio
  }
}

const logger = winston.createLogger({
  format: winston.format.label({label:'acc'}),
  transports: [
    new winston.transports.Console({
      level: shoes.log.level || 'info',
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.prettyPrint(),
        winston.format.printf(info => {
          let splat = info[Symbol.for('splat')]
          let {timestamp,level,message} = info
          let prefix = timestamp.substring(5).replace(/[T,Z]/g,' ')+'['+colorizer.colorize(level,'bmx')+'] '
          let line = (typeof message == 'string' ? message : JSON.stringify(message)) + ' '
          switch(message) {
            case 'checkEntry': {
              let {exchange,caller,walletBalance,marginBalance,unrealisedPnl,lastPrice=NaN,positionSize,fundingTimestamp,fundingRate=NaN,signal,currentStopPx} = splat[0]
              let {timestamp,entryPrice=NaN,stopLoss=NaN,takeProfit=NaN,lossDistancePercent=NaN} = signal.signal || {}
              let marginBalanceString,marginPnlPercent,stopBalanceString,stopDistanceRiskRatioString,lossDistancePercentString, positionSizeString, lastPriceString
              stopLoss = currentStopPx || stopLoss
              walletBalance /= 100000000
              unrealisedPnl /= 100000000
              marginBalance /= 100000000
              marginPnlPercent = Math.round((marginBalance-walletBalance) / walletBalance * 10000) / 100
              marginBalanceString = (marginBalance > walletBalance ? '\x1b[32m' : (marginBalance < walletBalance ? '\x1b[31m' : '')) + marginBalance.toFixed(4) + ' ' + marginPnlPercent + '%\x1b[39m'

              let {stopBalance,stopPnlPercent,stopDistanceRiskRatio} = getStopRisk(splat[0],stopLoss) 
              stopBalance /= 100000000
              stopBalanceString = (stopBalance > walletBalance ? '\x1b[32m' : (stopBalance < walletBalance ? '\x1b[31m' : '')) + stopBalance.toFixed(4) + ' ' + stopPnlPercent + '%\x1b[39m'
              stopDistanceRiskRatioString = (stopDistanceRiskRatio < 70 ? '\x1b[32m' : '\x1b[31m') + stopDistanceRiskRatio + '\x1b[39m'

              if (positionSize > 0) {
                positionSizeString = '\x1b[36m' + positionSize + '\x1b[39m'
                lastPriceString = (lastPrice >= entryPrice ? '\x1b[32m' : '\x1b[31m') + lastPrice.toFixed(1) + '\x1b[39m'
              }
              else if (positionSize < 0) {
                positionSizeString = '\x1b[35m' + positionSize + '\x1b[39m'
                lastPriceString = (lastPrice <= entryPrice ? '\x1b[32m' : '\x1b[31m') + lastPrice.toFixed(1) + '\x1b[39m'
              }
              else {
                positionSizeString = positionSize
                lastPriceString = lastPrice.toFixed(1)
              }
              lossDistancePercentString = Math.abs(lossDistancePercent) < 0.002 ? lossDistancePercent.toFixed(4) : ('\x1b[34;1m' + lossDistancePercent.toFixed(4) + '\x1b[39m')
              let now = getTimeNow()
              let candlesInTrade = ((now - new Date(timestamp||null).getTime()) / oneCandleMS)
              candlesInTrade = (candlesInTrade >= setup.candle.inTradeMax || (Math.abs(lossDistancePercent) >= 0.002 && candlesInTrade >=3)) ? ('\x1b[33m' + candlesInTrade.toFixed(1) + '\x1b[39m') : candlesInTrade.toFixed(1)
              let candlesTillFunding = ((new Date(fundingTimestamp||null).getTime() - now)/oneCandleMS)
              candlesTillFunding = (candlesTillFunding > 1 ? candlesTillFunding.toFixed(1) : ('\x1b[33m' + candlesTillFunding.toFixed(1) + '\x1b[39m'))
              let payFunding = fundingRate*positionSize/lastPrice
              payFunding = (payFunding > 0 ? '\x1b[31m' : payFunding < 0 ? '\x1b[32m' : '') + payFunding.toFixed(5) + '\x1b[39m'
              line += exchange + ' ' + caller + ' B:'+walletBalance.toFixed(4)+' M:'+marginBalanceString+' S:'+stopBalanceString+' R:'+stopDistanceRiskRatioString+' P:'+positionSizeString+' L:'+lastPriceString+
                ' E:'+entryPrice.toFixed(1)+' S:'+stopLoss.toFixed(1)+' D:'+lossDistancePercentString
                //+' T:'+takeProfit.toFixed(1)+' C:'+candlesInTrade+' F:'+candlesTillFunding+' R:'+payFunding
            } break
            case 'ENTER SIGNAL': {
              let signal = splat[0]
              if (signal) {
                let {signalExchange,condition,type='',entryPrice=NaN,stopLoss=NaN,orderQtyUSD,lossDistance=NaN,riskAmountUSD=NaN,reason=''} = signal
                line += signalExchange+' '+typeColor(condition)+' '+typeColor(type)+' '+entryPrice.toFixed(1)+' '+stopLoss.toFixed(1)+' '+orderQtyUSD+' '+lossDistance.toFixed(1)+' '+riskAmountUSD.toFixed(4)+' '+reason
              }
            } break
            case 'ENTER ORDER': {
              let {orderQtyUSD,entryPrice} = splat[0].signal
              line =  (orderQtyUSD>0?'\x1b[36m':'\x1b[35m')+line+'\x1b[39m'+orderQtyUSD+' '+entryPrice
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

function getAverageOrder(orders, limitCost) {
  limitCost = limitCost || 0
  var order = {
    cost: 0,
    price: 0,
    size: 0
  }
  for (let i = 0; i < orders.length; i++) {
    let {price, size} = orders[i]
    let cost = price * size
    if (order.cost + cost < limitCost) {
      order.size += size
      order.cost += cost
    }
    else {
      i = orders.length
    }
  }
  order.price = order.cost / order.size
  debugger
  return order
}

function getPremium(bookA,bookB,cost) {
  var ask = bookA.asks[0] // getAverageOrder(bookA.asks, cost)
  var bid = bookB.bids[0] // getAverageOrder(bookB.bids, cost)

  return {
    premium: (bid.price - ask.price) / ask.price,
    ask: ask,
    bid: bid
  }
}

function getPremiumOrder(bookA,bookB,maxCost,minPremium) {
  console.log(getPremiumOrder, minPremium)
  var asks = bookA.asks
  var bids = JSON.parse(JSON.stringify(bookB.bids))
  var totalBuy = {
    cost: 0, size: 0
  }
  var totalSell = {
    cost: 0, size: 0
  }
  var depth = []
  var csv = 'totalPremium, totalProfit, totalBuySize, totalBuyCost, avgBuyPrice, avgsSellPrice, premium, profit, buySize, buyCost, buyPrice, sellPrice'
  asks.some(({price,size}) => {
    let askCost = price * size
    let bidCost = 0, bidSize = 0
    if (totalBuy.cost + askCost > maxCost) {
      return true
    }
    totalBuy.cost += askCost
    totalBuy.size = parseFloat((totalBuy.size + size).toPrecision(12))
    while (totalBuy.size > totalSell.size && bids.length > 0) {
      let bid = bids[0]
      let sizeToBeFilled = totalBuy.size - totalSell.size
      if (bid.size < sizeToBeFilled) {
        sizeToBeFilled = bid.size
        bids.shift()
      }
      else {
        bids[0].size -= sizeToBeFilled
      }
      let fillCost = bid.price * sizeToBeFilled
      bidCost += fillCost
      bidSize += sizeToBeFilled
      totalSell.cost += fillCost
      totalSell.size += sizeToBeFilled
    }
    let lastTrade = depth[depth.length-1] || {totalProfit:0,totalPremium:0}
    let trade = {
      buy: {
        totalCost: -totalBuy.cost,
        totalSize: totalBuy.size,
        avgPrice: parseFloat((totalBuy.cost / totalBuy.size).toPrecision(12)),
        totalFee: totalBuy.cost * -0.005,
        cost: -askCost,
        size: size,
        price: price,
        fee: askCost * -0.005
      },
      sell: {
        totalCost: totalSell.cost,
        totalSize: totalSell.size,
        avgPrice: parseFloat((totalSell.cost / totalSell.size).toPrecision(12)),
        totalFee: totalBuy.cost * -0.005,
        cost: bidCost,
        size: bidSize,
        price: parseFloat((bidCost / bidSize).toPrecision(12)),
        fee: bidCost * -0.005
      }
    }
    trade.totalProfit = trade.buy.totalCost + trade.buy.totalFee + trade.sell.totalCost + trade.sell.totalFee
    trade.totalPremium = trade.totalProfit / -trade.buy.totalCost
    trade.profit = trade.buy.cost + trade.buy.fee + trade.sell.cost + trade.sell.fee
    trade.premium = trade.profit / -trade.buy.cost
    
    let csvLine = '\n' + (Math.round(trade.totalPremium*10000)/100)+'%, ' + Math.round(trade.totalProfit*100)/100 + ', ' + trade.buy.totalSize + ', ' + Math.round(trade.buy.totalCost*100)/100 + ', ' + trade.buy.avgPrice + ', ' + trade.sell.avgPrice
    + ', ' + (Math.round(trade.premium*10000)/100)+'%, ' + Math.round(trade.profit*100)/100 + ', ' + trade.buy.size + ', ' + Math.round(trade.buy.cost*100)/100 + ', ' + trade.buy.price + ', ' + trade.sell.price
    csv += csvLine

    if (trade.premium > minPremium && 
      trade.totalProfit > lastTrade.totalProfit) {
      depth.push(trade)
    }
    else {
      // console.log('last line', csvLine)
      return true
    }
  })
  // console.log(csv)
  // debugger
  return {
    depth: depth,
    csv: csv
  }
}

async function buy(exchange, order) {
  console.log('buy', order)
  debugger
  var o = await exchange.marketBuy(order)
  console.log('buy marketBuy', o)
  var orderId = o.orderId
  if (orderId) {
    while(o.status !== 'FILLED') {
      o = await exchange.getOrder(orderId)
      console.log('buy getOrder', o)
      debugger
    }
  }
  var withdrawResult = await binance.withdraw({
    coin: order.symbol.replace('USD',''),
    amount: order.size,
    address: '0x37B3a3A8afEEC0e5D63e52c8158829aa9D7fc613' // COTI
  })
  console.log('buy withdraw', withdrawResult)
}

async function checkSymbol(symbol) { try {
  var coinbaseBook = await coinbase.getBook(symbol) //testBookCoinbase
  var binanceBook = await binance.getBook(symbol) // testBookCoinbase
  var premiumPercent
  // console.log('checkSymbol',symbol)
  if (!coinbaseBook || !coinbaseBook.asks || coinbaseBook.asks.length == 0 || !coinbaseBook.bids || coinbaseBook.bids.length == 0 ||
    !binanceBook || !binanceBook.asks || binanceBook.asks.length == 0 || !binanceBook.bids || binanceBook.bids.length == 0) {
      console.log('Invalid book', symbol, coinbaseBook, binanceBook)
      return 
    }
  const coinbasePremium = getPremium(binanceBook,coinbaseBook,startCost)
  // console.log('coinbasePremium',coinbasePremium)
  if (coinbasePremium.premium > 0.02) {
    premiumPercent = (Math.round(coinbasePremium.premium*10000)/100) + '%'
    let title = symbol + ' coinbasePremium ' + premiumPercent
    let body = startCost + ' ' + premiumPercent
    console.log(title)
    let premiumOrder = getPremiumOrder(binanceBook,coinbaseBook,100000,coinbasePremium.premium*0.6)
    let depth = premiumOrder.depth[premiumOrder.depth.length-1]
    if (depth && depth.totalProfit > 100) {
      console.log(premiumOrder.csv)
      debugger
      // buy(binance, {
      //   symbol: symbol,
      //   size: depth.buy.totalSize/2
      // })
      email.send(title,premiumOrder.csv)
    }
    return
  }
  const binancePremium = getPremium(coinbaseBook,binanceBook,startCost)
  // console.log('binancePremium',binancePremium)
  if (binancePremium.premium > 0.02) {
    premiumPercent = (Math.round(binancePremium.premium*10000)/100) + '%'
    let title = symbol + ' binancePremium ' + premiumPercent
    let body = startCost + ' ' + premiumPercent
    console.log(title)
    let premiumOrder = getPremiumOrder(coinbaseBook,binanceBook,100000,coinbasePremium.premium*0.6)
    let depth = premiumOrder.depth[premiumOrder.depth.length-1]
    if (depth && depth.totalProfit > 100) {
      console.log(premiumOrder.csv)
      debugger
      email.send(title,premiumOrder.csv)
    }
  }
  // console.log('done')
} catch(e) {console.error(e.stack||e);debugger} }

async function checkPosition() {
  console.log('checkPosition', new Date().toString())
  for (let i = 0; i < symbols.length; i++) {
    await checkSymbol(symbols[i])
  }
}

async function init() {
  var now = getTimeNow()
  // var response = await binance.marketBuy({
  //   symbol: 'BTCUSDC',
  //   size: 0.1
  // })
  
  // buy(binance, {
  //   symbol: 'USDCUSD',
  //   size: 100
  // })

}

module.exports = {
  init: init,
  checkPosition: checkPosition
}

