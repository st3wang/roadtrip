const http 	= require('http')
const url = require('url')
const fs = require('fs')
const path = require('path')

const port = '3030'

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

async function init(getMarketJson,getOverviewJson) {
  http.createServer(async (request, response) => {
    let path = url.parse(request.url).pathname
    switch(path) {
      case '/':
        responseWithFile(response,'text/html','www/index.html')
        break;
      case '/market.json':
        var setup = JSON.parse(request.headers.setup)
        var marketJson = await getMarketJson(setup)
        responseWithData(response,'application/json',marketJson)
        break;
      case '/overview.json':
        var setup = JSON.parse(request.headers.setup)
        var overviewJson = await getOverviewJson(setup)
        responseWithData(response,'application/json',overviewJson)
        break;
      default:
        if (path.substring(path.length - 5) == '.html') {
          responseWithFile(response,'text/html','www'+path)
        }
        else if (path.substring(path.length - 3) == '.js') {
          responseWithFile(response,'application/js','www'+path)
        }
    }
  }).listen(port)
  
  console.log("Listening on port " + port)
}

module.exports = {
  init: init
}
