const fs = require('fs')
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const path = require('path')

const logDir = path.resolve(__dirname, 'log')
const conditionFile = logDir + '/condition.csv'
const signalsfile = logDir + '/signals.csv'
const entrySignalFile = logDir + '/entry_signal.json'

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir)
}
if (!fs.existsSync(conditionFile)) {
  fs.writeFileSync(conditionFile,'time,prsi,rsi,close,signalCondition,orderType,position,balance\n',writeFileOptions)
}
if (!fs.existsSync(signalsfile)) {
  fs.writeFileSync(signalsfile,'Time,Capital,Risk,R/R,Type,Entry,Stop,Target,StopMarket,StopPercent,StopDistance,TargetDistance,RiskBTC,RiskUSD,SizeBTC,SizeUSD,Leverage\n',writeFileOptions)
}

function csvToArray(csv) {
  return csv.split('\n').map(row => {
    return row.split(',')
  })
}

function writeOrderSignal(bankroll,signal) {
  // Time,Capital,Risk,R/R,
  // Type,Entry,Stop,Target,StopMarket,StopPercent,StopDistance,TargetDistance,
  // RiskBTC,RiskUSD,SizeBTC,SizeUSD,Leverage
  entrySignalsCache = null
  var entryData = [signal.timestamp,bankroll.capitalUSD,bankroll.riskPerTradePercent,bankroll.profitFactor,
    signal.type,signal.entryPrice,signal.stopLoss,signal.takeProfit,signal.stopMarket,signal.lossDistancePercent,signal.lossDistance,signal.profitDistance,
    signal.riskAmountBTC,signal.riskAmountUSD,signal.positionSizeBTC,signal.positionSizeUSD,signal.leverage]
  var entryCSV = entryData.toString()
  console.log(entryCSV)
  fs.appendFile(signalsfile, entryCSV+'\n', e => {
    if (e) {
      console.log(e)
    }
  })
}

function writeInterval(rsiSignal,market,bankroll,position,margin,signal,orderSent) {
  var isoString = signal.timestamp
  var signalCSV = isoString + ',' + rsiSignal.prsi.toFixed(2) + ',' + rsiSignal.rsi.toFixed(2) + ',' + market.closes[market.closes.length-1].toFixed(1) + ',' +
    rsiSignal.condition + ',' + signal.type + ',' + position.currentQty + ',' + (margin.marginBalance/100000000).toFixed(4) + '\n'
  console.log(signalCSV.replace('\n',''))
  fs.appendFile(conditionFile, signalCSV, e => {
    if (e) {
      console.log(e)
    }
  })
  var dataFile = logDir+'/'+isoString.replace(/\:/g,',')+'.json'
  var content = JSON.stringify({rsiSignal:rsiSignal,market:market,bankroll:bankroll,position:position,margin:margin,signal:signal})
  fs.writeFile(dataFile,content,writeFileOptions, e => {
    if (e) {
      console.log(e)
    }
  })
  if (orderSent) {
    // Time,Capital,Risk,R/R,
    // Type,Entry,Stop,Target,StopMarket,StopPercent,StopDistance,TargetDistance,
    // RiskBTC,RiskUSD,SizeBTC,SizeUSD,Leverage
    entrySignalsCache = null
    var entryData = [isoString,bankroll.capitalUSD,bankroll.riskPerTradePercent,bankroll.profitFactor,
      signal.type,signal.entryPrice,signal.stopLoss,signal.takeProfit,signal.stopMarket,signal.lossDistancePercent,signal.lossDistance,signal.profitDistance,
      signal.riskAmountBTC,signal.riskAmountUSD,signal.positionSizeBTC,signal.positionSizeUSD,signal.leverage]
    var entryCSV = entryData.toString()
    console.log(entryCSV)
    fs.appendFile(signalsfile, entryCSV+'\n', e => {
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

function writeEntrySignal(signal) {
  fs.writeFileSync(entrySignalFile,JSON.stringify(signal),writeFileOptions)
}

function readEntrySignal() {
  if (!fs.existsSync(entrySignalFile)) {
    return
  }
  var str = fs.readFileSync(entrySignalFile,readFileOptions)
  return JSON.parse(str)
}

var entrySignalsCache

function readEntrySignals() {
  if (!entrySignalsCache) {
    if (!fs.existsSync(signalsfile)) {
      return
    }
    var csv = fs.readFileSync(signalsfile,readFileOptions)
    entrySignalsCache = csvToArray(csv)
  }
  
  return entrySignalsCache
}

function findEntrySignal(timestamp,price,sizeUSD) {
  var time = new Date(timestamp).getTime()
  var signals = readEntrySignals()
  var found
  signals.forEach(signal => {
    let signalTime = new Date(signal[0]).getTime()
    let signalPrice = parseFloat(signal[5])
    if (time >= signalTime && time <= (signalTime+2*60*60000) && signalPrice <= price+2 && signalPrice >= price-2 && signal[15] == ''+sizeUSD) {
      found = {
        timestamp: signal[0],
        price: price,
        size: sizeUSD,
        stopLoss: signal[6],
        takeProfit: signal[7],
        stopMarket: signal[8]
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
  writeEntrySignal: writeEntrySignal,
  readEntrySignal: readEntrySignal,
  readEntrySignals: readEntrySignals,
  findEntrySignal: findEntrySignal,
  writeOrderSignal: writeOrderSignal
}