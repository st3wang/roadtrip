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


const symbols = ["COMPUSD","UMAUSD","IOTXUSD","RENUSD","CRVUSD","QUICKUSD","XTZUSD","GTCUSD","DASHUSD","TRBUSD","YFIUSD","OXTUSD","BALUSD","CHZUSD","AXSUSD","ANKRUSD","TRUUSD","QNTUSD","XLMUSD","FORTHUSD","MASKUSD","ETCUSD","DOGEUSD","ALGOUSD","ZRXUSD","BANDUSD","OGNUSD","SUSHIUSD","REPUSD","CLVUSD","GRTUSD","REQUSD","BATUSD","OMGUSD","COTIUSD","RLCUSD","BNTUSD","MATICUSD","UNIUSD","DAIUSD","LTCUSD","SNXUSD","ETHUSD","TRIBEUSD","NKNUSD","LRCUSD","BTCUSD","ICPUSD","STORJUSD","NMRUSD","DOTUSD","CTSIUSD","BCHUSD","SOLUSD","MKRUSD","MIRUSD","BONDUSD","FARMUSD","FETUSD","ENJUSD","ATOMUSD","SKLUSD","KNCUSD","1INCHUSD","EOSUSD","ADAUSD","MANAUSD","ZECUSD","LINKUSD","MLNUSD","AAVEUSD","KEEPUSD","ORNUSD","LPTUSD","NUUSD","YFIIUSD","FILUSD"]

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

function sendEmail(entrySignal) {
  const {entryOrders} = entrySignal
  const {side,price,orderQty} = entryOrders[0]
  email.send('MoonBoy Enter ' + side + ' ' + price + ' ' + orderQty, JSON.stringify(entrySignal, null, 2))
}

function getAverageOrder(orders, costUSD) {
  var order = {
    price: 0,
    size: 0
  }
  var cost = 0
  for (let i = 0; i < orders.length; i++) {
    let {price, size} = orders[i]
    order.size += size
    cost += (price * size)
    if (cost >= costUSD) {
      i = orders.length
    }
  }
  order.price = cost / order.size
  return order
}

async function checkSymbol(symbol) {
  var coinbaseBook = await coinbase.getBook(symbol)
  var coinbaseAsk = getAverageOrder(coinbaseBook.asks, 10000)
  var coinbaseBid = getAverageOrder(coinbaseBook.bids, 10000)
  var binanceBook = await binance.getBook(symbol)
  var binanceAsk = getAverageOrder(binanceBook.asks, 10000)
  var binanceBid = getAverageOrder(binanceBook.bids, 10000)
  var binancePremium = (binanceBid.price - coinbaseAsk.price) / coinbaseAsk.price
  var coinbasePremium = (coinbaseBid.price - binanceAsk.price) / binanceAsk.price
  // if (binancePremium > 0) {
    // console.log(symbol, 'binancePremium', binancePremium)
    if (binancePremium > 0.01) {
      email.send(symbol + ' binancePremium ' + (Math.round(binancePremium*10000)/100) + '%')
    }
  // }
  // if (coinbasePremium > 0) {
    // console.log(symbol, 'coinbasePremium',coinbasePremium)
    if (coinbasePremium > 0.01) {
      email.send(symbol + ' coinbasePremium ' + (Math.round(coinbasePremium*10000)/100) + '%')
    }
  // }
}

async function checkPosition() {
  // var binanceSymbols = await binance.getProducts()
  // var matchSymbols = []
  // symbols.forEach(s => {
  //   if (binanceSymbols.indexOf(s) > -1) {
  //     matchSymbols.push(s)
  //   }
  //   else {
  //     console.log(s)
  //   }
  // })
  // debugger
  // var cbSymbols = {}
  // var coinbaseSymbols = symbols.forEach(s => {
  //   cbSymbols[s] = s.replace('USD', '-USD')
  // })
  // console.log('coinbase', cbSymbols)
  // var bnSymbols = {}
  // var binanceSymbols = symbols.forEach(s => {
  //   bnSymbols[s] = s.replace('USD', '-USD')
  // })
  // console.log('binance', bnSymbols)
  // debugger
  for (let i = 0; i < symbols.length; i++) {
    await checkSymbol(symbols[i])
  }
}

async function init() {
  var now = getTimeNow()
}

module.exports = {
  init: init,
  checkPosition: checkPosition
}

