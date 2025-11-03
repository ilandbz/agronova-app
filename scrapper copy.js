import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

// ===== Handlers globales para ver cualquier error =====
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});

// ===== App / config =====
const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_FILE = path.join(process.cwd(), "cache.json");
const CACHE_TTL = +(process.env.CACHE_TTL_MS || 24 * 60 * 60 * 1000); // 24h

// Servir estáticos del dashboard
app.use(express.static("public"));

// Evitar scrapes concurrentes
let runningFetch = null;

// ===== Core: scraping =====
async function obtenerPronostico() {
  console.log("🛰️  Obteniendo pronóstico del SENAMHI...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
    );

    await page.goto(
      "https://www.senamhi.gob.pe/?p=pronostico-meteorologico",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );

    // Espera flexible a que aparezca algo de la tabla
    await page.waitForSelector("table, tbody.buscar", { timeout: 30000 });

    // IMPORTANTE: evaluate robusto y sin duplicar 'descripcion'
    const data = await page.evaluate(() => {
      const ciudades = [];
      const bloques = document.querySelectorAll("tbody.buscar > tr > td");
      if (!bloques || bloques.length === 0) return ciudades;

      bloques.forEach((bloque) => {
        const ciudad =
          bloque.querySelector(".nameCity a")?.textContent?.trim() ||
          bloque.querySelector(".nameCity")?.textContent?.trim() ||
          null;

        const dias = [];
        const pronos = bloque.querySelectorAll(".row.m-3");

        pronos.forEach((row) => {
          const fecha =
            row.querySelector(".col-sm-3")?.textContent?.trim() ?? null;
          const max =
            row.querySelector(".text-danger")?.textContent?.trim() ?? null;
          const min =
            row.querySelector(".text-primary")?.textContent?.trim() ?? null;
          const descripcion =
            row.querySelector(".col-sm-6")?.textContent?.trim() ?? null;

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

// ===== Caché con force y bloqueo de concurrencia =====
async function getCachedData({ force = false } = {}) {
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      const now = Date.now();
      if (now - cache.timestamp < CACHE_TTL && Array.isArray(cache.data)) {
        console.log("♻️  Usando datos en caché...");
        return cache.data;
      }
    } catch {
      // si falla la lectura, continuamos a scrape
    }
  }

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

// ===== API =====
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

app.post("/api/pronostico/refresh", async (_req, res) => {
  try {
    const data = await getCachedData({ force: true });
    res.json({ ok: true, count: data.length });
  } catch (err) {
    console.error("POST /api/pronostico/refresh error:", err);
    res.status(500).json({ ok: false, error: "No se pudo refrescar" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ===== Iniciar servidor =====
const server = app.listen(PORT, () => {
  console.log(`🌐 Servidor disponible en: http://localhost:${PORT}`);
  console.log(`📄 Dashboard: http://localhost:${PORT}/`);
  console.log(`🌦️ Pronóstico: http://localhost:${PORT}/pronostico.html`);
});

// Logs por si alguien lo cierra
server.on("close", () => console.error("🛑 server.close() fue llamado"));
server.on("error", (err) => console.error("❌ server error:", err));

// Mantener referencia fuerte (por si alguna lib debuga handles)
global.__serverRef = server;

// ===== Pre-warm asíncrono y aislado =====
setImmediate(() => {
  getCachedData({ force: false })
    .then(() => console.log("🔥 Cache precalentada"))
    .catch((err) => console.error("⚠️ Falló pre-warm (ignorado):", err));
});

// ===== (Opcional) Mantener el event-loop vivo durante diagnóstico =====
// Quita esto si no lo necesitas.
// setInterval(() => {}, 1 << 30);
