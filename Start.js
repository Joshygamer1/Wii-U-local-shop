const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ftp = require("basic-ftp");

const PORT = 2012;
const HOST = "0.0.0.0";
const ROOT = __dirname;
const GAMES_FOLDER = path.join(ROOT, "games");

const WIIU_IP = process.env.WIIU_IP || "YOURWIIUIPHERE";
const WIIU_FTP_PORT = YOURWIIUPORTHERE;
const WIIU_INSTALL_PATH = "/fs/vol/external01/install";

const downloadQueue = [];
let downloadWorkerRunning = false;

const WUP_EXTENSIONS = [".app", ".h3", ".tik", ".tmd", ".cert"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "text/javascript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4"
};

/* BASIC VALIDATION */

function safeFolderName(name) {
    return typeof name === "string" &&
        name.length > 0 &&
        name !== "." &&
        name !== ".." &&
        !name.includes("/") &&
        !name.includes("\\") &&
        !name.includes("\0") &&
        path.basename(name) === name;
}

function getSafeGameFolder(name) {
    if (!safeFolderName(name)) return null;

    const folder = path.resolve(GAMES_FOLDER, name);
    const root = path.resolve(GAMES_FOLDER);

    if (!folder.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(folder)) return null;
    if (!fs.statSync(folder).isDirectory()) return null;

    return folder;
}

/* FTP CONNECTION */

async function connectWiiUFTP() {
    const client = new ftp.Client(15000);
    client.ftp.verbose = false;

    try {
        await client.access({
            host: WIIU_IP,
            port: WIIU_FTP_PORT,
            user: "anonymous",
            password: "",
            secure: false
        });

        return client;
    } catch (error) {
        client.close();
        throw error;
    }
}

async function testWiiUConnection() {
    let client;

    try {
        client = await connectWiiUFTP();
        const files = await client.list();

        return {
            success: true,
            message: "Connected to Wii U FTP",
            address: WIIU_IP,
            contents: files.map(file => ({
                name: file.name,
                type: file.isDirectory ? "folder" : "file"
            }))
        };
    } catch (error) {
        return { success: false, message: error.message };
    } finally {
        if (client) client.close();
    }
}

/* FTP BROWSER */

function validateWiiUPath(remotePath) {
    if (
        typeof remotePath !== "string" ||
        !remotePath.startsWith("/fs") ||
        remotePath.includes("\\") ||
        remotePath.includes("\0")
    ) return null;

    const parts = remotePath.split("/");

    if (parts.some(part => part === "." || part === "..")) {
        return null;
    }

    if (remotePath !== "/fs" && !remotePath.startsWith("/fs/")) {
        return null;
    }

    return remotePath.replace(/\/+$/, "") || "/fs";
}

async function browseWiiUDirectory(remotePath) {
    const safePath = validateWiiUPath(remotePath);

    if (!safePath) {
        return { success: false, error: "Invalid directory path" };
    }

    let client;

    try {
        client = await connectWiiUFTP();
        const files = await client.list(safePath);

        return {
            success: true,
            path: safePath,
            contents: files
                .filter(file => file.name !== "." && file.name !== "..")
                .map(file => ({
                    name: file.name,
                    type: file.isDirectory ? "folder" : "file",
                    size: file.isDirectory ? null : file.size,
                    modified: file.modifiedAt
                        ? file.modifiedAt.toISOString()
                        : null
                }))
        };
    } catch (error) {
        return {
            success: false,
            path: safePath,
            error: error.message
        };
    } finally {
        if (client) client.close();
    }
}

/* FIND PACKAGE FILES */

function getPackageFiles(folder, displayName) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        return null;
    }

    const files = fs.readdirSync(folder, { withFileTypes: true })
        .filter(item => item.isFile())
        .filter(item => WUP_EXTENSIONS.includes(
            path.extname(item.name).toLowerCase()
        ))
        .map(item => ({
            name: item.name,
            size: fs.statSync(path.join(folder, item.name)).size
        }));

    return {
        name: displayName,
        files,
        totalFiles: files.length,
        totalSize: files.reduce((sum, file) => sum + file.size, 0)
    };
}

/* MAIN GAME FILES */

function getGameDownloadFiles(name) {
    const folder = getSafeGameFolder(name);
    if (!folder) return null;

    return getPackageFiles(folder, name);
}

/* ADD-ON DETAILS */

