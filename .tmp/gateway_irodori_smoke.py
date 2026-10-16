import json, urllib.request
def get(path):
    with urllib.request.urlopen("http://127.0.0.1:8787" + path, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))
def post(path, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:8787" + path, data=data, method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode("utf-8"))
print("health  ->", get("/api/irodori/health")["ok"], get("/api/irodori/health")["weights"]["training_ready"])
print("svc     ->", get("/api/irodori/service"))
print("datasets->", get("/api/irodori/v1/train/datasets"))
print("speakers->", get("/api/irodori/v1/speakers")["count"])
plan = post("/api/irodori/v1/train/plan", {"dataset_id": "smoke30-6"})
print("plan    ->", plan.get("ok"), [ (s["key"], s["state"]) for s in plan.get("steps", []) ], "ready=", plan.get("ready_to_prepare"))
ab = post("/api/irodori/v1/train/auto_batch", {"probe": False})
print("batch   ->", ab.get("batch"))
