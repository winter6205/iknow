# Example — Verification Before Completion (6 步完整示例)

1 个 `成功 = <criterion> <evidence>` 完整 6 步示例, 展示如何声称"完成"前必跑 actual test + capture output + 比对.

```bash
# 场景: 实现 place_order() endpoint, 跑完测试后声称"完成"

# 1. Identify the success criterion (binary, observable)
# 成功 = pytest tests/test_orders.py -v exit 0
# 成功 = curl -X POST http://localhost:8000/api/orders -d '{"cart": [{"sku": "abc", "qty": 2}]}' 返回 201 + order_id

# 2. Run the actual test (fresh, not cached / remembered)
$ pytest tests/test_orders.py -v
============================= test session starts ==============================
platform linux -- Python 3.12.1, pytest-8.0.0
collected 12 items
tests/test_orders.py::test_empty_cart_raises PASSED                    [  8%]
tests/test_orders.py::test_negative_quantity_raises PASSED              [ 16%]
tests/test_orders.py::test_long_cart_works PASSED                      [ 25%]
tests/test_orders.py::test_concurrent_orders PASSED                     [ 33%]
tests/test_orders.py::test_insufficient_stock_returns_409 PASSED        [ 41%]
tests/test_orders.py::test_successful_order_returns_201 PASSED          [ 50%]
tests/test_orders.py::test_db_failure_raises_typed_error PASSED         [ 58%]
tests/test_orders.py::test_email_delivery_failure_logs PASSED            [ 66%]
tests/test_orders.py::test_invalid_sku_raises_validation_error PASSED   [ 75%]
tests/test_orders.py::test_payment_failure_returns_payment_error PASSED [ 83%]
tests/test_orders.py::test_concurrent_payment_works PASSED              [ 91%]
tests/test_orders.py::test_schema_validation_works PASSED               [100%]
============================= 12 passed in 4.32s ==============================
EXIT=0

$ curl -X POST http://localhost:8000/api/orders -H "Content-Type: application/json" -d '{"cart": [{"sku": "abc", "qty": 2}]}'
{"status": "success", "order_id": "ord_abc_1700000000"}

# 3. Capture the actual output (paste verbatim, not paraphrase) — 见上面 paste

# 4. Compare output against the criterion
#   pytest exit 0 → 12/12 passed, exit 0 → ✅
#   curl 返回 201 + order_id → 201 + ord_abc_1700000000 → ✅

# 5. If mismatch: stop, fix, re-run (n/a, both pass)

# 6. Report with the success format
成功 = place_order endpoint 完成, pytest tests/test_orders.py -v exit 0 (12/12 passed in 4.32s), curl POST /api/orders 返回 201 + order_id "ord_abc_1700000000"
```

注释: 上例展示了 verification-before-completion 6 步流程: 写 binary criterion → 跑实际 test (fresh, not remembered) → paste verbatim output → 比对 → mismatch 时 stop+fix+re-run → 报告用"成功 = <criterion> <evidence>"格式. 严禁 "looks good" / "应该可以" / "tests pass" 模糊表述. ready to adapt: 任何"完成"声称都必走这 6 步.
