# Shared DEX Screener client: one request at a time across threads (~2/s), with backoff on 429/5xx.
# GitHub runners share IPs, so DEX Screener's per-IP limit can trip even when this job is well under it.
import json, threading, time, urllib.request, urllib.error
_lock = threading.Lock(); _next = [0.0]
GAP = 0.5
def dsget(u, tries=8):
    last = None
    for k in range(tries):
        with _lock:
            w = _next[0] - time.time()
            if w > 0: time.sleep(w)
            _next[0] = time.time() + GAP
        try:
            r = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
            return json.load(urllib.request.urlopen(r, timeout=30))
        except urllib.error.HTTPError as e:
            last = e
            if e.code != 429 and e.code < 500: raise
            ra = e.headers.get('Retry-After') if e.headers else None
            wait = float(ra) if ra and ra.replace('.', '').isdigit() else min(60, 3 * 2 ** k)
            with _lock: _next[0] = max(_next[0], time.time() + wait)  # pause every thread, not just this one
        except Exception as e:
            last = e; time.sleep(2 * (k + 1))
    raise last
