
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ftp = require("basic-ftp");

const PORT = 2012;
const HOST = "0.0.0.0";
const ROOT = __dirname;
const GAMES_FOLDER = path.join(ROOT, "games");

/* WII U FTP SETTINGS */

const WIIU_IP = process.env.WIIU_IP || "YOURWIIUIPHERE";
const WIIU_FTP_PORT = YOURWIIUPORTHERE;
const WIIU_INSTALL_PATH = "/fs/vol/external01/install";

/* DOWNLOAD QUEUE */

const downloadQueue = [];
let downloadWorkerRunning = false;

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

/* CONNECT TO WII U FTP */

async function connectWiiUFTP() {
    const client = new ftp.Client(15000);
    client.ftp.verbose = false;

    await client.access({
        host: WIIU_IP,
        port: WIIU_FTP_PORT,
        user: "anonymous",
        password: "",
        secure: false
    });

    return client;
}

/* TEST WII U FTP CONNECTION */

async function testWiiUConnection() {
    let client;

    try {
        console.log("Connecting to Wii U FTP...");

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
        console.log("Wii U FTP connection failed:", error.message);

        return {
            success: false,
            message: error.message
        };

    } finally {
        if (client) client.close();
    }
}

/* VALIDATE WII U DIRECTORY PATH */

function validateWiiUPath(remotePath) {
    if (
        typeof remotePath !== "string" ||
        !remotePath.startsWith("/fs") ||
        remotePath.includes("\\") ||
        remotePath.includes("\0")
    ) {
        return null;
    }

    const parts = remotePath.split("/");

    if (parts.some(part => part === "." || part === "..")) {
        return null;
    }

    if (
        remotePath !== "/fs" &&
        !remotePath.startsWith("/fs/")
    ) {
        return null;
    }

    return remotePath.replace(/\/+$/, "") || "/fs";
}

/* BROWSE WII U DIRECTORY */

async function browseWiiUDirectory(remotePath) {
    const safePath = validateWiiUPath(remotePath);

    if (!safePath) {
        return {
            success: false,
            error: "Invalid directory path"
        };
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

/* GET GAME LIBRARY */

function getGames() {
    if (!fs.existsSync(GAMES_FOLDER)) {
        fs.mkdirSync(GAMES_FOLDER, { recursive: true });
        return [];
    }

    return fs.readdirSync(GAMES_FOLDER, {
        withFileTypes: true
    })
    .filter(item => item.isDirectory())
    .map(item => {
        const name = item.name;
        const folder = path.join(GAMES_FOLDER, name);

        const artworkNames = [
            "icon.png",
            "cover.png",
            "banner.png",
            "icon.jpg",
            "cover.jpg"
        ];

        let artwork = null;

        for (const filename of artworkNames) {
            const artworkPath = path.join(folder, filename);

            if (
                fs.existsSync(artworkPath) &&
                fs.statSync(artworkPath).isFile()
            ) {
                artwork = "/games/" +
                    encodeURIComponent(name) +
                    "/" + filename;
                break;
            }
        }

        const categoryPath = path.join(folder, "category.txt");
        let category = "Uncategorised";

        if (
            fs.existsSync(categoryPath) &&
            fs.statSync(categoryPath).isFile()
        ) {
            const categoryText = fs.readFileSync(
                categoryPath,
                "utf8"
            ).trim();

            if (categoryText) category = categoryText;
        }

        return {
            name,
            artwork,
            folder: name,
            category
        };
    });
}

/* GET EXTRA GAME DETAILS */

function getGameDetails(name) {
    if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        path.basename(name) !== name
    ) {
        return null;
    }

    const folder = path.join(GAMES_FOLDER, name);

    if (
        !fs.existsSync(folder) ||
        !fs.statSync(folder).isDirectory()
    ) {
        return null;
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
        description = fs.readFileSync(
            descriptionPath,
            "utf8"
        );
    }

    const screenshots = [];
    const extensions = [".jpg", ".jpeg", ".png", ".webp"];

    for (let i = 1; i <= 5; i++) {
        for (const extension of extensions) {
            const filename = "screenshot" + i + extension;
            const screenshotPath = path.join(folder, filename);

            if (
                fs.existsSync(screenshotPath) &&
                fs.statSync(screenshotPath).isFile()
            ) {
                screenshots.push(
                    "/games/" +
                    encodeURIComponent(name) +
                    "/" + filename
                );
                break;
            }
        }
    }

    return {
        name,
        description,
        screenshots
    };
}

/* FIND WUP FILES FOR DOWNLOAD */

function getGameDownloadFiles(name) {
    if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        path.basename(name) !== name
    ) {
        return null;
    }

    const folder = path.join(GAMES_FOLDER, name);

    if (
        !fs.existsSync(folder) ||
        !fs.statSync(folder).isDirectory()
    ) {
        return null;
    }

    const allowedExtensions = [
        ".app",
        ".h3",
        ".tik",
        ".tmd",
        ".cert"
    ];

    const files = fs.readdirSync(folder, {
        withFileTypes: true
    })
    .filter(item => item.isFile())
    .filter(item =>
        allowedExtensions.includes(
            path.extname(item.name).toLowerCase()
        )
    )
    .map(item => {
        const filePath = path.join(folder, item.name);

        return {
            name: item.name,
            size: fs.statSync(filePath).size
        };
    });

    return {
        name,
        files,
        totalFiles: files.length,
        totalSize: files.reduce(
            (total, file) => total + file.size,
            0
        )
    };
}

