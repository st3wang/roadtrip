const fs = require('fs')
const fsR = require('fs-reverse')
const { Writable } = require('stream');
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const util = require('util')
const writeFile = util.promisify(fs.writeFile)

const winston = require('winston')
const path = require('path')

const shoes = require('./shoes')
global.logDir = path.resolve(__dirname, 'log/'+shoes.symbol)

const entrySignalTableFilePath = global.logDir + '/entry_signal_table.log'
const {isoTimestamp} = global

const entrySignalTable = winston.createLogger({
  transports: [
    new winston.transports.File({filename:entrySignalTableFilePath,
      format: winston.format.combine(
        isoTimestamp(),
        winston.format.json()
      ),
    })
  ]
})

var entrySignals = []

function writeEntrySignalTable(entrySignal) { try {
  if (!entrySignal.entryOrders[0]) debugger
  entrySignals.push(entrySignal)
  entrySignalTable.info('entry',entrySignal)
} catch(e) {global.logger.error(e.stack||e);debugger} }

async function readEntrySignalTable({startTime,endTime}) { try {
  return new Promise((resolve,reject) => {
    var startTimeMs = new Date(startTime).getTime()
    var endTimeMs = new Date(endTime).getTime()
    var signals = []
    var stream = fsR(entrySignalTableFilePath, {})
    const outStream = new Writable({
      write(chunk, encoding, callback) {
        let str = chunk.toString()
        if (str && str.length > 0) {
          let signal = JSON.parse(str)
          let signalTime = new Date(signal.timestamp).getTime()
          if (signalTime >= startTimeMs && signalTime <= endTimeMs) {
            // var {entryOrders,closeOrders,takeProfitOrders} = global.strategy.getEntryExitOrders(signal)
            // signal.entryOrders = entryOrders
            // signal.closeOrders = closeOrders
            // signal.takeProfitOrders = takeProfitOrders
            signals.unshift(signal)
          }
          else {
            stream.destroy()
            resolve(signals)
          }
        }
        callback()
      }
    })
    stream.pipe(outStream)
    stream.on('finish', () => {
      resolve(signals)
    })
    stream.on('end', () => {
      resolve(signals)
    })
  })
} catch(e) {global.logger.error(e.stack||e);debugger} }

function cancelEntrySignal(order) { try {
  for (let i = entrySignals.length-1; i >= 0; i--) {
    let {entryOrders:[{price,orderQty}]} = entrySignals[i]
    if (order.price == price && order.orderQty == orderQty) {
      entrySignals[i].status = 'cancelled'
      i = -1
    }
  }
} catch(e) {global.logger.error(e.stack||e);debugger} }

async function writeTradesCSV(writePath,trades) { try {
  var outputString =
    'number,timestamp,cumQty,status,entry,exit,stop,cost%,fee%,pnl%,wl,cwl,group,grouppnl,balance,balance%,bstart,busd,dd%,ddusd%,winsPercent,hoursInTrade,avgInTrade,avgGroupInTrade'
    // 'number,timestamp,cumQty,status,entry,exit,stop,cost,cost%,fee,fee%,pnl,pnl%,balance,balance%,bstart,busd,dd,dd%,ddusd,ddusd%,wl,cwl,wins,losses,winsPercent'
  trades.forEach((t,i) => {
    let entryOrder = t.entryOrders[0] || {}
    let closeOrder = t.closeOrders[0] || {}
    outputString += '\n' +
      ((i+1) + ',' + entryOrder.timestamp).replace('T',' ').replace('.000Z',',') +
      entryOrder.cumQty + ',' +  
      entryOrder.ordStatus + ',' +
      entryOrder.price + ',' +
      closeOrder.price + ',' +
      closeOrder.stopPx + ',' +
      // t.cost + ',' +
      t.costPercent + ',' +
      // t.fee + ',' +
      t.feePercent + ',' +
      // t.pnl + ',' +
      t.pnlPercent + ',' +
      t.wl + ',' +
      t.cwl + ',' +
      t.group + ',' +
      t.grouppnl + ',' +
      // t.wins + ',' +
      // t.losses + ',' +
      t.walletBalance + ',' +
      t.walletBalancePercent + ',' +
      t.walletBalanceStart + ',' +
      t.walletBalanceUSD + ',' +
      // t.drawdown + ',' +
      t.drawdownPercent + ',' +
      // t.drawdownUSD + ',' +
      t.drawdownUSDPercent + ',' +
      t.winsPercent + ',' +
      t.hoursInTrade + ',' +
      t.avgHoursInTrade + ',' +
      t.avgGroupHoursInTrade + ','
  })
  console.log(outputString)
  await writeFile(writePath,outputString,writeFileOptions)
} catch(e) {global.logger.error(e.stack||e);debugger} }

async function init() {
}

module.exports = {
  init: init,
  writeEntrySignalTable: writeEntrySignalTable,
  readEntrySignalTable: readEntrySignalTable,
  cancelEntrySignal: cancelEntrySignal,
  writeTradesCSV: writeTradesCSV
}
