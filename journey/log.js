const fs = require('fs')
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const path = require('path')

const logDir = path.resolve(__dirname, 'log')
const conditionFile = logDir + '/condition.csv'
const entryFile = logDir + '/entry.csv'
const entryOrderFile = logDir + '/entry_order.json'

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir)
}
if (!fs.existsSync(conditionFile)) {
  fs.writeFileSync(conditionFile,'time,prsi,rsi,close,signalCondition,orderType,position,balance\n',writeFileOptions)
}
if (!fs.existsSync(entryFile)) {
  fs.writeFileSync(entryFile,'Time,Capital,Risk,R/R,Type,Entry,Stop,Target,StopMarket,StopPercent,StopDistance,TargetDistance,RiskBTC,RiskUSD,SizeBTC,SizeUSD,Leverage\n',writeFileOptions)
}

function csvToArray(csv) {
  return csv.split('\n').map(row => {
    return row.split(',')
  })
}

function writeInterval(rsiSignal,market,bankroll,position,margin,order,orderSent) {
  var isoString = order.created
  var signalCSV = isoString + ',' + rsiSignal.prsi.toFixed(2) + ',' + rsiSignal.rsi.toFixed(2) + ',' + market.closes[market.closes.length-1].toFixed(1) + ',' +
    rsiSignal.condition + ',' + order.type + ',' + position.currentQty + ',' + (margin.marginBalance/100000000).toFixed(4) + '\n'
  console.log(signalCSV.replace('\n',''))
  fs.appendFile(conditionFile, signalCSV, e => {
    if (e) {
      console.log(e)
    }
  })
  var dataFile = logDir+'/'+isoString.replace(/\:/g,',')+'.json'
  var content = JSON.stringify({rsiSignal:rsiSignal,market:market,bankroll:bankroll,position:position,margin:margin,order:order})
  fs.writeFile(dataFile,content,writeFileOptions, e => {
    if (e) {
      console.log(e)
    }
  })
  if (orderSent) {
    // Time,Capital,Risk,R/R,
    // Type,Entry,Stop,Target,StopMarket,StopPercent,StopDistance,TargetDistance,
    // RiskBTC,RiskUSD,SizeBTC,SizeUSD,Leverage
    entryOrdersCache = null
    var entryData = [isoString,bankroll.capitalUSD,bankroll.riskPerTradePercent,bankroll.profitFactor,
      order.type,order.entryPrice,order.stopLoss,order.takeProfit,order.stopMarketTrigger,order.lossDistancePercent,order.lossDistance,order.profitDistance,
      order.riskAmountBTC,order.riskAmountUSD,order.positionSizeBTC,order.positionSizeUSD,order.leverage]
    var entryCSV = entryData.toString()
    console.log(entryCSV)
    fs.appendFile(entryFile, entryCSV+'\n', e => {
      if (e) {
        console.log(e)
      }
    })
    // sheets.enterTrade(entryData).catch(e => {
    //   console.log(e)
    // })
  }
}
function writeExit(exitData) {
  // sheets.exitTrade(exitData).catch(e => {
  //   console.log(e)
  // })
}

function writeEntryOrder(order) {
  fs.writeFileSync(entryOrderFile,JSON.stringify(order),writeFileOptions)
}

function readEntryOrder() {
  if (!fs.existsSync(entryOrderFile)) {
    return
  }
  var str = fs.readFileSync(entryOrderFile,readFileOptions)
  return JSON.parse(str)
}

var entryOrdersCache

function readEntryOrders() {
  if (!entryOrdersCache) {
    if (!fs.existsSync(entryFile)) {
      return
    }
    var csv = fs.readFileSync(entryFile,readFileOptions)
    entryOrdersCache = csvToArray(csv)
  }
  
  return entryOrdersCache
}

function findEntryOrder(price,sizeUSD) {
  var orders = readEntryOrders()
  var found
  orders.forEach(order => {
    if (order[5] == ''+price && order[15] == ''+sizeUSD) {
      found = {
        timestamp: order[0],
        price: price,
        size: sizeUSD,
        stopLoss: order[6],
        takeProfit: order[7],
        stopMarket: order[8]
      }
    }
  })
  return found
}

async function init() {
  // await sheets.init()
}

module.exports = {
  init: init,
  writeInterval: writeInterval,
  writeExit: writeExit,
  writeEntryOrder: writeEntryOrder,
  readEntryOrder: readEntryOrder,
  readEntryOrders: readEntryOrders,
  findEntryOrder: findEntryOrder
}