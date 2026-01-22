#%%
import socket
import json
import os
from datetime import datetime

HOST = "0.0.0.0"
PORT = 5000

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # D:\Hackathon
JSON_FILE = os.path.join(BASE_DIR, "ui", "sensor_data.json")            # ✅ write into ui/


server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind((HOST, PORT))

def load_json_data():
    if not os.path.exists(JSON_FILE):
        return []

    try:
        with open(JSON_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []

def save_json_data(data_list):
    """Windows-safe write (no os.replace)."""
    with open(JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(data_list, f, indent=4)
        f.flush()
        os.fsync(f.fileno())

print(f"✅ UDP Server listening on {HOST}:{PORT}")

while True:
    data, addr = server.recvfrom(4096)
    msg = data.decode(errors="ignore").strip()

    try:
        sensor_packet = json.loads(msg)
    except json.JSONDecodeError:
        print(f"❌ Invalid JSON from {addr}: {msg}")
        continue

    if "zone_id" not in sensor_packet:
        print(f"❌ Missing zone_id from {addr}: {sensor_packet}")
        continue

    # Add optional metadata
    sensor_packet["last_updated"] = datetime.now().isoformat()
    sensor_packet["sender_ip"] = addr[0]

    zone_id = sensor_packet["zone_id"]

    existing_data = load_json_data()

    updated = False
    for i, row in enumerate(existing_data):
        if isinstance(row, dict) and row.get("zone_id") == zone_id:
            existing_data[i] = sensor_packet
            updated = True
            break

    if not updated:
        existing_data.append(sensor_packet)

    save_json_data(existing_data)

    print(f"✅ Stored zone_id={zone_id} | Updated={updated} | From={addr}")