function getAddonEntries(gameName, type) {
    if (type !== "DLC" && type !== "Updates") return [];

    const gameFolder = getSafeGameFolder(gameName);
    if (!gameFolder) return [];

    const addonRoot = path.join(gameFolder, type);

    if (
        !fs.existsSync(addonRoot) ||
        !fs.statSync(addonRoot).isDirectory()
    ) return [];

    return fs.readdirSync(addonRoot, { withFileTypes: true })
        .filter(item => item.isDirectory() && safeFolderName(item.name))
        .map(item => {
            const folder = path.join(addonRoot, item.name);
            const packageInfo = getPackageFiles(folder, item.name);

            if (!packageInfo || packageInfo.totalFiles === 0) return null;

            let icon = null;

            const iconNames = [
                "icon.png",
                "icon.jpg",
                "cover.png",
                "cover.jpg"
            ];

            for (const filename of iconNames) {
                const iconPath = path.join(folder, filename);

                if (
                    fs.existsSync(iconPath) &&
                    fs.statSync(iconPath).isFile()
                ) {
                    icon = "/games/" +
                        encodeURIComponent(gameName) + "/" +
                        encodeURIComponent(type) + "/" +
                        encodeURIComponent(item.name) + "/" +
                        filename;
                    break;
                }
            }

            const descriptionPath = path.join(
                folder,
                "About this software.txt"
            );

            let description = "";

            if (
                fs.existsSync(descriptionPath) &&
                fs.statSync(descriptionPath).isFile()
            ) {
                description = fs.readFileSync(descriptionPath, "utf8");
            }

            const screenshots = [];

            for (let i = 1; i <= 5; i++) {
                for (const extension of IMAGE_EXTENSIONS) {
                    const filename = "screenshot" + i + extension;
                    const screenshotPath = path.join(folder, filename);

                    if (
                        fs.existsSync(screenshotPath) &&
                        fs.statSync(screenshotPath).isFile()
                    ) {
                        screenshots.push(
                            "/games/" +
                            encodeURIComponent(gameName) + "/" +
                            encodeURIComponent(type) + "/" +
                            encodeURIComponent(item.name) + "/" +
                            filename
                        );
                        break;
                    }
                }
            }

            return {
                name: item.name,
                type,
                icon,
                description,
                screenshots,
                totalFiles: packageInfo.totalFiles,
                totalSize: packageInfo.totalSize
            };
        })
        .filter(Boolean);
}

/* GET GAME LIBRARY */

function getGames() {
    if (!fs.existsSync(GAMES_FOLDER)) {
        fs.mkdirSync(GAMES_FOLDER, { recursive: true });
        return [];
    }

    return fs.readdirSync(GAMES_FOLDER, { withFileTypes: true })
        .filter(item => item.isDirectory())
        .map(item => {
            const name = item.name;
            const folder = path.join(GAMES_FOLDER, name);

            let artwork = null;

            for (const filename of [
                "icon.png", "cover.png", "banner.png",
                "icon.jpg", "cover.jpg"
            ]) {
                const artworkPath = path.join(folder, filename);

                if (
                    fs.existsSync(artworkPath) &&
                    fs.statSync(artworkPath).isFile()
                ) {
                    artwork = "/games/" +
                        encodeURIComponent(name) + "/" + filename;
                    break;
                }
            }

            let category = "Uncategorised";
            const categoryPath = path.join(folder, "category.txt");

            if (
                fs.existsSync(categoryPath) &&
                fs.statSync(categoryPath).isFile()
            ) {
                const text = fs.readFileSync(categoryPath, "utf8").trim();
                if (text) category = text;
            }

            return { name, artwork, folder: name, category };
        });
}

/* GET GAME DETAILS */

function getGameDetails(name) {
    const folder = getSafeGameFolder(name);
    if (!folder) return null;

    const descriptionPath = path.join(
        folder,
        "About this software.txt"
    );

    let description = "";

    if (
        fs.existsSync(descriptionPath) &&
        fs.statSync(descriptionPath).isFile()
    ) {
        description = fs.readFileSync(descriptionPath, "utf8");
    }

    const screenshots = [];

    for (let i = 1; i <= 5; i++) {
        for (const extension of IMAGE_EXTENSIONS) {
            const filename = "screenshot" + i + extension;
            const screenshotPath = path.join(folder, filename);

            if (
                fs.existsSync(screenshotPath) &&
                fs.statSync(screenshotPath).isFile()
            ) {
                screenshots.push(
                    "/games/" +
                    encodeURIComponent(name) + "/" + filename
                );
                break;
            }
        }
    }

    return {
        name,
        description,
        screenshots,
        updates: getAddonEntries(name, "Updates"),
        dlc: getAddonEntries(name, "DLC")
    };
}

