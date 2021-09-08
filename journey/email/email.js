const nodemailer = require('nodemailer')
const shoes = require('../shoes')

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: shoes.email.user,
    pass: shoes.email.pass
  }
})

const mailOptions = {
  from: 'bitmoonboy@gmail.com',
  to: 'bitmoonboy@gmail.com',
  subject: 'Trade Enter',
  text: 'Trade entered with price ...'
}

async function send(subject, text) {
  mailOptions.subject = subject
  mailOptions.text = text
  transporter.sendMail(mailOptions, function(error, info){
    if (error) {
      console.error(error);
    }
  })
}

module.exports = {
  send: send
}