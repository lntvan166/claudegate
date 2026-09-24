#!/usr/bin/env python3
"""Give the demo fixture something worth looking at, deterministically.

Two problems with the raw fixture, both specific to filming it:

1. manual-test-seed.py --demo builds files of five to eleven lines. Right for the
   manual checklist, where the point is that capture works at all; a three-line
   diff on a 1440px screen reads as an empty screenshot.

2. "Next Pending File" walks orderedPendingPaths(primary) — the PRIMARY session
   only, sorted by full path. So which file the demo opens is decided by
   alphabetical order within that one session, and the raw fixture opens
   CONTRIBUTING.md. Pressing Next repeatedly to reach a better file would be a
   coin flip every time the fixture changes.

So: replace the primary session's pending set with exactly two files we author,
named so the substantial one sorts first. The worktree sessions are left alone —
the worktree groups in the tree are a differentiator worth filming.

Kept out of manual-test-seed.py on purpose: the manual checklist and the
integration suite both depend on that fixture's current shape.
"""
import json
import os
import sys

home = sys.argv[1]
ws = os.path.join(home, "claudegate-demo")
sessions = os.path.join(home, ".claudegate", "sessions")

# Sorted by full path, "service-api/..." precedes "service-core/...", so the
# richer diff is what Next Pending File opens first.
FILES = {
    os.path.join(ws, "service-api", "handlers", "checkout.go"): (
'''package handlers

import (
	"encoding/json"
	"net/http"
)

// Checkout turns a cart into an order.
func Checkout(w http.ResponseWriter, r *http.Request) {
	var cart Cart
	if err := json.NewDecoder(r.Body).Decode(&cart); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	total := 0
	for _, item := range cart.Items {
		total += item.Price * item.Quantity
	}

	order, err := orders.Create(r.Context(), cart.CustomerID, total)
	if err != nil {
		http.Error(w, "could not create order", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(order)
}
''',
'''package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
)

// Checkout turns a cart into an order.
func Checkout(w http.ResponseWriter, r *http.Request) {
	var cart Cart
	if err := json.NewDecoder(r.Body).Decode(&cart); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if len(cart.Items) == 0 {
		http.Error(w, "cart is empty", http.StatusBadRequest)
		return
	}

	total, err := price(r.Context(), cart)
	if err != nil {
		http.Error(w, "could not price the cart", http.StatusBadGateway)
		return
	}

	order, err := orders.Create(r.Context(), cart.CustomerID, total)
	if err != nil {
		if errors.Is(err, orders.ErrDuplicate) {
			http.Error(w, "order already placed", http.StatusConflict)
			return
		}
		http.Error(w, "could not create order", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(order)
}
'''),
    os.path.join(ws, "service-core", "pricing", "discount.go"): (
'''package pricing

// Apply reduces a line total by any discount the customer qualifies for.
func Apply(total int, c Customer) int {
	if c.Tier == TierGold {
		return total * 90 / 100
	}
	return total
}
''',
'''package pricing

// Apply reduces a line total by any discount the customer qualifies for.
// Discounts never stack, and never take a line below zero.
func Apply(total int, c Customer) int {
	discount := 0
	switch c.Tier {
	case TierGold:
		discount = 10
	case TierSilver:
		discount = 5
	}

	if c.FirstOrder && discount < 15 {
		discount = 15
	}

	reduced := total * (100 - discount) / 100
	if reduced < 0 {
		return 0
	}
	return reduced
}
'''),
}


def is_primary(data):
    """The primary session owns root-level files; a worktree session's paths all
    sit under its own ws-* directory."""
    return any(
        os.path.dirname(p).rstrip(os.sep) == ws.rstrip(os.sep)
        for p in (data.get("files") or {})
    )


primary = None
for name in sorted(os.listdir(sessions)):
    if not name.endswith(".json"):
        continue
    path = os.path.join(sessions, name)
    with open(path) as fh:
        data = json.load(fh)
    if is_primary(data):
        primary = (path, data)
        break

if primary is None:
    print("enrich: no primary session found", file=sys.stderr)
    sys.exit(1)

path, data = primary
captured = next(iter((data.get("files") or {}).values()), {}).get(
    "capturedAt", "2026-09-24T09:00:00.000000+00:00"
)
session_id = data.get("sessionId", "demo")

files = {}
for file_path, (before, after) in FILES.items():
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    # Claude's version is what is on disk; the frozen baseline is what it replaced.
    with open(file_path, "w") as fh:
        fh.write(after)
    files[file_path] = {
        "originalContent": before,
        "reviewStatus": "pending",
        "sessionId": session_id,
        "capturedAt": captured,
    }

data["files"] = files
with open(path, "w") as fh:
    json.dump(data, fh)

print(f"enrich: primary session now has {len(files)} pending file(s)")
