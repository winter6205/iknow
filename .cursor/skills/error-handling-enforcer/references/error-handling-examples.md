# Error Handling — Worked Examples

Reference companion to `SKILL.md`. Contains full code samples demonstrating typed exception + Result + `// EXIT:` patterns. SKILL.md holds routing + canonical rules; this file holds the heavy example.

---

## Example 1 — Typed exception + Result<T, E> + // EXIT: comments

One complete I/O + parse + validate function written without `null` / `-1` / empty catch / silent log.

```python
# Function: load_config(path: str) -> Result[Config, ConfigError]

from dataclasses import dataclass

@dataclass
class ConfigError:
    code: str  # "FILE_NOT_FOUND" | "INVALID_JSON" | "PERMISSION_DENIED" | "MISSING_REQUIRED_FIELD"
    message: str
    path: str | None = None

class ConfigLoadError(Exception):
    def __init__(self, code: str, message: str, path: str | None = None):
        self.code = code
        self.message = message
        self.path = path
        super().__init__(f"[{code}] {message}" + (f" (path={path})" if path else ""))

def load_config(path: str) -> Result[Config, ConfigError]:
    try:
        with open(path) as f:
            raw = f.read()
    except FileNotFoundError:
        # EXIT: file not found, caller decides fallback vs re-raise
        return Err(ConfigError(code="FILE_NOT_FOUND", message="config file not found", path=path))
    except PermissionError:
        # EXIT: permission denied, caller logs + alerts admin
        return Err(ConfigError(code="PERMISSION_DENIED", message="cannot read config file", path=path))
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        # EXIT: invalid JSON, caller shows error with line/column
        return Err(ConfigError(code="INVALID_JSON", message=f"JSON parse error: {e.msg} at line {e.lineno}", path=path))
    required = ["host", "port", "db_name"]
    missing = [k for k in required if k not in data]
    if missing:
        # EXIT: missing required field, caller fills defaults or re-raises
        return Err(ConfigError(code="MISSING_REQUIRED_FIELD", message=f"missing required fields: {missing}", path=path))
    return Ok(Config.from_dict(data))

# Caller (never return null + never empty catch)
match load_config("/etc/myapp/config.json"):
    case Ok(config):
        db = connect_db(config)
    case Err(e) if e.code == "FILE_NOT_FOUND":
        if env.is_dev():
            db = connect_db(Config.default())
        else:
            raise ConfigLoadError(e.code, e.message, e.path)
    case Err(e):
        raise ConfigLoadError(e.code, e.message, e.path)
```

Notes:

- One typed exception **per failure mode** (4 codes, not 1 god-class).
- `Result<T, E>` makes failure mode explicit at the type level — caller cannot forget to handle.
- `// EXIT:` comment on every early-return names the caller decision boundary.
- Caller never returns `null`, never has an empty catch.
- Any I/O + parse + validate function follows this same pattern.

---

## Example 2 — Converting an existing `try/except` + `return None` shape

Before (violates baseline):

```python
def fetch_user(user_id: int):
    try:
        r = httpx.get(f"/users/{user_id}", timeout=5)
        return r.json()
    except Exception:
        return None
```

After (compliant):

```python
class UserFetchError(Exception):
    def __init__(self, code: str, message: str, user_id: int):
        self.code = code
        self.message = message
        self.user_id = user_id
        super().__init__(f"[{code}] {message} (user_id={user_id})")

def fetch_user(user_id: int) -> User:
    try:
        r = httpx.get(f"/users/{user_id}", timeout=5)
    except httpx.TimeoutException:
        # EXIT: timeout, caller decides retry vs surface 504
        raise UserFetchError("TIMEOUT", "user fetch exceeded 5s", user_id)
    except httpx.HTTPError as e:
        # EXIT: network/HTTP error, caller logs and returns 502
        raise UserFetchError("NETWORK", f"transport error: {e}", user_id)
    if r.status_code == 404:
        # EXIT: not found, caller returns 404 to API consumer
        raise UserFetchError("NOT_FOUND", f"user {user_id} does not exist", user_id)
    if r.status_code >= 500:
        # EXIT: upstream 5xx, caller retries with backoff
        raise UserFetchError("UPSTREAM", f"upstream returned {r.status_code}", user_id)
    try:
        data = r.json()
    except ValueError as e:
        # EXIT: malformed JSON, caller logs payload + alerts
        raise UserFetchError("INVALID_JSON", f"JSON parse error: {e}", user_id)
    return User.from_dict(data)
```

Notes:

- One typed exception class, multiple `code` discriminators.
- Each `raise` carries `// EXIT:` so the caller's decision is documented.
- `return None` replaced with `raise UserFetchError(...)` — failure is no longer indistinguishable from "no result".

---

## Example 3 — Fallback branch with `// EXIT:`

Before (violates baseline — fallback without exit criteria):

```python
def get_config():
    try:
        return load_from_disk()
    except Exception:
        if cached_config:
            return cached_config   # just-in-case fallback, never exits
```

After (compliant):

```python
def get_config() -> Config:
    try:
        return load_from_disk()
    except ConfigLoadError as e:
        # EXIT: stale cache older than 60s TTL OR empty cache → caller re-raises
        if cached_config and (now() - cached_config.loaded_at) < 60:
            logger.warning("config load failed, serving stale cache", extra={"age_s": now() - cached_config.loaded_at})
            return cached_config
        raise ConfigLoadError(e.code, e.message, e.path) from e
```

Notes:

- Fallback now has a **named exit condition** (cache present + age < 60s).
- If exit condition fails, the error re-raises — silent fallback is impossible.

---

## Example 4 — JS / TS equivalent

```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

class ConfigLoadError extends Error {
  constructor(
    public code: "FILE_NOT_FOUND" | "INVALID_JSON" | "PERMISSION_DENIED",
    message: string,
    public path?: string
  ) {
    super(`[${code}] ${message}${path ? ` (path=${path})` : ""}`);
    this.name = "ConfigLoadError";
  }
}

async function loadConfig(
  path: string
): Promise<Result<Config, ConfigLoadError>> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (e: any) {
    if (e.code === "ENOENT") {
      // EXIT: file not found, caller decides fallback vs re-raise
      return {
        ok: false,
        error: new ConfigLoadError(
          "FILE_NOT_FOUND",
          "config file not found",
          path
        ),
      };
    }
    if (e.code === "EACCES") {
      // EXIT: permission denied, caller logs + alerts admin
      return {
        ok: false,
        error: new ConfigLoadError(
          "PERMISSION_DENIED",
          "cannot read config file",
          path
        ),
      };
    }
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e: any) {
    // EXIT: invalid JSON, caller shows error with line/column
    return {
      ok: false,
      error: new ConfigLoadError(
        "INVALID_JSON",
        `JSON parse error: ${e.message}`,
        path
      ),
    };
  }
  return { ok: true, value: Config.from(data) };
}
```

Notes:

- `Result<T, E>` discriminated union mirrors Python Result.
- Every error path names an exit decision.
