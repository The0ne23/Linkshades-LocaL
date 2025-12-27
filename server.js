/**
 * LinkShades Local Server
 * 
 * Revive your orphaned LinkShade smart blinds with local control!
 * No cloud required - works completely offline.
 * 
 * Features:
 * - WebSocket server for shade communication
 * - REST API for integration
 * - Home Assistant MQTT discovery (auto-detects shades!)
 * - Web dashboard for manual control
 * 
 * Command format discovered: {"chipID":<id>,"command":73-100}
 * - 73 = Fully closed
 * - 100 = Fully open
 * 
 * GitHub: https://github.com/YOUR_USERNAME/linkshades-local
 * License: MIT
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// =============================================================================
// CONFIGURATION - Edit these values for your setup
// =============================================================================
const CONFIG = {
    // Server settings
    PORT: process.env.PORT || 4000,
    
    // MQTT settings for Home Assistant (optional)
    MQTT_ENABLED: process.env.MQTT_ENABLED === 'true' || false,
    MQTT_HOST: process.env.MQTT_HOST || 'localhost',
    MQTT_PORT: process.env.MQTT_PORT || 1883,
    MQTT_USER: process.env.MQTT_USER || '',
    MQTT_PASS: process.env.MQTT_PASS || '',
    MQTT_TOPIC_PREFIX: process.env.MQTT_TOPIC_PREFIX || 'linkshades',
    
    // Shade calibration - adjust these for your shade
    // These values represent the command range (not position)
    SHADE_MIN: parseInt(process.env.SHADE_MIN) || 73,  // Command value for fully closed
    SHADE_MAX: parseInt(process.env.SHADE_MAX) || 100, // Command value for fully open
    
    // Data storage
    DATA_FILE: './shades_data.json'
};

// =============================================================================
// MQTT CLIENT (optional - for Home Assistant)
// =============================================================================
let mqttClient = null;

async function setupMQTT() {
    if (!CONFIG.MQTT_ENABLED) {
        console.log('[MQTT] Disabled - set MQTT_ENABLED=true to enable');
        return;
    }
    
    try {
        const mqtt = require('mqtt');
        
        const options = {
            host: CONFIG.MQTT_HOST,
            port: CONFIG.MQTT_PORT,
            username: CONFIG.MQTT_USER || undefined,
            password: CONFIG.MQTT_PASS || undefined
        };
        
        mqttClient = mqtt.connect(options);
        
        mqttClient.on('connect', () => {
            console.log(`[MQTT] Connected to ${CONFIG.MQTT_HOST}:${CONFIG.MQTT_PORT}`);
            
            // Subscribe to command topics
            mqttClient.subscribe(`${CONFIG.MQTT_TOPIC_PREFIX}/+/set`, (err) => {
                if (!err) console.log('[MQTT] Subscribed to command topics');
            });
        });
        
        mqttClient.on('message', (topic, message) => {
            // Handle commands from Home Assistant
            // Topic format: linkshades/{chipID}/set
            const match = topic.match(/linkshades\/(\d+)\/set/);
            if (match) {
                const chipID = match[1];
                const position = parseInt(message.toString());
                console.log(`[MQTT] Command received: shade ${chipID} -> ${position}%`);
                
                // Convert 0-100% to command value
                const command = percentToCommand(position);
                const ws = connectedShades.get(chipID);
                if (ws) {
                    sendToShade(ws, { chipID: parseInt(chipID), command: command });
                }
            }
        });
        
        mqttClient.on('error', (err) => {
            console.log(`[MQTT] Error: ${err.message}`);
        });
        
    } catch (err) {
        console.log('[MQTT] mqtt package not installed. Run: npm install mqtt');
    }
}

function publishShadeDiscovery(chipID, shade) {
    if (!mqttClient || !mqttClient.connected) return;
    
    // Home Assistant MQTT Discovery
    const discoveryTopic = `homeassistant/cover/linkshade_${chipID}/config`;
    const config = {
        name: shade.name || `LinkShade ${chipID}`,
        unique_id: `linkshade_${chipID}`,
        device_class: 'shade',
        command_topic: `${CONFIG.MQTT_TOPIC_PREFIX}/${chipID}/set`,
        position_topic: `${CONFIG.MQTT_TOPIC_PREFIX}/${chipID}/position`,
        set_position_topic: `${CONFIG.MQTT_TOPIC_PREFIX}/${chipID}/set`,
        availability_topic: `${CONFIG.MQTT_TOPIC_PREFIX}/${chipID}/available`,
        position_open: 100,
        position_closed: 0,
        payload_available: 'online',
        payload_not_available: 'offline',
        device: {
            identifiers: [`linkshade_${chipID}`],
            name: shade.name || `LinkShade ${chipID}`,
            model: shade.model || 'LinkShade',
            sw_version: shade.firmware ? `v${shade.firmware}` : 'unknown',
            manufacturer: 'LinkShades (Local)'
        }
    };
    
    mqttClient.publish(discoveryTopic, JSON.stringify(config), { retain: true });
    console.log(`[MQTT] Published discovery for shade ${chipID}`);
}

function publishShadeState(chipID, position, online) {
    if (!mqttClient || !mqttClient.connected) return;
    
    // Convert raw position (0-1000) to percentage (0-100)
    const percent = Math.round(position / 10);
    
    // Publish position
    mqttClient.publish(
        `${CONFIG.MQTT_TOPIC_PREFIX}/${chipID}/position`,
        String(percent),
        { retain: true }
    );
    
    // Publish availability
    mqttClient.publish(
        `${CONFIG.MQTT_TOPIC_PREFIX}/${chipID}/available`,
        online ? 'online' : 'offline',
        { retain: true }
    );
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

// Convert user percentage (0-100) to shade command (SHADE_MIN-SHADE_MAX)
function percentToCommand(percent) {
    const range = CONFIG.SHADE_MAX - CONFIG.SHADE_MIN;
    return Math.round(CONFIG.SHADE_MIN + (percent * range / 100));
}

// Convert shade command to user percentage
function commandToPercent(command) {
    const range = CONFIG.SHADE_MAX - CONFIG.SHADE_MIN;
    return Math.round((command - CONFIG.SHADE_MIN) * 100 / range);
}

// Convert raw position (0-1000) to percentage (0-100)
function positionToPercent(position) {
    return Math.round(position / 10);
}

// =============================================================================
// DATA STORAGE
// =============================================================================
let shadesDB = { shades: {} };

function loadData() {
    try {
        if (fs.existsSync(CONFIG.DATA_FILE)) {
            shadesDB = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
            console.log(`[DB] Loaded ${Object.keys(shadesDB.shades).length} shade(s)`);
        }
    } catch (err) {
        console.log('[DB] Starting with fresh database');
    }
}

function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(shadesDB, null, 2));
    } catch (err) {
        console.log(`[DB] Error saving: ${err.message}`);
    }
}

loadData();

// =============================================================================
// WEBSOCKET SERVER
// =============================================================================
const connectedShades = new Map();
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseWebSocketFrame(buffer) {
    if (buffer.length < 2) return null;
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0F;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
        if (buffer.length < 4) return null;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        if (buffer.length < 10) return null;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    let maskKey = null;
    if (masked) {
        if (buffer.length < offset + 4) return null;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
    }

    if (buffer.length < offset + payloadLength) return null;

    let payload = buffer.slice(offset, offset + payloadLength);
    if (masked && maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
        }
    }

    return { opcode, payload, totalLength: offset + payloadLength };
}

function sendWebSocketFrame(socket, data, opcode = 0x1) {
    if (socket.destroyed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    let frame;

    if (payload.length < 126) {
        frame = Buffer.alloc(2 + payload.length);
        frame[0] = 0x80 | opcode;
        frame[1] = payload.length;
        payload.copy(frame, 2);
    } else if (payload.length < 65536) {
        frame = Buffer.alloc(4 + payload.length);
        frame[0] = 0x80 | opcode;
        frame[1] = 126;
        frame.writeUInt16BE(payload.length, 2);
        payload.copy(frame, 4);
    } else {
        frame = Buffer.alloc(10 + payload.length);
        frame[0] = 0x80 | opcode;
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(payload.length), 2);
        payload.copy(frame, 10);
    }

    socket.write(frame);
}

function sendToShade(socket, data) {
    const json = JSON.stringify(data);
    console.log(`[WS] >>> ${json}`);
    sendWebSocketFrame(socket, json);
}

// =============================================================================
// HTTP SERVER & API
// =============================================================================
const server = http.createServer((req, res) => {
    const url = req.url;
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Health check
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            connectedShades: connectedShades.size,
            totalShades: Object.keys(shadesDB.shades).length,
            mqtt: mqttClient?.connected || false
        }));
        return;
    }

    // List all shades
    if (url === '/api/shades') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const shades = Object.values(shadesDB.shades).map(s => ({
            ...s,
            online: connectedShades.has(s.chipID)
        }));
        res.end(JSON.stringify(shades));
        return;
    }

    // Set position (percentage)
    if (url.match(/^\/api\/shades\/(\d+)\/position$/) && req.method === 'POST') {
        const chipID = url.match(/^\/api\/shades\/(\d+)\/position$/)[1];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { position } = JSON.parse(body);
                const command = percentToCommand(position);
                console.log(`[API] Shade ${chipID}: ${position}% -> command ${command}`);

                const ws = connectedShades.get(chipID);
                if (ws) {
                    sendToShade(ws, { chipID: parseInt(chipID), command: command });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'sent', chipID, position, command }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'offline', chipID }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Send raw command
    if (url.match(/^\/api\/shades\/(\d+)\/command$/) && req.method === 'POST') {
        const chipID = url.match(/^\/api\/shades\/(\d+)\/command$/)[1];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { command } = JSON.parse(body);
                console.log(`[API] Shade ${chipID}: raw command ${command}`);

                const ws = connectedShades.get(chipID);
                if (ws) {
                    sendToShade(ws, { chipID: parseInt(chipID), command: command });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'sent', chipID, command }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'offline', chipID }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Test endpoint (any JSON)
    if (url.match(/^\/api\/shades\/(\d+)\/test$/) && req.method === 'POST') {
        const chipID = url.match(/^\/api\/shades\/(\d+)\/test$/)[1];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const ws = connectedShades.get(chipID);
                if (ws) {
                    sendToShade(ws, data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'sent', data }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'offline' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Dashboard
    if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getDashboardHTML());
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
    console.log(`[WS] Connection from ${socket.remoteAddress}`);

    const key = req.headers['sec-websocket-key'];
    const protocol = req.headers['sec-websocket-protocol'];

    if (!key) {
        socket.destroy();
        return;
    }

    const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

    const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`
    ];
    if (protocol) responseHeaders.push(`Sec-WebSocket-Protocol: ${protocol}`);

    socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

    let shadeChipID = null;
    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);

        while (buffer.length >= 2) {
            const frame = parseWebSocketFrame(buffer);
            if (!frame) break;

            buffer = buffer.slice(frame.totalLength);

            if (frame.opcode === 0x8) {
                socket.end();
                return;
            }
            if (frame.opcode === 0x9) {
                sendWebSocketFrame(socket, frame.payload, 0xA);
                continue;
            }
            if (frame.opcode === 0xA) continue;

            if (frame.opcode === 0x1 || frame.opcode === 0x2) {
                const message = frame.payload.toString('utf8');
                console.log(`[WS] <<< ${message}`);

                try {
                    const data = JSON.parse(message);
                    
                    if (data.chipID) {
                        const chipID = String(data.chipID);
                        shadeChipID = chipID;
                        connectedShades.set(chipID, socket);

                        // Update database
                        if (!shadesDB.shades[chipID]) {
                            shadesDB.shades[chipID] = {
                                chipID: chipID,
                                name: `LinkShade ${chipID}`,
                                firstSeen: new Date().toISOString()
                            };
                        }
                        
                        const shade = shadesDB.shades[chipID];
                        shade.lastSeen = new Date().toISOString();
                        shade.online = true;
                        shade.model = data.model;
                        shade.firmware = data.version;
                        shade.rawPosition = data.position;
                        shade.currentPosition = positionToPercent(data.position);
                        saveData();

                        console.log(`[SHADE] ${chipID}: pos=${data.position} (${shade.currentPosition}%), model=${data.model}, fw=${data.version}`);

                        // Publish to MQTT
                        publishShadeDiscovery(chipID, shade);
                        publishShadeState(chipID, data.position, true);
                    }
                } catch (e) {
                    console.log(`[WS] Parse error: ${e.message}`);
                }
            }
        }
    });

    socket.on('close', () => {
        console.log(`[WS] Disconnected: ${shadeChipID || 'unknown'}`);
        if (shadeChipID) {
            connectedShades.delete(shadeChipID);
            if (shadesDB.shades[shadeChipID]) {
                shadesDB.shades[shadeChipID].online = false;
                saveData();
            }
            publishShadeState(shadeChipID, 0, false);
        }
    });

    socket.on('error', (err) => console.log(`[WS] Error: ${err.message}`));
});

// =============================================================================
// WEB DASHBOARD
// =============================================================================
function getDashboardHTML() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>LinkShades Local Control</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta charset="UTF-8">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; min-height: 100vh; }
        .container { max-width: 500px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; font-size: 1.5em; }
        .card { background: #16213e; padding: 20px; border-radius: 12px; margin-bottom: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .status-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .online { color: #4ade80; }
        .offline { color: #f87171; }
        .shade-name { font-size: 1.2em; font-weight: 600; }
        .shade-info { font-size: 0.85em; opacity: 0.7; margin: 5px 0; }
        .position-display { font-size: 3.5em; text-align: center; margin: 20px 0; font-weight: 300; }
        .slider { width: 100%; height: 8px; border-radius: 4px; background: #334155; -webkit-appearance: none; margin: 20px 0; }
        .slider::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; background: #3b82f6; border-radius: 50%; cursor: pointer; }
        .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 15px 0; }
        .btn { padding: 16px; border: none; border-radius: 8px; background: #3b82f6; color: white; cursor: pointer; font-size: 16px; font-weight: 500; transition: all 0.2s; }
        .btn:hover { background: #2563eb; transform: translateY(-1px); }
        .btn:active { transform: translateY(0); }
        .btn-close { background: #6366f1; }
        .btn-close:hover { background: #4f46e5; }
        .btn-open { background: #22c55e; }
        .btn-open:hover { background: #16a34a; }
        .preset-buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .preset-buttons .btn { padding: 12px 8px; font-size: 14px; background: #334155; }
        .preset-buttons .btn:hover { background: #475569; }
        .log { background: #0f172a; padding: 12px; border-radius: 8px; font-size: 11px; max-height: 150px; overflow-y: auto; font-family: monospace; margin-top: 15px; }
        .section-title { font-size: 0.9em; font-weight: 600; margin-bottom: 10px; opacity: 0.8; }
        .test-input { width: 100%; padding: 10px; border: 1px solid #334155; border-radius: 6px; background: #0f172a; color: #eee; font-family: monospace; font-size: 12px; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏠 LinkShades Control</h1>
        
        <div class="card">
            <div class="status-row">
                <span>Server</span>
                <span class="online">● Online</span>
            </div>
            <div class="status-row">
                <span>MQTT</span>
                <span id="mqttStatus">Checking...</span>
            </div>
        </div>
        
        <div id="shades">
            <div class="card">
                <p style="text-align:center;opacity:0.6">Waiting for shade to connect...</p>
            </div>
        </div>
        
        <div class="card">
            <div class="section-title">🔧 Raw Command</div>
            <input type="text" class="test-input" id="testCmd" value='{"chipID":3398828,"command":100}'>
            <button class="btn" onclick="sendTest()" style="width:100%">Send Command</button>
            <div class="log" id="log"></div>
        </div>
    </div>
    
    <script>
        let CHIP = null;
        
        function log(msg) {
            const el = document.getElementById('log');
            const time = new Date().toLocaleTimeString();
            el.innerHTML = time + ': ' + msg + '\\n' + el.innerHTML;
            if (el.innerHTML.length > 5000) el.innerHTML = el.innerHTML.substring(0, 5000);
        }
        
        async function sendTest() {
            const cmd = document.getElementById('testCmd').value;
            log('>>> ' + cmd);
            try {
                const chipID = CHIP || '3398828';
                const r = await fetch('/api/shades/' + chipID + '/test', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: cmd
                });
                const d = await r.json();
                log('Sent: ' + JSON.stringify(d.data || d));
            } catch(e) {
                log('Error: ' + e.message);
            }
        }
        
        async function loadShades() {
            try {
                const health = await fetch('/api/health').then(r => r.json());
                document.getElementById('mqttStatus').innerHTML = health.mqtt 
                    ? '<span class="online">● Connected</span>' 
                    : '<span class="offline">● Disabled</span>';
                
                const shades = await fetch('/api/shades').then(r => r.json());
                
                if (shades.length === 0) {
                    document.getElementById('shades').innerHTML = '<div class="card"><p style="text-align:center;opacity:0.6">Waiting for shade to connect...</p></div>';
                    return;
                }
                
                let html = '';
                for (const s of shades) {
                    CHIP = s.chipID;
                    html += \`
                        <div class="card">
                            <div class="status-row">
                                <span class="shade-name">\${s.name || 'LinkShade'}</span>
                                <span class="\${s.online ? 'online' : 'offline'}">● \${s.online ? 'Online' : 'Offline'}</span>
                            </div>
                            <div class="shade-info">ID: \${s.chipID} | Model: \${s.model || '?'} | FW: \${s.firmware || '?'}</div>
                            <div class="shade-info">Raw position: \${s.rawPosition || '?'}</div>
                            
                            <div class="position-display">\${s.currentPosition || 0}%</div>
                            
                            <input type="range" class="slider" min="0" max="100" value="\${s.currentPosition || 0}"
                                   onchange="setPosition('\${s.chipID}', this.value)">
                            
                            <div class="buttons">
                                <button class="btn btn-close" onclick="sendCmd('\${s.chipID}', 73)">⬇️ Close</button>
                                <button class="btn btn-open" onclick="sendCmd('\${s.chipID}', 100)">⬆️ Open</button>
                            </div>
                            
                            <div class="section-title">Presets</div>
                            <div class="preset-buttons">
                                <button class="btn" onclick="sendCmd('\${s.chipID}', 80)">25%</button>
                                <button class="btn" onclick="sendCmd('\${s.chipID}', 85)">50%</button>
                                <button class="btn" onclick="sendCmd('\${s.chipID}', 90)">75%</button>
                                <button class="btn" onclick="sendCmd('\${s.chipID}', 95)">90%</button>
                            </div>
                        </div>
                    \`;
                }
                document.getElementById('shades').innerHTML = html;
            } catch(e) {
                log('Error: ' + e.message);
            }
        }
        
        async function sendCmd(chipID, command) {
            log('>>> command: ' + command);
            try {
                await fetch('/api/shades/' + chipID + '/command', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ command })
                });
                setTimeout(loadShades, 1500);
            } catch(e) {
                log('Error: ' + e.message);
            }
        }
        
        async function setPosition(chipID, percent) {
            log('>>> position: ' + percent + '%');
            try {
                await fetch('/api/shades/' + chipID + '/position', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ position: parseInt(percent) })
                });
                setTimeout(loadShades, 1500);
            } catch(e) {
                log('Error: ' + e.message);
            }
        }
        
        loadShades();
        setInterval(loadShades, 3000);
    </script>
</body>
</html>`;
}

// =============================================================================
// START SERVER
// =============================================================================
server.listen(CONFIG.PORT, '0.0.0.0', async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         LinkShades Local Server - Running!                ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Dashboard:  http://localhost:${CONFIG.PORT}                        ║`);
    console.log(`║  API:        http://localhost:${CONFIG.PORT}/api/shades             ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  Shade Range: ${CONFIG.SHADE_MIN} (closed) to ${CONFIG.SHADE_MAX} (open)              ║`);
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log('║  Commands:                                                ║');
    console.log('║    {"chipID":ID,"command":73-100}                         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    await setupMQTT();
});
