const fs = require('fs');
const util = require('util')
const https = require('follow-redirects').https

const readFile = util.promisify(fs.readFile)
const readFileOptions = {encoding:'utf-8', flag:'r'}
const writeFile = util.promisify(fs.writeFile)
const writeFileOptions = {encoding:'utf-8', flag:'w'}
const path = require('path')

async function request(method,path,body) { try {
  return new Promise((resolve,reject) => {
    body = body ? JSON.stringify(body) : body

    const options = {
      method: method,
      hostname: 'script.google.com',
      path: path,
      agent: false,
      headers: {
        'User-Agent': 'Mozilla/5.0',
      }
    }
    if (body) {
      options.headers['Content-Type'] = 'application/json'
      options.headers['Content-Length'] = body.length
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => {data += chunk})
      res.on('end', async() => {
        let value = JSON.parse(data)
        var start = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
        require('child_process').exec(start + ' ' + value.url);
        resolve(value)
      })
    })
    req.on('error', (e) => {
      console.error(e.message)
    })
    if (body) req.write(body)
    req.end()
  })
} catch(e) {logger.error(e.stack||e);debugger} }

async function upload(name,csvString) {
  return await request('POST','/macros/s/AKfycbySGpQMHL19UEuobaJKaADwMJjxfloqpzgoOmLi3mnLR45l3BN8/exec',{
    name: name,
    csvString: csvString
  })
}

module.exports = {
  upload: upload
}