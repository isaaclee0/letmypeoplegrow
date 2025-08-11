fetch('https://sms.crazytel.net.au/api/v1/sms/send', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '0491570006',
    from: '0491571266',
    message: 'Testing',
  }),
})
.then(response => response.json())
.then(data => console.log(data))
.catch((error) => console.error('Error:', error));