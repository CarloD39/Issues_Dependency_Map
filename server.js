require('dotenv').config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

const savedMaps = {};

async function pushToGist(key, graph) {
  const filename = `${key}.json`;
  const content = JSON.stringify({ ...graph, key }, null, 2);

  // Cerca gist esistente con questo filename
  const listRes = await fetch('https://api.github.com/gists', {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' }
  });
  const gists = await listRes.json();
  const existing = gists.find(g => g.files[filename]);

  if (existing) {
    await fetch(`https://api.github.com/gists/${existing.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ files: { [filename]: { content } } })
    });
    return existing.id;
  } else {
    const createRes = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ description: `Dependency map: ${key}`, public: true, files: { [filename]: { content } } })
    });
    const data = await createRes.json();
    console.log('[gist] GitHub response:', JSON.stringify(data).slice(0, 200)); // ← aggiungi
    return data.id;
  }
}

app.post("/api/publish-map", (req, res) => {
  const { key, ...graph } = req.body;
  if (!key) return res.status(400).json({ error: "Parametro 'key' mancante" });
  savedMaps[key] = { ...graph, publishedAt: new Date().toISOString() };
  pushToGist(key, graph).then(id => {
    savedMaps[key].gistId = id;
    console.log(`[gist] Pubblicato su https://gist.github.com/${id}`);
  }).catch(e => console.warn('[gist] Errore:', e.message));
  res.json({ ok: true, key, publishedAt: savedMaps[key].publishedAt });
});

app.get("/api/current-map/:key", (req, res) => {
  const map = savedMaps[req.params.key];
  if (!map) return res.status(404).json({ error: `Nessuna mappa per "${req.params.key}"` });
  res.json(map);
});

app.get("/api/maps", (req, res) => {
  res.json(Object.entries(savedMaps).map(([key, m]) => ({
    key, publishedAt: m.publishedAt, nodeCount: m.nodes?.length ?? 0, gistId: m.gistId || null
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