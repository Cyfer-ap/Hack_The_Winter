import numpy as np

def sigmoid(x):
    return 1 / (1 + np.exp(-x))

def compute_risk(susceptibility, trigger):
    """
    susceptibility: (N,) float [0..1]
    trigger:         (N,) float [0..1]
    returns risk:    (N,) float [0..1]
    """
    a, b = 2.0, 3.5
    risk = sigmoid(a * susceptibility + b * trigger - 2.5)
    return risk

def top_hotspots(risk, k=10):
    idx = np.argsort(-risk)[:k]
    return idx, risk[idx]
