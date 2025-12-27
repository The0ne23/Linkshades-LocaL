# LinkShades Local Server

Revive your orphaned LinkShade smart blinds with local control! No cloud required.


![Node](https://img.shields.io/badge/node-%3E%3D14-green.svg)

## 🎯 What is this?

LinkShades was a smart blinds company that shut down, leaving their devices unable to connect to the cloud. This project provides a local server that mimics the original cloud, allowing you to control your shades again!

## ✨ Features

- **100% Local Control** - No internet required after setup
- **Web Dashboard** - Control shades from any browser
- **REST API** - Integrate with your own apps
- **Home Assistant Integration** - MQTT auto-discovery support
- **Multi-shade Support** - Control multiple shades from one server

## 🚀 Quick Start

### Prerequisites

- Node.js 14+ 
- Your LinkShade device on the same network
- DNS/firewall redirect (see Network Setup)

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/linkshades-local.git
cd linkshades-local
npm install
npm start
```

### Network Setup

The shade tries to connect to `shade.linkshades.com:4000`. You need to redirect this to your server:

**Option 1: Router DNS Override**
Point `shade.linkshades.com` to your server's IP in your router's DNS settings.

**Option 2: Pi-hole / AdGuard**
Add a DNS rewrite rule for `shade.linkshades.com` → `YOUR_SERVER_IP`

**Option 3: Firewall DNAT (pfSense/OPNsense)**
```
# Redirect the original cloud IP to your server
Original IP: 142.93.88.116:4000 → YOUR_SERVER_IP:4000
```

### Verify Connection

1. Open `http://YOUR_SERVER_IP:4000` in a browser
2. Power cycle your shade
3. Watch the dashboard - shade should appear within 30 seconds

## 📡 API Reference

### List Shades
```bash
GET /api/shades
```

### Set Position (0-100%)
```bash
POST /api/shades/{chipID}/position
Content-Type: application/json

{"position": 50}
```

### Send Raw Command
```bash
POST /api/shades/{chipID}/command
Content-Type: application/json

{"command": 85}
```

### Health Check
```bash
GET /api/health
```

## 🏠 Home Assistant Integration

### Option 1: MQTT (Recommended)

Enable MQTT in the server:

```bash
MQTT_ENABLED=true MQTT_HOST=your-mqtt-broker npm start
```

Or set environment variables:
```bash
export MQTT_ENABLED=true
export MQTT_HOST=192.168.1.100
export MQTT_USER=homeassistant
export MQTT_PASS=your_password
npm start
```

The shade will auto-discover in Home Assistant!

### Option 2: REST API

Add to `configuration.yaml`:

```yaml
cover:
  - platform: rest
    name: "LinkShade Living Room"
    resource: http://YOUR_SERVER_IP:4000/api/shades/YOUR_CHIP_ID/position
    body_on: '{"position": 100}'
    body_off: '{"position": 0}'
    is_on_template: "{{ value_json.position > 50 }}"
    headers:
      Content-Type: application/json
```

### Option 3: RESTful Command

```yaml
rest_command:
  linkshade_set:
    url: "http://YOUR_SERVER_IP:4000/api/shades/{{ chip_id }}/position"
    method: POST
    content_type: "application/json"
    payload: '{"position": {{ position }}}'

cover:
  - platform: template
    covers:
      living_room_shade:
        friendly_name: "Living Room Shade"
        open_cover:
          service: rest_command.linkshade_set
          data:
            chip_id: "3398828"
            position: 100
        close_cover:
          service: rest_command.linkshade_set
          data:
            chip_id: "3398828"
            position: 0
        set_cover_position:
          service: rest_command.linkshade_set
          data:
            chip_id: "3398828"
            position: "{{ position }}"
```

## ⚙️ Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4000 | Server port |
| `MQTT_ENABLED` | false | Enable MQTT integration |
| `MQTT_HOST` | localhost | MQTT broker address |
| `MQTT_PORT` | 1883 | MQTT broker port |
| `MQTT_USER` | - | MQTT username |
| `MQTT_PASS` | - | MQTT password |
| `SHADE_MIN` | 73 | Command value for fully closed |
| `SHADE_MAX` | 100 | Command value for fully open |

## 🔧 Calibration

Each shade has a calibrated range. The defaults (73-100) work for most shades, but you may need to adjust:

1. Open the dashboard
2. Use the raw command test box
3. Find your shade's closed position (try 70, 73, 75)
4. Find your shade's open position (usually 100)
5. Set `SHADE_MIN` and `SHADE_MAX` accordingly

## 📋 Protocol Details

The shade communicates via WebSocket on port 4000.

**Shade → Server (Status)**
```json
{"chipID":3398828,"position":850,"firstLoad":false,"version":24,"model":"wired"}
```

**Server → Shade (Command)**
```json
{"chipID":3398828,"command":85}
```

Command values:
- `73` = Fully closed (calibrated minimum)
- `100` = Fully open
- Values below calibrated minimum are ignored
- Position = Command × 10 (roughly)

## 🐛 Troubleshooting

### Shade won't connect
- Verify DNS/firewall redirect is working: `nslookup shade.linkshades.com`
- Check shade is on same network/VLAN as server
- Power cycle the shade

### Shade connects but won't move
- Check the activity log for sent commands
- Verify command format: `{"chipID":YOUR_ID,"command":73-100}`
- Try different command values to find your calibration range

### Position doesn't update
- Shade only reports position on connect
- Power cycle shade to get fresh position

## 📄 License

GNU License - feel free to use, modify, and distribute!

## 🙏 Acknowledgments

- Original reverse engineering inspired by the Home Assistant community
- Thanks to everyone who refused to let their smart devices become e-waste!

## 🤝 Contributing

Contributions welcome! Please open an issue or PR.

---

**Note:** This project is not affiliated with LinkShades. It's a community effort to keep orphaned devices working.
