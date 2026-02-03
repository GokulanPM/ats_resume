const fs = require('fs');
const payload = fs.readFileSync('./test_payload.json', 'utf8');

async function send() {
  try {
    const res = await fetch('http://localhost:5000/analyze-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Body:', text);
  } catch (err) {
    console.error('Request failed:', err);
  }
}

send();