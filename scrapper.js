import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_FILE = path.join(process.cwd(), "cache.json");
const CACHE_TTL = +(process.env.CACHE_TTL_MS || 24 * 60 * 60 * 1000); // 24h por defecto

// --- Static: servimos dashboard y vistas desde /public ---
app.use(express.static("public"));

// --- Control de concurrencia para evitar abrir múltiples navegadores a la vez ---
let runningFetch = null;

// --- Core: scraping SENAMHI ---
async function obtenerPronostico() {
  console.log("🛰️  Obteniendo pronóstico del SENAMHI...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
    // Si despliegas en host con Chrome ya instalado:
    // executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
  });

  try {
    const page = await browser.newPage();
    await page.goto("https://www.senamhi.gob.pe/?p=pronostico-meteorologico", {
      waitUntil: "networkidle2",
      timeout: 60000
    });
    await page.waitForSelector("table");

    const data = await page.evaluate(() => {
      const ciudades = [];
      const bloques = document.querySelectorAll("tbody.buscar > tr > td");
      bloques.forEach(bloque => {
        const ciudad = bloque.querySelector(".nameCity a")?.innerText.trim();
        const dias = [];
        const pronos = bloque.querySelectorAll(".row.m-3");
        pronos.forEach(row => {
          const fecha = row.querySelector(".col-sm-3")?.innerText.trim();
          const max = row.querySelector(".text-danger")?.innerText.trim();
          const min = row.querySelector(".text-primary")?.innerText.trim();
          const descripcion = row.querySelector(".col-sm-6")?.innerText.trim();
          dias.push({ fecha, max, min, descripcion });
        });
        if (ciudad) ciudades.push({ ciudad, pronostico: dias });
      });
      return ciudades;
    });

    console.log("✅ Pronóstico actualizado.");
    return data;
  } finally {
    await browser.close();
  }
}

// --- Caché local con “force refresh” y bloqueo de concurrencia ---
async function getCachedData({ force = false } = {}) {
  // Si no hay force y el cache existe y es fresco → devolver cache
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      const now = Date.now();
      if (now - cache.timestamp < CACHE_TTL && Array.isArray(cache.data)) {
        console.log("♻️  Usando datos en caché...");
        return cache.data;
      }
    } catch (_) { /* si falla, seguimos a scrape */ }
  }

  // Evitar múltiples scrapes simultáneos
  if (!runningFetch) {
    runningFetch = (async () => {
      const newData = await obtenerPronostico();
      fs.writeFileSync(
        CACHE_FILE,
        JSON.stringify({ timestamp: Date.now(), data: newData }, null, 2)
      );
      return newData;
    })().finally(() => {
      runningFetch = null;
    });
  } else {
    console.log("⏳ Ya hay un scrape en curso; esperando resultado...");
  }

  return runningFetch;
}

// --- API principal ---
app.get("/api/pronostico", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const data = await getCachedData({ force });
    res.json(data);
  } catch (err) {
    console.error("API /api/pronostico error:", err);
    res.status(500).json({ error: "Error al obtener pronóstico" });
  }
});

// --- Endpoint para refrescar manualmente desde el dashboard (opcional) ---
app.post("/api/pronostico/refresh", async (_req, res) => {
  try {
    const data = await getCachedData({ force: true });
    res.json({ ok: true, count: data.length });
  } catch (err) {
    console.error("POST /api/pronostico/refresh error:", err);
    res.status(500).json({ ok: false, error: "No se pudo refrescar" });
  }
});

// --- Healthcheck simple ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- Pre-warm de caché al iniciar (no bloquea el arranque) ---
getCachedData({ force: false }).catch(() => { /* ignorar al inicio */ });

// --- Iniciar servidor ---
app.listen(PORT, () => {
  console.log(`🌐 Servidor disponible en: http://localhost:${PORT}`);
  console.log(`📄 Dashboard: http://localhost:${PORT}/`);
  console.log(`🌦️ Pronóstico: http://localhost:${PORT}/pronostico.html`);
});


// --- Iniciar servidor ---
// OJO: guardamos la referencia del server y escuchamos eventos
/*const server = app.listen(PORT, () => {
  console.log(`🌐 Servidor disponible en: http://localhost:${PORT}`);
  console.log(`📄 Dashboard: http://localhost:${PORT}/`);
  console.log(`🌦️ Pronóstico: http://localhost:${PORT}/pronostico.html`);
});*/

// Log de eventos por si algo lo cierra
server.on('close', () => console.error('🛑 server.close() fue llamado'));
server.on('error', (err) => console.error('❌ server error:', err));
process.on('SIGINT',  () => { console.warn('SIGINT');  /* no cerramos */ });
process.on('SIGTERM', () => { console.warn('SIGTERM'); /* no cerramos */ });

// Mantener una referencia fuerte (defensivo)
global.__serverRef = server;