/* CREATE DOWNLOAD QUEUE ITEM */

function addToDownloadQueue(name) {
    const downloadInfo = getGameDownloadFiles(name);

    if (!downloadInfo || downloadInfo.totalFiles === 0) {
        return null;
    }

    const existingDownload = downloadQueue.find(
        item => item.name === name
    );

    if (existingDownload) {
        return {
            ...existingDownload,
            alreadyQueued: true
        };
    }

    const item = {
        id: crypto.randomUUID(),
        name: downloadInfo.name,
        files: downloadInfo.files,
        totalFiles: downloadInfo.totalFiles,
        totalSize: downloadInfo.totalSize,
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

/* REMOVE DOWNLOAD QUEUE ITEM */

function removeFromDownloadQueue(id) {
    const index = downloadQueue.findIndex(
        item => item.id === id
    );

    if (index === -1) return false;

    const item = downloadQueue[index];

    if (
        item.status === "connecting" ||
        item.status === "uploading"
    ) {
        return false;
    }

    downloadQueue.splice(index, 1);
    return true;
}

/* FIND QUEUE ITEM */

function findDownload(id) {
    return downloadQueue.find(item => item.id === id);
}

/* UPLOAD ONE GAME TO THE WII U */

async function uploadGameToWiiU(item) {
    let client;

    try {
        item.status = "connecting";
        item.message = "Connecting to Wii U...";
        item.progress = 0;

        console.log("Connecting to Wii U for:", item.name);

        client = await connectWiiUFTP();

        item.message = "Opening SD card install folder...";

        // Use the confirmed SD card directory.
        await client.cd(WIIU_INSTALL_PATH);

        // Create and enter this game's own directory.
        await client.ensureDir(item.name);

        item.status = "uploading";
        item.message = "Uploading game files...";

        console.log(
            "Uploading",
            item.name,
            "to",
            WIIU_INSTALL_PATH + "/" + item.name
        );

        for (let i = 0; i < item.files.length; i++) {
            const file = item.files[i];

            const localPath = path.join(
                GAMES_FOLDER,
                item.name,
                file.name
            );

            if (!fs.existsSync(localPath)) {
                throw new Error("Missing PC file: " + file.name);
            }

            if (!fs.statSync(localPath).isFile()) {
                throw new Error("Not a file: " + file.name);
            }

            item.message =
                "Uploading " + file.name +
                " (" + (i + 1) + "/" + item.totalFiles + ")";

            console.log("Uploading:", file.name);

            await client.uploadFrom(localPath, file.name);

            item.uploadedFiles++;
            item.uploadedBytes += file.size;

            item.progress = item.totalSize > 0
                ? Math.round(
                    item.uploadedBytes / item.totalSize * 100
                )
                : 100;
        }

        item.status = "completed";
        item.progress = 100;
        item.message = "Transfer completed successfully!";

        console.log("Finished uploading:", item.name);

    } catch (error) {
        item.status = "failed";
        item.message = error.message;

        console.log(
            "Upload failed for",
            item.name,
            ":",
            error.message
        );

    } finally {
        if (client) client.close();
    }
}

/* PROCESS DOWNLOAD QUEUE */

async function processDownloadQueue() {
    if (downloadWorkerRunning) return;

    downloadWorkerRunning = true;

    try {
        while (true) {
            const nextItem = downloadQueue.find(
                item => item.status === "queued"
            );

            if (!nextItem) break;

            await uploadGameToWiiU(nextItem);
        }
    } finally {
        downloadWorkerRunning = false;

        // Catch any item added as the worker was finishing.
        if (downloadQueue.some(item => item.status === "queued")) {
            processDownloadQueue();
        }
    }
}

/* WII U FILE BROWSER PAGE */

const ftpBrowserHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wii U File Browser</title>
<style>
* { box-sizing: border-box; }
body {
    margin: 0;
    background: #e8edf2;
    color: #333;
    font-family: Arial, sans-serif;
}
header {
    background: #009ac7;
    color: white;
    padding: 22px;
    text-align: center;
}
header h1 { margin: 0; font-size: 25px; }
main { max-width: 850px; margin: 30px auto; padding: 20px; }
.panel {
    background: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 2px 8px #00000015;
}
.toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 18px;
}
button {
    border: 0;
    border-radius: 5px;
    padding: 11px 16px;
    background: #009ac7;
    color: white;
    cursor: pointer;
}
button:disabled { opacity: 0.4; cursor: default; }
#currentPath { overflow-wrap: anywhere; color: #666; }
.entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 8px;
    border-bottom: 1px solid #e5e5e5;
}
.entry:last-child { border-bottom: none; }
.entryName { overflow-wrap: anywhere; }
.folderButton {
    background: transparent;
    color: #167ba0;
    padding: 5px;
    text-align: left;
    font-size: 15px;
}
.fileName { color: #555; }
.fileSize { color: #888; font-size: 12px; white-space: nowrap; }
#status { color: #666; margin: 12px 0; }
.warning { margin-top: 18px; font-size: 13px; color: #777; }
</style>
</head>
<body>
<header><h1>Wii U File Browser</h1></header>
<main>
<div class="panel">
    <div class="toolbar">
        <button id="backButton">← Back</button>
        <button id="refreshButton">Refresh</button>
    </div>
    <p id="currentPath">/fs</p>
    <p id="status">Connecting...</p>
    <div id="fileList"></div>
    <p class="warning">
        Read-only browser. It does not upload, delete or modify files.
    </p>
</div>
</main>
<script>
let currentPath = "/fs";

const fileList = document.getElementById("fileList");
const statusText = document.getElementById("status");
const pathText = document.getElementById("currentPath");
const backButton = document.getElementById("backButton");

function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return "";
    if (bytes < 1024) return bytes + " bytes";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function openFolder(name) {
    currentPath = currentPath === "/fs"
        ? "/fs/" + name
        : currentPath + "/" + name;
    loadDirectory();
}

async function loadDirectory() {
    fileList.replaceChildren();
    pathText.textContent = currentPath;
    statusText.textContent = "Loading directory...";
    backButton.disabled = currentPath === "/fs";

    try {
        const response = await fetch(
            "/api/ftp/browse?path=" + encodeURIComponent(currentPath)
        );
        const data = await response.json();

        if (!data.success) {
            statusText.textContent =
                "Could not read directory: " + data.error;
            return;
        }

        statusText.textContent =
            data.contents.length + " items found";

        if (data.contents.length === 0) {
            statusText.textContent = "This folder is empty.";
            return;
        }

        data.contents.forEach(item => {
            const row = document.createElement("div");
            row.className = "entry";

            const name = document.createElement("div");
            name.className = "entryName";

            if (item.type === "folder") {
                const button = document.createElement("button");
                button.className = "folderButton";
                button.textContent = "📁 " + item.name;
                button.addEventListener("click", () => openFolder(item.name));
                name.appendChild(button);
            } else {
                const label = document.createElement("span");
                label.className = "fileName";
                label.textContent = "📄 " + item.name;
                name.appendChild(label);
            }

            const size = document.createElement("span");
            size.className = "fileSize";
            size.textContent = item.type === "file"
                ? formatSize(item.size)
                : "Folder";

            row.appendChild(name);
            row.appendChild(size);
            fileList.appendChild(row);
        });

    } catch (error) {
        statusText.textContent = "Connection error: " + error.message;
    }
}

backButton.addEventListener("click", () => {
    if (currentPath === "/fs") return;
    const parts = currentPath.split("/");
    parts.pop();
    currentPath = parts.join("/") || "/fs";
    loadDirectory();
});

document.getElementById("refreshButton")
    .addEventListener("click", loadDirectory);

loadDirectory();
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

    /* JSON RESPONSE HELPER */

    function sendJSON(data, statusCode = 200) {
        res.writeHead(statusCode, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify(data));
    }

    /* READ JSON REQUEST BODY */

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

    /* WII U FILE BROWSER PAGE */

    if (requestedPath === "/ftp" && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
        });
        return res.end(ftpBrowserHTML);
    }

    /* WII U FTP TEST API */

    if (
        requestedPath === "/api/ftp/test" &&
        req.method === "POST"
    ) {
        return testWiiUConnection().then(result => {
            sendJSON(result, result.success ? 200 : 503);
        }).catch(error => {
            sendJSON({ success: false, error: error.message }, 503);
        });
    }

    /* WII U FTP BROWSE API */

    if (
        requestedPath === "/api/ftp/browse" &&
        req.method === "GET"
    ) {
        const remotePath = url.searchParams.get("path") || "/fs";

        return browseWiiUDirectory(remotePath).then(result => {
            sendJSON(result, result.success ? 200 : 400);
        }).catch(error => {
            sendJSON({ success: false, error: error.message }, 503);
        });
    }

    /* GAME LIBRARY API */

    if (requestedPath === "/api/games" && req.method === "GET") {
        return sendJSON(getGames());
    }

    /* GAME DETAILS API */

    if (
        requestedPath === "/api/game-details" &&
        req.method === "GET"
    ) {
        const name = url.searchParams.get("name");
        const details = getGameDetails(name);

        if (!details) {
            return sendJSON({
                error: "Game not found",
                description: "",
                screenshots: []
            }, 404);
        }

        return sendJSON(details);
    }

    /* GAME DOWNLOAD INFO API */

    if (
        requestedPath === "/api/download-info" &&
        req.method === "GET"
    ) {
        const name = url.searchParams.get("name");
        const downloadInfo = getGameDownloadFiles(name);

        if (!downloadInfo) {
            return sendJSON({ error: "Game not found" }, 404);
        }

        if (downloadInfo.totalFiles === 0) {
            return sendJSON({
                error: "No WUP files found",
                name,
                files: []
            }, 404);
        }

        return sendJSON(downloadInfo);
    }

    /* ADD GAME TO DOWNLOAD QUEUE AND START TRANSFER */

    if (
        requestedPath === "/api/downloads" &&
        req.method === "POST"
    ) {
        return readJSONBody(data => {
            if (
                !data ||
                typeof data.name !== "string" ||
                !data.name.trim()
            ) {
                return sendJSON({ error: "Invalid game name" }, 400);
            }

            const item = addToDownloadQueue(data.name.trim());

            if (!item) {
                return sendJSON({
                    error: "Game not found or no WUP files available"
                }, 404);
            }

            // Start processing the queue automatically.
            if (!item.alreadyQueued) {
                processDownloadQueue();
            }

            return sendJSON({
                success: true,
                message: item.alreadyQueued
                    ? "Game is already in the download queue"
                    : "Game added. Wii U transfer starting.",
                download: item,
                alreadyQueued: !!item.alreadyQueued
            }, item.alreadyQueued ? 200 : 201);
        });
    }

    /* GET DOWNLOAD QUEUE */

    if (
        requestedPath === "/api/downloads" &&
        req.method === "GET"
    ) {
        return sendJSON({
            downloads: downloadQueue,
            totalDownloads: downloadQueue.length
        });
    }

    /* REMOVE DOWNLOAD FROM QUEUE */

    if (
        requestedPath.startsWith("/api/downloads/") &&
        req.method === "DELETE"
    ) {
        const id = requestedPath.substring(
            "/api/downloads/".length
        );

        if (!id || id.includes("/")) {
            return sendJSON({ error: "Invalid download ID" }, 400);
        }

        const removed = removeFromDownloadQueue(id);

        if (!removed) {
            return sendJSON({
                error: "Download not found, or transfer is currently active"
            }, 409);
        }

        return sendJSON({
            success: true,
            message: "Download removed from queue"
        });
    }

    /* HOME PAGE */

    if (requestedPath === "/") {
        requestedPath = "/index.html";
    }

    /* SERVE WEBSITE FILES */

    const filePath = path.resolve(
        ROOT,
        "." + requestedPath
    );

    if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, {
                "Content-Type": "text/plain"
            });
            return res.end("404 - File not found");
        }

        const ext = path.extname(filePath).toLowerCase();

        res.writeHead(200, {
            "Content-Type":
                mimeTypes[ext] || "application/octet-stream"
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
    console.log("GAME APIs");
    console.log("Game Library: /api/games");
    console.log("Game Details: /api/game-details");
    console.log("Download Info: /api/download-info");

    console.log("");
    console.log("DOWNLOAD APIs");
    console.log("GET    /api/downloads");
    console.log("POST   /api/downloads");
    console.log("DELETE /api/downloads/{id}");

    console.log("");
    console.log("WII U FTP");
    console.log("POST   /api/ftp/test");
    console.log("GET    /api/ftp/browse?path=/fs");
    console.log("Browser: http://localhost:" + PORT + "/ftp");
    console.log("FTP address: " + WIIU_IP + ":" + WIIU_FTP_PORT);
    console.log("Install folder: " + WIIU_INSTALL_PATH);

    console.log("");
    console.log("Automatic FTP download queue is ready.");
    console.log("==================================");
});
