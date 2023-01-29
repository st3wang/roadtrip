const shoes = require('../shoes')
const AWS = require('aws-sdk')

AWS.config.update({ region: 'eu-west-1'})
const SES = new AWS.SES({apiVersion: '2010-12-01'})

// var credentials = new AWS.SharedIniFileCredentials({
//   profile: ‘work - account’
// });
// AWS.config.credentials = credentials;

let mailParams = {
  Destination: {
    ToAddresses: [shoes.email.to]
  },
  Message: {
    Body: {
      Text: {
        Charset: "UTF-8",
        Data: 'text'
      }
    },
    Subject: {
      Charset: 'UTF-8',
      Data: 'subject'
    }
  },
  Source: shoes.email.from,
  ReplyToAddresses: [shoes.email.from],
}

async function send(subject, text) {
  mailParams.Message.Subject.Data = subject
  mailParams.Message.Body.Text.Data = text
  return SES.sendEmail(mailParams).promise()
}

module.exports = {
  send: send
}