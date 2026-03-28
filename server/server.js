/**
 * Railway deploy için basit static server
 * Statik dosyalar public/ altında; index.html varsayılan, dizin listesi yok
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "..", "public");

/** Чтобы после деплоя на Railway сразу подтягивались новые script.js / style.css, а не кэш браузера/CDN. */
function cacheControlForExt(ext) {
  if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css" || ext === ".json") {
    return "no-cache, no-store, must-revalidate, max-age=0";
  }
  return "public, max-age=3600";
}

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const ROUTES = {
  "/": "/index.html",
  "/dashboard": "/dashboard.html",
  "/login": "/login.html",
  "/help": "/help.html",
  "/view": "/view.html",
  "/game": "/game.html",
  "/game.html": "/game.html",
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  let filePath = ROUTES[urlPath] || ROUTES[urlPath.replace(/\/$/, "")] || urlPath;
  if (filePath === "/") filePath = "/index.html";

  const rel = String(filePath).replace(/^\/+/, "").replace(/\\/g, "/").replace(/^(\.\.\/)+/, "");
  const fullPath = path.resolve(ROOT, rel);
  const rootResolved = path.resolve(ROOT);
  const relCheck = path.relative(rootResolved, fullPath);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(fullPath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      const fallback = path.join(ROOT, "index.html");
      fs.readFile(fallback, (e2, d2) => {
        if (e2) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        } else {
          res.writeHead(200, {
            "Content-Type": "text/html",
            "Cache-Control": cacheControlForExt(".html"),
          });
          res.end(d2);
        }
      });
      return;
    }
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error");
        return;
      }
      const ext = path.extname(fullPath);
      const contentType = MIME[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": cacheControlForExt(ext),
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
