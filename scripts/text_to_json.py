# receiver.py
import serial
import json

PORT = "COM3"       # change this
BAUD = 9600

ser = serial.Serial(PORT, BAUD, timeout=1)
print("✅ Receiver listening...")

while True:
    line = ser.readline().decode("utf-8").strip()
    if not line:
        continue
    try:
        data = json.loads(line)
        print("📥 Received JSON:", data)
    except Exception as e:
        print("⚠️ Invalid JSON:", line)
