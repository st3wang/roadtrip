const util = require('util')
const fs = require('fs')
const http 	= require('http')
const gunzip = require('gunzip-file')

const ymdHelper = require('./ymdHelper')
const shoes = require('./shoes')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const csvParse = require('csv-parse')
const csvStringify = require('csv-stringify')

const filePath = 'data/bitmex/trade/YYYYMMDD.csv'

const symbols = ['XBTUSD','ETHUSD']
// const historyStartYmd = 20170101

function getCleanedTradeFile(ymd,symbol) {
  return filePath.replace('YYYYMMDD',ymd+'_'+symbol)
}

function writeCleanedFile(ymd,symbol,output) {
  var writePath = getCleanedTradeFile(ymd,symbol)
  csvStringify(output, async (err, outputString) => {
    await writeFile(writePath,outputString,writeFileOptions)
    console.log('done writing', ymd, symbol)
  })
}

function downloadTradeDay(ymd) { try {
  return new Promise((resolve, reject) => {
    const request = http.get(shoes.bitmexdata.url + ymd + '.csv.gz', function(response) {
      const csvFilename = filePath.replace('YYYYMMDD',ymd) //'data/trade/' + ymd + '.csv'
      const gzFilename = csvFilename + '.gz'
      const ws = fs.createWriteStream(gzFilename);
      response.pipe(ws)
      ws.on('finish', _ => {
        gunzip(gzFilename, csvFilename, _ => {
          console.log(ymd + ' gunzipped')
          fs.unlink(gzFilename,_=>{});
          resolve(csvFilename)
        })
      })
    })
  })
} catch(e) {console.error(e.stack||e);debugger} }

function readAndParseCleanUp(ymd) {
  return new Promise((resolve, reject) => {
    const readPath = filePath.replace('YYYYMMDD',ymd)
    var trades ={}
    var symbolsString = ''
    symbols.forEach(symbol => {
      trades[symbol] = []
      symbolsString = symbolsString + symbol
    })
    fs.createReadStream(readPath).pipe(csvParse())
      .on('data', ([timestamp,symbol,side,size,price]) => {
        if (symbolsString.indexOf(symbol) >= 0) {
          // var timeString = record[0].slice(0,23).replace('D',' ').replace('.',':')
          // var timeLocal = new Date(timeString)
          // var timeGMT = new Date(timeLocal.valueOf() - timeLocal.getTimezoneOffset() * 60000)
          trades[symbol].push([timestamp,side[0],size,price])
        }
      })
      .on('error', e => reject(e))
      .on('end', () => resolve(trades));
  });
}

async function downloadTradeData(startYmd,endYmd) { try {
  var ymd = startYmd
  while (ymd <= endYmd) {
    const cleanedTradeFile = getCleanedTradeFile(ymd)
    if (fs.existsSync(cleanedTradeFile)) {
      console.log('skip',cleanedTradeFile)
    }
    else {
      const csvFilename = await downloadTradeDay(ymd)
      const trades = await readAndParseCleanUp(ymd)
      fs.unlink(csvFilename,_=>{})
      symbols.forEach(symbol => {
        writeCleanedFile(ymd,symbol,trades[symbol])
      })
    }
    ymd = ymdHelper.nextDay(ymd)
  }
} catch(e) {console.error(e.stack||e);debugger} }

module.exports = {
  downloadTradeData: downloadTradeData
}