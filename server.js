/**
 * Railway deploy için basit static server
 * index.html varsayılan, dizin listesi yok
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
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
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  let filePath = ROUTES[urlPath] || ROUTES[urlPath.replace(/\/$/, "")] || urlPath;
  if (filePath === "/") filePath = "/index.html";

  const fullPath = path.join(ROOT, path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, ""));
  if (!fullPath.startsWith(ROOT)) {
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
          res.writeHead(200, { "Content-Type": "text/html" });
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
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
