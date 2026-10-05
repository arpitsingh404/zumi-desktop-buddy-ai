/* Tiny static server for the Zumi website. Usage: node server.js [port] */
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = process.argv[3] ? path.resolve(process.argv[3]) : __dirname;
const port = parseInt(process.argv[2] || "8080", 10);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8" };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404 not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "text/plain; charset=utf-8" });
    res.end(data);
  });
}).listen(port, () => console.log("Zumi site running:  http://localhost:" + port));
