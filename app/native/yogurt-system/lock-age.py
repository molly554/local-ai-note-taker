"""Fails when Cargo.lock has a crate version published less than 14 days ago, or one that was yanked.
Usage: python3 lock-age.py Cargo.lock"""
import datetime, json, sys, time, tomllib, urllib.request

lock = tomllib.load(open(sys.argv[1], "rb"))
now = datetime.datetime.now(datetime.timezone.utc)
bad = []
for p in lock["package"]:
    if not p.get("source", "").startswith("registry+"):
        continue
    url = f"https://crates.io/api/v1/crates/{p['name']}/{p['version']}"
    req = urllib.request.Request(url, headers={"User-Agent": "yogurt-ci (github.com/FrigadeHQ/yogurt)"})
    v = json.load(urllib.request.urlopen(req))["version"]
    made = datetime.datetime.fromisoformat(v["created_at"].replace("Z", "+00:00"))
    days = (now - made).days
    print(f"{p['name']} {p['version']}: {days} days{' YANKED' if v['yanked'] else ''}")
    if days < 14 or v["yanked"]:
        bad.append(f"{p['name']} {p['version']}")
    time.sleep(1)  # crates.io asks for one request a second
if bad:
    sys.exit("too new or yanked: " + ", ".join(bad))