/* FIND AN ADD-ON PACKAGE */

function getAddonDownloadFiles(gameName, type, addonName) {
    if (type !== "DLC" && type !== "Updates") return null;
    if (!safeFolderName(addonName)) return null;

    const gameFolder = getSafeGameFolder(gameName);
    if (!gameFolder) return null;

    const addonRoot = path.join(gameFolder, type);
    const folder = path.resolve(addonRoot, addonName);

    if (!folder.startsWith(path.resolve(addonRoot) + path.sep)) {
        return null;
    }

    if (
        !fs.existsSync(folder) ||
        !fs.statSync(folder).isDirectory()
    ) return null;

    return getPackageFiles(folder, addonName);
}

/* CREATE DOWNLOAD QUEUE ITEM */

function addToDownloadQueue(gameName, type, addonName) {
    const isAddon = !!addonName;

    const packageInfo = isAddon
        ? getAddonDownloadFiles(gameName, type, addonName)
        : getGameDownloadFiles(gameName);

    if (!packageInfo || packageInfo.totalFiles === 0) return null;

    const queueKey = isAddon
        ? gameName + "|" + type + "|" + addonName
        : gameName + "|GAME";

    const existing = downloadQueue.find(item => item.queueKey === queueKey);

    if (existing) {
        return { ...existing, alreadyQueued: true };
    }

    const remoteFolder = isAddon
        ? (gameName + " - " + type + " - " + addonName)
        : gameName;

    const item = {
        id: crypto.randomUUID(),
        queueKey,
        name: gameName,
        displayName: isAddon
            ? gameName + " - " + type + ": " + addonName
            : gameName,
        gameName,
        type: isAddon ? type : "GAME",
        addonName: isAddon ? addonName : null,
        localFolder: isAddon
            ? path.join(GAMES_FOLDER, gameName, type, addonName)
            : path.join(GAMES_FOLDER, gameName),
        remoteFolder,
        files: packageInfo.files,
        totalFiles: packageInfo.totalFiles,
        totalSize: packageInfo.totalSize,
        uploadedFiles: 0,
        uploadedBytes: 0,
        progress: 0,
        status: "queued",
        message: "Waiting for Wii U connection",
        createdAt: new Date().toISOString()
    };

    downloadQueue.push(item);
    return item;
}

/* REMOVE DOWNLOAD */

function removeFromDownloadQueue(id) {
    const index = downloadQueue.findIndex(item => item.id === id);
    if (index === -1) return false;

    const item = downloadQueue[index];

    if (item.status === "connecting" || item.status === "uploading") {
        return false;
    }

    downloadQueue.splice(index, 1);
    return true;
}

/* UPLOAD PACKAGE TO WII U
   FIX: ensureDir() creates the directory and changes into it.
   Do NOT call client.cd(item.remoteFolder) again afterwards.
*/

async function uploadGameToWiiU(item) {
    let client;
    let stage = "Starting";

    try {
        item.status = "connecting";
        item.message = "Connecting to Wii U...";
        item.progress = 0;
        item.uploadedFiles = 0;
        item.uploadedBytes = 0;

        stage = "Connecting to Wii U FTP";
        client = await connectWiiUFTP();

        stage = "Opening Wii U install directory";
        await client.cd(WIIU_INSTALL_PATH);

        console.log("FTP install directory:", await client.pwd());

        stage = "Creating package directory: " + item.remoteFolder;

        // ensureDir() leaves the FTP client inside this directory.
        await client.ensureDir(item.remoteFolder);

        console.log("FTP package destination:", await client.pwd());

        item.status = "uploading";
        item.message = "Uploading package files...";

        for (let i = 0; i < item.files.length; i++) {
            const file = item.files[i];
            const localPath = path.join(item.localFolder, file.name);

            if (
                !fs.existsSync(localPath) ||
                !fs.statSync(localPath).isFile()
            ) {
                throw new Error("Missing PC file: " + file.name);
            }

            stage = "Uploading " + file.name;

            item.message =
                "Uploading " + file.name +
                " (" + (i + 1) + "/" + item.totalFiles + ")";

            console.log("Uploading:", file.name);

            await client.uploadFrom(localPath, file.name);

            item.uploadedFiles++;
            item.uploadedBytes += file.size;

            item.progress = item.totalSize > 0
                ? Math.round(item.uploadedBytes / item.totalSize * 100)
                : 100;
        }

        item.status = "completed";
        item.progress = 100;
        item.message = "Transfer completed successfully!";

        console.log("Transfer completed:", item.displayName);

    } catch (error) {
        item.status = "failed";
        item.message = error.message;

        console.log("FTP transfer failed at:", stage);
        console.log("Package:", item.displayName);
        console.log("FTP error:", error);

    } finally {
        if (client) client.close();
    }
}

