def build_sms(area_name: str, risk_score: float):
    msg = f"ALERT: Landslide risk HIGH ({risk_score:.2f}) in {area_name} next 6h. Evacuate to safe shelter. Helpline 112."
    return msg[:160]  # hard cut to 160 chars
