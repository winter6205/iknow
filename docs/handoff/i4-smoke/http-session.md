# I4 smoke: Session HTTP API + static web

- **Suite**: i4-smoke / http-session
- **Base**: http://127.0.0.1:8791
- **Mode**: deterministic
- **pass**: `true`
- **exit**: 0
- **duration_ms**: 399

## Steps

| Step | Status | Notes |
|------|--------|-------|
| GET /api/v1/health | 200 | ok=True |
| POST /api/v1/sessions | 201 | conversation_id present: True |
| POST .../messages (turn1) | 200 | has_snapshot_id: True |
| POST .../messages (turn2) | 200 | has_snapshot_id: True |
| POST .../commands status | 200 | |
| POST .../reset | 200 | |
| GET / (static) | 200 | html contains root/iknow: True |
| GET .../events | 501 | expect 501 confirmed: True |

## Criteria

- has_snapshot_id both turns: turn1=`True` turn2=`True`
- 501 on events: `True`
- overall pass: `true`

## Result

**PASS**
