const mysql = require('promise-mysql')

const options = {
  host: '192.168.1.34',
  port: '3306',
  user: 'mac',
  password: 'password',
  database: 'survey'
}

var con

async function connect() {
  con = await mysql.createConnection(options).catch(e => {
    console.error(e)
    debugger
  })
  console.log('db connected')
  // await dropTables()
  // await createTables()
  // debugger
}

exports.connect = connect

async function dropTables() {
  let deleteTradeTable = `drop table trade`
  let results = await con.query(deleteTradeTable).catch(e => console.error(e))
  console.log('trade table dropped')
}

async function createTables() {
  let createTradeTable = `create table if not exists trade(
    id int primary key auto_increment,
    setup_rsilength tinyint,
    setup_rsioverbought tinyint,
    setup_rsioversold tinyint,
    setup_stoplosslookback tinyint,
    setup_profitfactor smallint,
    type varchar(8)not null,
    enter_capital decimal(6,2),
    enter_time int,
    enter_size decimal(4,2),
    enter_price decimal(8,2),
    stop_loss decimal(8,2),
    take_profit decimal(8,2),
    exit_time int,
    exit_price decimal(8,2),
    exit_profit decimal(6,2),
    exit_capital decimal(6,2)
  )`;
  
  let results = await con.query(createTradeTable).catch(e => console.error(e))
  console.log('trade table created')
}

// var tTrades, tInsertSql
// var tSetup_rsiLength, tSetup_rsiOverbought, tSetup_rsiOversold, tSetup_stopLossLookBack, tSetup_profitFactor

function startTradeSetup() {
  // enterCount = exitCount = 0
  // tSetup = [setup.rsiLength,setup.rsiOverbought,setup.rsiOversold,setup.stopLossLookBack,setup.profitFactor]
  // tSetup_rsiLength = setup.rsiLength
  // tSetup_rsiOverbought = setup.rsiOverbought
  // tSetup_rsiOversold = setup.rsiOversold
  // tSetup_stopLossLookBack = setup.stopLossLookBack
  // tSetup_profitFactor = setup.profitFactor
  return {sql:`insert into trade (setup_rsilength,setup_rsioverbought,setup_rsioversold,setup_stoplosslookback,setup_profitfactor,
    type,enter_capital,enter_time,enter_size,enter_price,stop_loss,take_profit,
    exit_time,exit_price,exit_profit,exit_capital) value`,
    params:[],enterCount:0,exitCount:0}
}

var pendingEndTradeSetup

async function endTradeSetup(query) {
  // var sql = `insert into trade (setup_rsilength,setup_rsioverbought,setup_rsioversold,setup_stoplosslookback,setup_profitfactor,
  //   type,enter_capital,enter_time,enter_size,enter_price,stop_loss,take_profit,
  //   exit_time,exit_price,exit_profit,exit_capital) value (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  // var params = [1,2,3,4,5,'A',7,8,9,0,1,2,3,4,5,6,1,2,3,4,5,'A',7,8,9,0,1,2,3,4,5,6]
  // let result = await con.query(sql,params)
  // return
  var sql = query.sql, params = query.params
  sql = sql.slice(0, -1)
  if (params.length % 16 !== 0) {
    params = params.concat([null,null,null,null])
  }

  try {
    // console.log(query.enterCount,query.exitCount,sql.length, params.length, params.length/16)
    if (pendingEndTradeSetup) {
      // console.log('wait pending')
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

function enterTrade(query,rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,type,capital,time,size,price,stopLoss,takeProfit) {
  // query.enterCount++
  query.sql += ` (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?),`
  // tTrades = tTrades.concat(tSetup.concat([type,capital,time/1000,size,price,stopLoss,takeProfit]))
  query.params.push(rsiLength,rsiOverbought,rsiOversold,stopLossLookBack,profitFactor,
    type,capital,time/1000,size,price,stopLoss,takeProfit)
  return 
  /*
  let params = [setup.rsiLength,setup.rsiOverbought,setup.rsiOversold,setup.stopLossLookBack,setup.profitFactor,type,capital,time/1000,size,price,stopLoss,takeProfit]
  // let selectSql = `select * from trade where setup_rsilength = ? and setup_rsioverbought = ? and setup_rsioversold = ? and setup_stoplosslookback = ? and setup_profitfactor = ? and type = ? and enter_capital = ? and enter_time = ?`
  // let selectResult = await con.query(selectSql,params)
  // switch (selectResult.length) {
  //   case 0:
      let insertSql = `insert into trade (setup_rsilength,setup_rsioverbought,setup_rsioversold,setup_stoplosslookback,setup_profitfactor,
        type,enter_capital,enter_time,enter_size,enter_price,stop_loss,take_profit) value(?,?,?,?,?,?,?,?,?,?,?,?)`
      let insertResult = await con.query(insertSql,params)
      return insertResult.insertId
  //   case 1:
  //     return selectResult.id
  //   default:
  //     debugger
  //     throw 'Duplicate record'
  // }
  */
}

var exitCount = 0

function exitTrade(query,time,price,profit,capital) {
  // query.exitCount++
  // tTrades = tTrades.concat([time/1000,price,profit,capital])
  query.params.push(time/1000,price,profit,capital)
  return
  // let sql = 'update trade set exit_time = ?, exit_price = ?, exit_profit = ?, exit_capital = ? where id = ?'
  // let result = await con.query(sql,[time/1000,price,profit,capital,tradeId])
}

exports.startTradeSetup = startTradeSetup
exports.endTradeSetup = endTradeSetup
exports.enterTrade = enterTrade
exports.exitTrade = exitTrade

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