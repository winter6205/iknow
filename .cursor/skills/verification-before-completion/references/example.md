# Example

## PASS

This run followed `plans/place-order.md`. Acceptance: POST `/api/orders` → 201 + `order_id`; `pytest tests/test_orders.py` exit 0.

```text
basis = plans/place-order.md
P1 delivered  curl → 201 {"order_id":"ord_abc_1700000000"}
P2 delivered  pytest tests/test_orders.py -v → EXIT=0 (12 passed)
extras: none
PASS = basis plans/place-order.md; P2 pytest EXIT=0; P1 curl 201 + order_id
```

## FAIL

Same plan also requires 库存不足 → 409. Agent ran `pytest tests/test_health.py` (EXIT=0).

```text
P1 delivered; P2 missing; P3 missing; extra: test_health.py
not done — close P2/P3, or narrow to P1 and name P2/P3 open
```

## No file

User: `GET /health 返回 200 且 body 含 status=ok`

```text
basis = session ask (that sentence)
PASS = basis session-ask "GET /health 返回 200 且 body 含 status=ok"; curl → 200 {"status":"ok"}
```