/* PROCESS QUEUE */

async function processDownloadQueue() {
    if (downloadWorkerRunning) return;

    downloadWorkerRunning = true;

    try {
        while (true) {
            const next = downloadQueue.find(item => item.status === "queued");
            if (!next) break;

            await uploadGameToWiiU(next);
        }
    } finally {
        downloadWorkerRunning = false;

        if (downloadQueue.some(item => item.status === "queued")) {
            processDownloadQueue();
        }
    }
}

/* SIMPLE FTP BROWSER PAGE */

const ftpBrowserHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wii U File Browser</title>
<style>
body{margin:0;background:#e8edf2;font-family:Arial;color:#333}
header{background:#009ac7;color:white;padding:20px;text-align:center}
main{max-width:850px;margin:25px auto;padding:15px}
.panel{background:white;padding:20px;border-radius:8px}
button{background:#009ac7;color:white;border:0;padding:10px 15px;cursor:pointer;margin:4px}
.entry{padding:12px;border-bottom:1px solid #ddd}
.folderButton{background:none;color:#167ba0}
</style>
</head>
<body>
<header><h2>Wii U File Browser</h2></header>
<main><div class="panel">
<button id="back">← Back</button>
<button id="refresh">Refresh</button>
<p id="path">/fs</p>
<p id="status">Loading...</p>
<div id="files"></div>
<p>Read-only browser. Files are not modified.</p>
</div></main>
<script>
var currentPath="/fs";
var files=document.getElementById("files");
var statusText=document.getElementById("status");

function load(){
 files.innerHTML="";
 document.getElementById("path").textContent=currentPath;
 statusText.textContent="Loading...";
 document.getElementById("back").disabled=currentPath==="/fs";
 fetch("/api/ftp/browse?path="+encodeURIComponent(currentPath))
 .then(function(r){return r.json();})
 .then(function(data){
  if(!data.success){statusText.textContent=data.error;return;}
  statusText.textContent=data.contents.length+" items";
  data.contents.forEach(function(item){
   var row=document.createElement("div");
   row.className="entry";
   if(item.type==="folder"){
    var b=document.createElement("button");
    b.className="folderButton";
    b.textContent="📁 "+item.name;
    b.onclick=function(){currentPath+="/"+item.name;load();};
    row.appendChild(b);
   }else{
    row.textContent="📄 "+item.name;
   }
   files.appendChild(row);
  });
 })
 .catch(function(e){statusText.textContent=e.message;});
}
document.getElementById("back").onclick=function(){
 if(currentPath==="/fs")return;
 currentPath=currentPath.substring(0,currentPath.lastIndexOf("/"))||"/fs";
 load();
};
document.getElementById("refresh").onclick=load;
load();
</script>
</body>
</html>`;

/* SERVER */

const server = http.createServer((req, res) => {
    let url;

    try {
        url = new URL(req.url, "http://localhost");
    } catch {
        res.writeHead(400);
        return res.end("Bad request");
    }

    let requestedPath;

    try {
        requestedPath = decodeURIComponent(url.pathname);
    } catch {
        res.writeHead(400);
        return res.end("Bad request");
    }

    function sendJSON(data, statusCode = 200) {
        res.writeHead(statusCode, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify(data));
    }

    function readJSONBody(callback) {
        let body = "";
        let tooLarge = false;

        req.on("data", chunk => {
            body += chunk;
            if (body.length > 10000) tooLarge = true;
        });

        req.on("end", () => {
            if (tooLarge) {
                return sendJSON({ error: "Request too large" }, 413);
            }

            try {
                callback(JSON.parse(body));
            } catch {
                sendJSON({ error: "Invalid JSON" }, 400);
            }
        });
    }

    if (requestedPath === "/ftp" && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
        });
        return res.end(ftpBrowserHTML);
    }

    if (requestedPath === "/api/ftp/test" && req.method === "POST") {
        return testWiiUConnection().then(result =>
            sendJSON(result, result.success ? 200 : 503)
        );
    }

    if (requestedPath === "/api/ftp/browse" && req.method === "GET") {
        return browseWiiUDirectory(
            url.searchParams.get("path") || "/fs"
        ).then(result => sendJSON(result, result.success ? 200 : 400));
    }

    if (requestedPath === "/api/games" && req.method === "GET") {
        return sendJSON(getGames());
    }

    if (requestedPath === "/api/game-details" && req.method === "GET") {
        const details = getGameDetails(url.searchParams.get("name"));

        if (!details) {
            return sendJSON({
                error: "Game not found",
                description: "",
                screenshots: [],
                updates: [],
                dlc: []
            }, 404);
        }

        return sendJSON(details);
    }

    if (requestedPath === "/api/download-info" && req.method === "GET") {
        const name = url.searchParams.get("name");
        const type = url.searchParams.get("type");
        const addon = url.searchParams.get("addon");

        const info = addon
            ? getAddonDownloadFiles(name, type, addon)
            : getGameDownloadFiles(name);

        if (!info) return sendJSON({ error: "Package not found" }, 404);

        if (!info.totalFiles) {
            return sendJSON({
                error: "No WUP files found",
                name,
                files: []
            }, 404);
        }

        return sendJSON(info);
    }

    if (requestedPath === "/api/downloads" && req.method === "POST") {
        return readJSONBody(data => {
            if (!data || typeof data.name !== "string" || !data.name.trim()) {
                return sendJSON({ error: "Invalid game name" }, 400);
            }

            const name = data.name.trim();
            const type = data.type;
            const addon = data.addon;

            if (addon && (type !== "DLC" && type !== "Updates")) {
                return sendJSON({ error: "Invalid add-on type" }, 400);
            }

            const item = addToDownloadQueue(name, type, addon);

            if (!item) {
                return sendJSON({
                    error: "Package not found or no WUP files available"
                }, 404);
            }

            if (!item.alreadyQueued) processDownloadQueue();

            return sendJSON({
                success: true,
                message: item.alreadyQueued
                    ? "Package is already in the download queue"
                    : "Package added. Wii U transfer starting.",
                download: item,
                alreadyQueued: !!item.alreadyQueued
            }, item.alreadyQueued ? 200 : 201);
        });
    }

    if (requestedPath === "/api/downloads" && req.method === "GET") {
        return sendJSON({
            downloads: downloadQueue,
            totalDownloads: downloadQueue.length
        });
    }

    if (
        requestedPath.startsWith("/api/downloads/") &&
        req.method === "DELETE"
    ) {
        const id = requestedPath.substring("/api/downloads/".length);

        if (!id || id.includes("/")) {
            return sendJSON({ error: "Invalid download ID" }, 400);
        }

        if (!removeFromDownloadQueue(id)) {
            return sendJSON({
                error: "Download not found, or transfer is currently active"
            }, 409);
        }

        return sendJSON({
            success: true,
            message: "Download removed from queue"
        });
    }

    if (requestedPath === "/") requestedPath = "/index.html";

    const filePath = path.resolve(ROOT, "." + requestedPath);

    if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("404 - File not found");
        }

        const ext = path.extname(filePath).toLowerCase();

        res.writeHead(200, {
            "Content-Type": mimeTypes[ext] || "application/octet-stream"
        });

        res.end(data);
    });
});

/* START SERVER */

server.listen(PORT, HOST, () => {
    console.log("");
    console.log("==================================");
    console.log(" Nintendo eShop server running!");
    console.log("==================================");
    console.log("PC: http://localhost:" + PORT);
    console.log("Wii U: http://YOUR-PC-IP:" + PORT);
    console.log("");
    console.log("Game Library: /api/games");
    console.log("Game Details: /api/game-details");
    console.log("Download Info: /api/download-info");
    console.log("Downloads: /api/downloads");
    console.log("FTP Browser: http://localhost:" + PORT + "/ftp");
    console.log("Wii U FTP: " + WIIU_IP + ":" + WIIU_FTP_PORT);
    console.log("Install folder: " + WIIU_INSTALL_PATH);
    console.log("");
    console.log("DLC and Updates support is enabled.");
    console.log("==================================");
});
