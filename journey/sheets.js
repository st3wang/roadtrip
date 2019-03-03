const util = require('util')
const fs = require('fs')
const readline = require('readline')
const {google} = require('googleapis')
const shoes = require('./shoes')

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
const TOKEN_PATH = 'sheets_token.json'
var auth, sheets

function authorizeWithCallback(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error while trying to retrieve access token', err);
      oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('Token stored to', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}

async function authorize() {
  return new Promise((resolve,reject) => {
    authorizeWithCallback(shoes.sheets.credential, a => {
      auth = a
      sheets = google.sheets({version: 'v4', auth}).spreadsheets.values;
      resolve()
    })
  })
}

async function enterTrade(row) {
  return new Promise((resolve,reject) => {
    sheets.append({
      spreadsheetId: shoes.sheets.sheetsId,
      range: 'A1',
      valueInputOption: 'RAW',
      resource: {values:[row]}
    }, (err, res) => {
      if (err) reject(err)
      resolve(res)
    })
  })
}

async function exitTrade(row) {
  return new Promise(async (resolve,reject) => {
    var lastRowId = await getLastRowId()
    sheets.update({
      spreadsheetId: shoes.sheets.sheetsId,
      range: 'J'+lastRowId,
      valueInputOption: 'RAW',
      resource: {values:[row]}
    }, (err, res) => {
      if (err) reject(err)
      resolve(res)
    })
  })
}

async function getLastRowId() {
  return new Promise((resolve,reject) => {
    sheets.get({
      spreadsheetId: shoes.sheets.sheetsId,
      range: 'A1:A'
    }, (err, res) => {
      if (err) reject(err)
      resolve(res.data.values.length)
    })
  })
}

async function getTrades() {
  return new Promise((resolve,reject) => {
    sheets.get({
      spreadsheetId: shoes.sheets.sheetsId,
      range: 'A1:X'
    }, (err, res) => {
      if (err) reject(err)
      var startTime = new Date().getTime() - 24*60*60000
      var trades = res.data.values.filter(v => {
        return new Date(v[0]).getTime() > startTime
      })
      resolve(trades)
    })
  })
}

async function init() {
  await authorize().catch(e => {
    console.error(e)
    debugger
  })
}

module.exports = {
  init: init,
  enterTrade: enterTrade,
  exitTrade: exitTrade,
  getTrades: getTrades
}
