const http 	= require('http')
const url = require('url')
const fs = require('fs')
const shoes = require('./shoes')
const path = require('path')

var getMarketJson, getTradeJson, getFundingCsv

function responseWithFile(response,contentType,fileName) {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'X-Powered-By':'nodejs'
  })
  fs.readFile(path.resolve(__dirname, fileName), function(err, content) {
      response.write(content)
      response.end()
  })
}

function responseWithData(response,contentType,data) {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'X-Powered-By':'nodejs'
  })
  response.write(data)
  response.end()
}

async function responseToGet(request, response) {
  let path = url.parse(request.url).pathname
  switch(path) {
    case '/':
      responseWithFile(response,'text/html','www/index.html')
      break;
    case '/market.json':
      var marketJson = await getMarketJson()
      responseWithData(response,'text/json',marketJson)
      break;
    case '/trade.json':
      var tradeJson = await getTradeJson()
      responseWithData(response,'text/json',tradeJson)
      break;
    case '/market.csv':
      var marketCsv = await getMarketCsv()
      responseWithData(response,'text/csv',marketCsv)
      break;
    case '/trade.csv':
      var tradeCsv = await getTradeCsv()
      responseWithData(response,'text/csv',tradeCsv)
      break;
    case '/funding.csv':
      var fundingCsv = await getFundingCsv()
      responseWithData(response,'text/csv',fundingCsv)
      break;
    case '/data.csv':
      responseWithFile(response,'text/html','www/data.csv')
      // responseWithData(response,'text/html','Date,Open,High,Low,Close,Volume\n'+
      //   '9-Jun-14,62.40,63.34,61.79,62.88,37617413\n'+
      //   '6-Jun-14,63.37,63.48,62.15,62.50,42442096\n'+
      //   '5-Jun-14,63.66,64.36,62.82,63.19,47352368\n'+
      //   '4-Jun-14,62.45,63.59,62.07,63.34,36513991\n')
      break;
    default:
      responseWithFile(response,'application/js','www'+path)
  }
}

async function readBody(request) {
  return new Promise((resolve,reject) => {
    var body = '';
    request.on('data', function (data) {
      body += data;
      // 1e6 === 1 * Math.pow(10, 6) === 1 * 1000000 ~~~ 1MB
      if (body.length > 1e6) { 
        // FLOOD ATTACK OR FAULTY CLIENT, NUKE REQUEST
        request.connection.destroy();
        resolve('400')
      }
    })
    request.on('end', function () {
      resolve(JSON.parse(body))
    })
  })
}

async function resposeToPost(request, response) {
  let path = url.parse(request.url).pathname
  switch(path) {
    case '/GetMarket':
      var setup = await readBody(request)
      var marketJson = await getMarketJson(setup)
      responseWithData(response,'text/json',marketJson)
      break;
    case '/GetTrade':
      var setup = await readBody(request)
      var tradeJson = await getTradeJson(setup)
      responseWithData(response,'text/json',tradeJson)
      break;
  }
}

const responseTo = {
  GET: responseToGet,
  POST: resposeToPost
}

async function init(getMarketJsonFn,getTradeJsonFn,getFundingCsvFn) {
  getMarketJson = getMarketJsonFn
  getTradeJson = getTradeJsonFn
  getFundingCsv = getFundingCsvFn
  http.createServer(async (request, response) => {
    await responseTo[request.method](request, response)
  }).listen(shoes.server.port)
  console.log("Listening on port " + shoes.server.port)
}

module.exports = {
  init: init
}
