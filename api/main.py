from fastapi import FastAPI
import numpy as np
from engine.risk_engine import compute_risk, top_hotspots

app = FastAPI()

# dummy in-memory state (replace with saved arrays later)
N = 50000  # approx cells for 500 km^2 at 100m x 100m
susceptibility = np.random.rand(N).astype("float32")
trigger = np.zeros(N, dtype="float32")
risk = np.zeros(N, dtype="float32")

@app.get("/health")
def health():
    return {"status": "ok", "cells": int(N)}

@app.post("/update_trigger")
def update_trigger():
    global trigger, risk
    # demo: random trigger update (replace with IMERG derived trigger)
    trigger = np.random.rand(N).astype("float32")
    risk = compute_risk(susceptibility, trigger).astype("float32")
    return {"updated": True}

@app.get("/hotspots")
def hotspots():
    idx, scores = top_hotspots(risk, k=10)
    return [{"cell_id": int(i), "risk": float(s)} for i, s in zip(idx, scores)]
