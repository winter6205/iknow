# Extract Function Example (S5)

完整示例: Extract Function refactor (40-line → 4-line caller + 3 helpers).
反例: 1 个 40-line `handleSubmit` 混了 4 个责任.
正解: 1 个 4-line caller + 3 个 ~10-line helpers, 各 1 个责任.

```python
# === 反例 (40 lines, 4 responsibilities) ===
def handle_submit(form_data: dict) -> dict:
    # 责任 1: validate input (5 lines)
    errors = {}
    if not form_data.get("email"):
        errors["email"] = "required"
    if not form_data.get("password") or len(form_data["password"]) < 8:
        errors["password"] = "min 8 chars"
    if errors:
        return {"status": "error", "errors": errors}

    # 责任 2: hash password (3 lines)
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(form_data["password"].encode("utf-8"), salt)

    # 责任 3: save to DB (5 lines)
    try:
        user = User(email=form_data["email"], password_hash=hashed, created_at=datetime.now())
        db.session.add(user)
        db.session.commit()
    except IntegrityError:
        return {"status": "error", "errors": {"email": "already registered"}}

    # 责任 4: send welcome email (4 lines)
    try:
        send_email(to=user.email, subject="Welcome", template="welcome.html", user_id=user.id)
    except EmailDeliveryError as e:
        logger.error(f"welcome email failed: {e}")

    return {"status": "success", "user_id": user.id}


# === 正解 (Extract Function: 4-line caller + 3 helpers) ===
def handle_submit(form_data: dict) -> dict:
    errors = validate_registration_form(form_data)
    if errors:
        return {"status": "error", "errors": errors}

    hashed = hash_password(form_data["password"])
    user = save_new_user(form_data["email"], hashed)
    if isinstance(user, Error):
        return {"status": "error", "errors": {"email": user.message}}

    send_welcome_email(user)
    return {"status": "success", "user_id": user.id}


def validate_registration_form(form_data: dict) -> dict:  # 责任 1
    errors = {}
    if not form_data.get("email"):
        errors["email"] = "required"
    if not form_data.get("password") or len(form_data["password"]) < 8:
        errors["password"] = "min 8 chars"
    return errors


def hash_password(password: str) -> bytes:  # 责任 2
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def save_new_user(email: str, password_hash: bytes):  # 责任 3
    try:
        user = User(email=email, password_hash=password_hash, created_at=datetime.now())
        db.session.add(user)
        db.session.commit()
        return user
    except IntegrityError:
        return Error("already registered")


def send_welcome_email(user: User) -> None:  # 责任 4
    try:
        send_email(to=user.email, subject="Welcome", template="welcome.html", user_id=user.id)
    except EmailDeliveryError as e:
        logger.error(f"welcome email failed: {e}")
```

注释: 上例展示了 Extract Function 模式 — 按责任线 (不是按代码行) 拆. 反例 40-line 4 责任混在一起, 改 1 个责任要 cross 整个 function. 正解 4-line caller + 3 helpers 各 1 责任, 改 1 责任只动 1 helper. Linter metrics 全部 under threshold. Adapt: 任何 > 40 line function 都可按"按责任拆"重构成 caller + N helpers.
