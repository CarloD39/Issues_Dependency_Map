require('dotenv').config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

const savedMaps = {};

app.post("/api/publish-map", (req, res) => {
  const { key, ...graph } = req.body;
  if (!key) return res.status(400).json({ error: "Parametro 'key' mancante" });
  savedMaps[key] = { ...graph, publishedAt: new Date().toISOString() };
  res.json({ ok: true, key, publishedAt: savedMaps[key].publishedAt });
});

app.get("/api/current-map/:key", (req, res) => {
  const map = savedMaps[req.params.key];
  if (!map) return res.status(404).json({ error: `Nessuna mappa per "${req.params.key}"` });
  res.json(map);
});

app.get("/api/maps", (req, res) => {
  res.json(Object.entries(savedMaps).map(([key, m]) => ({
    key, publishedAt: m.publishedAt, nodeCount: m.nodes?.length ?? 0
  })));
});

app.post("/api/analyze", async (req, res) => {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));