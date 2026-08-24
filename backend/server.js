const express = require('express');
const app = express();
const port = process.env.PORT || 5001;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'kpanel-backend' });
});

app.listen(port, () => {
  console.log(`K-Panel Backend running on port ${port}`);
});
