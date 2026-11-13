require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

function generateCode() {
  return crypto.randomBytes(5).toString('base64url').slice(0, 7);
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

app.get('/', (req, res) => {
  res.send('URL shortener is running');
});

// Create a short link
app.post('/shorten', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Provide a valid http/https url' });
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await pool.query(
        'INSERT INTO urls (short_code, original_url) VALUES ($1, $2)',
        [code, url]
      );
      return res.status(201).json({
        short_code: code,
        short_url: `http://localhost:${PORT}/${code}`,
      });
    } catch (err) {
      if (err.code === '23505') continue; // code already exists, try another
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  res.status(500).json({ error: 'Could not generate a unique code' });
});

// Redirect a short link
app.get('/:code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT original_url FROM urls WHERE short_code = $1',
      [req.params.code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Short link not found' });
    }
    res.redirect(result.rows[0].original_url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});