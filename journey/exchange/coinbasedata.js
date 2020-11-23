const util = require('util')
const fs = require('fs')
const https 	= require('https')
const path = require('path')

const ymdHelper = require('../ymdHelper')
const shoes = require('../shoes')
const base = require('./basedata')

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}

const exchange = 'coinbase'
const symbols = ['BTC-USD']

const orderFilePath = path.resolve(__dirname, '../data/exchange/order/orderid.json')

function getOrderFile(o) {
  return orderFilePath.replace('exchange',exchange).replace('orderid',o.id)
}

async function readOrder(orderId) {
  const readPath = getOrderFile({id:orderId})
  if (fs.existsSync(readPath)) {
    var str = fs.readFileSync(readPath,readFileOptions)
    var order = JSON.parse(str)
    return order
  }
}

async function writeOrder(o) {
  const writePath = getOrderFile(o)
  await writeFile(writePath,JSON.stringify(o),writeFileOptions)
}

async function readFeedDay(symbol,interval,time) {
  return await base.readFeedDay(exchange,symbol,interval,time)
}

async function readMarket(symbol,interval,st,et) { try {
  return await base.readMarket(exchange,symbol,interval,st,et)
} catch(e) {logger.error(e.stack||e);debugger} }

async function getMarket(symbol,interval,start,end) {
  return new Promise((resolve,reject) => {
    const options = {
      hostname: 'api.pro.coinbase.com',
      path: '/products/' + symbol + 
        '/candles?granularity=' + (interval*60) + 
        '&start=' + start +
        '&end=' + end,
      headers: {
        'User-Agent': 'Mozilla/5.0',
      }
    }

    https.get(options, function(response) {
        let data = ''
        response.on('data', (chunk) => {data += chunk})
        response.on('end', () => {
          let candles = {
            opens: [], highs: [], lows: [], closes: [], candles: []
          }
          let value = JSON.parse(data)
          if (value.reverse) {
            value.reverse()
            value.forEach(v => {
              candles.opens.push(v[3])
              candles.highs.push(v[2])
              candles.lows.push(v[1])
              candles.closes.push(v[4])
              candles.candles.push({
                time: new Date(v[0]*1000).toISOString(),
                volume: v[5],
                open: v[3], high: v[2], low: v[1], close: v[4]
              })
            })
          }
          else {
            console.log('coinbasedata getMarket value', value)
          }
          resolve(candles)
        })
      }
    )
  })
}

async function getCandleDay(symbol,interval,ymd) { try {
  console.log('getCandleDay',symbol,interval,ymd)
  const yyyy_mm_dd = ymdHelper.YYYY_MM_DD(ymd)
  return await getMarket(symbol,interval,yyyy_mm_dd+'T00:00:00.000Z',yyyy_mm_dd+'T23:00:00Z')
} catch(e) {console.error(e.stack||e);debugger} }

async function generateCandleDayFiles(startYmd,endYmd,interval) { try {
  var len = symbols.length
  for (var i = 0; i < len; i++) {
    let symbol = symbols[i],
        ymd = startYmd,
        lastPrice
    while (ymd <= endYmd) {
      let writeCandlePath = base.getCandleFile(exchange,symbol,interval,ymd)
      let candles, feeds
      if (fs.existsSync(writeCandlePath)) {
        console.log('skip candle',writeCandlePath)
      }
      else {
        candles = await getCandleDay(symbol,interval,ymd)
        let candlesString = JSON.stringify(candles)
        await writeFile(writeCandlePath,candlesString,writeFileOptions)
        console.log('done writing candle', writeCandlePath)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      let writeFeedPath = base.getFeedFile(exchange,symbol,interval,ymd)
      if (fs.existsSync(writeFeedPath)) {
        console.log('skip feed',writeFeedPath)
      }
      else {
        candles = candles || JSON.parse(fs.readFileSync(writeCandlePath,readFileOptions))
        feeds = base.getFeedDay(candles,interval,lastPrice)
        let feedsString = JSON.stringify(feeds)
        await writeFile(writeFeedPath,feedsString,writeFileOptions)
        console.log('done writing feed', writeFeedPath)
        lastPrice = feeds[feeds.length-1][3]
      }
      ymd = ymdHelper.nextDay(ymd)
    }
  }
} catch(e) {console.error(e.stack||e);debugger} }



module.exports = {
  generateCandleDayFiles: generateCandleDayFiles,
  readFeedDay: readFeedDay,
  readMarket: readMarket,
  getMarket: getMarket,
  readOrder: readOrder,
  writeOrder: writeOrder
}