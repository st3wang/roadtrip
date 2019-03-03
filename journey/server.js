const http 	= require('http')
const url = require('url')
const fs = require('fs')
const port = '3000'

function responseWithFile(response,contentType,fileName) {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'X-Powered-By':'nodejs'
  })
  fs.readFile(fileName, function(err, content) {
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

async function init(getMarketCsv,getTradeCsv) {
  http.createServer(async (request, response) => {
    let path = url.parse(request.url).pathname
    switch(path) {
      case '/':
        responseWithFile(response,'text/html','www/index.html')
        break;
      case '/market.csv':
        var marketCsv = await getMarketCsv()
        responseWithData(response,'text/csv',marketCsv)
        break;
      case '/trade.csv':
        var tradeCsv = await getTradeCsv()
        responseWithData(response,'text/csv',tradeCsv)
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
  }).listen(port)
  
  console.log("Listening on port " + port)
}

module.exports = {
  init: init
}