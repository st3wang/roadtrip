const sheets = require('./sheets')
const fs = require('fs')
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const path = require('path')

const logDir = path.resolve(__dirname, 'log')
const conditionFile = logDir + '/condition.csv'
const enterFile = logDir + '/enter.csv'
const enterOrderFile = logDir + '/enter_order.json'

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir)
}
if (!fs.existsSync(conditionFile)) {
  fs.writeFileSync(conditionFile,'time,prsi,rsi,close,signalCondition,orderType,position,balance\n',writeFileOptions)
}
if (!fs.existsSync(enterFile)) {
  fs.writeFileSync(enterFile,'Time,Capital,Risk,R/R,Type,Entry,Stop,Target,StopMarket,Time,Exit,P/L,StopPercent,Stop,Target,BTC,USD,BTC,USD,Leverage,BTC,Price,USD,Percent\n',writeFileOptions)
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
    // Entry,Stop,Target,Exit,P/L,Stop,Target,BTC,USD,BTC,USD,Leverage,BTC,Price,USD,Percent
    var enterData = [isoString,bankroll.capitalUSD,bankroll.riskPerTradePercent,bankroll.profitFactor,
      order.type,order.entryPrice,order.stopLoss,order.takeProfit,order.stopMarketTrigger,'','','',order.lossDistancePercent,order.lossDistance,order.profitDistance,
      order.riskAmountBTC,order.riskAmountUSD,order.positionSizeBTC,order.positionSizeUSD,order.leverage,'','','','']
    var enterCSV = enterData.toString()
    console.log(enterCSV)
    fs.appendFile(logDir+'/enter.csv', enterCSV+'\n', e => {
      if (e) {
        console.log(e)
      }
    })
    sheets.enterTrade(enterData).catch(e => {
      console.log(e)
    })
  }
}
function writeExit(exitData) {
  sheets.exitTrade(exitData).catch(e => {
    console.log(e)
  })
}

function writeEnterOrder(order) {
  fs.writeFileSync(enterOrderFile,JSON.stringify(order),writeFileOptions)
}

function readEnterOrder() {
  if (!fs.existsSync(enterOrderFile)) {
    return
  }
  var str = fs.readFileSync(enterOrderFile,readFileOptions)
  return JSON.parse(str)
}

async function init() {
  await sheets.init()
}

module.exports = {
  init: init,
  writeInterval: writeInterval,
  writeExit: writeExit,
  writeEnterOrder: writeEnterOrder,
  readEnterOrder: readEnterOrder
}