const express = require('express');
const path = require('path');

const app = express();
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);

app.use(express.static(rootDir));

app.get('/health', function (_req, res) {
  res.json({ ok: true });
});

app.listen(port, function () {
  console.log(`Registration server running at http://localhost:${port}`);
});
