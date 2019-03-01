const sheets = require('./sheets')
const fs = require('fs')
const writeFileOptions = {encoding:'utf-8', flag:'w'}

if (!fs.existsSync('log')) {
  fs.mkdirSync('log')
}
if (!fs.existsSync('log/condition.csv')) {
  fs.writeFileSync('log/condition.csv','time,prsi,rsi,close,signalCondition,orderType,position,balance\n',writeFileOptions)
}
if (!fs.existsSync('log/enter.csv')) {
  fs.writeFileSync('log/enter.csv','Time,Capital,Risk,R/R,Type,Entry,Stop,Target,Time,Exit,P/L,StopPercent,Stop,Target,BTC,USD,BTC,USD,Leverage,BTC,Price,USD,Percent\n',writeFileOptions)
}

function writeInterval(rsiSignal,market,bankroll,position,margin,order,orderSent) {
  var isoString = new Date().toISOString()
  var signalCSV = isoString + ',' + rsiSignal.prsi.toFixed(2) + ',' + rsiSignal.rsi.toFixed(2) + ',' + market.closes[market.closes.length-1].toFixed(1) + ',' +
    rsiSignal.condition + ',' + order.type + ',' + position.currentQty + ',' + (margin.marginBalance/100000000).toFixed(4) + '\n'
  console.log(signalCSV.replace('\n',''))
  fs.appendFile('log/condition.csv', signalCSV, e => {
    if (e) {
      console.log(e)
    }
  })
  var prefix = 'log/'+isoString.replace(/\:/g,',')
  var content = JSON.stringify({rsiSignal:rsiSignal,market:market,bankroll:bankroll,position:position,margin:margin,order:order})
  fs.writeFile(prefix+'.json',content,writeFileOptions, e => {
    if (e) {
      console.log(e)
    }
  })
  if (orderSent) {
      // Time,Capital,Risk,R/R,
      // Entry,Stop,Target,Exit,P/L,Stop,Target,BTC,USD,BTC,USD,Leverage,BTC,Price,USD,Percent
    var enterData = [isoString,bankroll.capitalUSD,bankroll.riskPerTradePercent,bankroll.profitFactor,
      order.type,order.entryPrice,order.stopLoss,order.takeProfit,'','','',order.lossDistancePercent,order.lossDistance,order.profitDistance,
      order.riskAmountBTC,order.riskAmountUSD,order.positionSizeBTC,order.positionSizeUSD,order.leverage,'','','','']
    var enterCSV = enterData.toString()
    console.log(enterCSV)
    fs.appendFile('log/enter.csv', enterCSV+'\n', e => {
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

async function init() {
  await sheets.init()
}

module.exports = {
  init: init,
  writeInterval: writeInterval,
  writeExit: writeExit
}