const mysql = require('promise-mysql')
const roadmap = require('./roadmap');

var con

async function connect() {
  con = await mysql.createConnection(roadmap.dbOptions).catch(e => {
    console.error(e)
    debugger
  })
  console.log('db connected')
}

exports.connect = connect

async function dropTables(minRsiLength,maxRsiLength) {
  for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
    let sql = `DROP TABLE TradeRsi` + rsiLength
    let results = await con.query(sql).catch(e => console.error(e))
    console.log('done', sql)
  }
}

async function createTables(minRsiLength,maxRsiLength) {
  for (var rsiLength = minRsiLength; rsiLength <= maxRsiLength; rsiLength++) {
    let sql = `CREATE TABLE IF NOT EXISTS TradeRsi` + rsiLength + 
    `(
      SetupRsiOverbought tinyint,
      SetupRsiOversold tinyint,
      SetupStopLossLookBack tinyint,
      SetupProfitFactor smallint,
      EnterType varchar(1)not null,
      EnterCapital smallint,
      EnterTime int,
      EnterSize smallint,
      EnterPrice decimal(9,2),
      StopLoss decimal(9,2),
      TakeProfit decimal(9,2),
      ExitTime int,
      ExitPrice decimal(9,2),
      ExitCapital smallint
    )`
    
    let results = await con.query(sql).catch(e => console.error(e))
    console.log('done',sql)
  }
}

function startTradeSetup(setup) {
  return {sql:`INSERT INTO TradeRsi` + setup.rsiLength + `(SetupRsiOverbought,SetupRsiOversold,SetupStopLossLookBack,SetupProfitFactor,
    EnterType,EnterCapital,EnterTime,EnterSize,EnterPrice,StopLoss,TakeProfit,
    ExitTime,ExitPrice,ExitCapital) VALUE`,
    params:[],enterCount:0,exitCount:0}
}

var pendingEndTradeSetup

async function endTradeSetup(query) {
  var sql = query.sql, params = query.params
  sql = sql.slice(0, -1)
  if (params.length % 16 !== 0) {
    params = params.concat([null,null,null,null])
  }

  try {
    if (pendingEndTradeSetup) {
      await pendingEndTradeSetup
    }
    else {
      console.log('no pending')
    }
    pendingEndTradeSetup = con.query(sql,params)
    .catch (e => {
      console.log(sql,params)
      console.error(e)
      debugger
    })
    pendingEndTradeSetup.then(result => {
      pendingEndTradeSetup = null
    })
  }
  catch (e) {
    console.log(e)
    debugger
  }
  return
}

function enterTrade(query,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,type,capital,time,size,price,stopLoss,takeProfit) {
  // query.enterCount++
  query.sql += ` (?,?,?,?,?,?,?,?,?,?,?,?,?,?),`
  query.params.push(rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,
    type,capital,time/1000,size,price,stopLoss,takeProfit)
  return
}

function exitTrade(query,time,price,capital) {
  // query.exitCount++
  query.params.push(time/1000,price,capital)
  return
}

async function getTrades(rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor) {
  var sql = `select id,type,enter_capital,enter_time,enter_size,enter_price,stop_loss,take_profit,exit_time,exit_price,exit_profit,exit_capital
    from trade where setup_rsilength = ? and setup_rsioverbought = ? and setup_rsioversold = ? and setup_stoplosslookback = ? and setup_profitfactor = ?`
  var result = await con.query(sql,[rsiLength, rsiOverbought, rsiOversold, stopLossLookBack, profitFactor])
  return result
}

exports.dropTables = dropTables
exports.createTables = createTables
exports.startTradeSetup = startTradeSetup
exports.endTradeSetup = endTradeSetup
exports.enterTrade = enterTrade
exports.exitTrade = exitTrade
exports.getTrades = getTrades

// function createDatabase() {
//   var con = mysql.createConnection({
//     host: "localhost",
//     user: "root",
//     password: "password"
//   });
  
//   con.connect(function(err) {
//     if (err) throw err;
//     console.log("Connected!");
//     con.query("CREATE DATABASE survey", function (err, result) {
//       if (err) throw err;
//       console.log("Database created");
//     });
//   });
// }

// exports.createDatabase = createDatabase