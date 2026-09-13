# Boundary Test Examples (Reference)

## Example

```python
# S2 完整示例: 1 个 public function 的 5-class boundary test
# 函数: parse_user_input(raw: str) -> UserInput
# 5 类: empty / negative / long / concurrent / exception

def parse_user_input(raw: str) -> UserInput:
    """Parse user input string into structured UserInput.

    Contract:
    - empty raw → raise ValueError (typed)
    - raw longer than 10_000 chars → raise ValueError("input too long")
    - raw with invalid encoding (non-UTF8 bytes) → raise UnicodeDecodeError
    - thread-safe (concurrent parse_user_input calls don't corrupt internal state)
    """
    if not raw:
        raise ValueError("raw input is empty")  # empty case
    if len(raw) > 10_000:
        raise ValueError(f"input too long: {len(raw)} chars, max 10_000")  # long case
    decoded = raw.encode("utf-8").decode("utf-8")  # exception case (raises UnicodeDecodeError on invalid)
    return UserInput.from_dict(json.loads(decoded))


# 5-class boundary test (pytest)
import pytest
from concurrent.futures import ThreadPoolExecutor

class TestParseUserInput:
    def test_empty_input_raises(self):  # empty
        with pytest.raises(ValueError, match="empty"):
            parse_user_input("")

    def test_negative_length_after_strip_raises(self):  # negative (whitespace-only)
        with pytest.raises(ValueError):
            parse_user_input("   ")

    def test_long_input_raises(self):  # long (max+1)
        with pytest.raises(ValueError, match="too long"):
            parse_user_input("a" * 10_001)

    def test_concurrent_parse_does_not_corrupt(self):  # concurrent
        inputs = [f'{{"id": {i}}}' for i in range(100)]
        with ThreadPoolExecutor(max_workers=10) as ex:
            results = list(ex.map(parse_user_input, inputs))
        assert len(results) == 100
        assert all(r.id == i for i, r in enumerate(results))

    def test_invalid_encoding_raises_unicode_error(self):  # exception
        with pytest.raises(UnicodeDecodeError):
            parse_user_input(b"\xff\xfe".decode("latin-1"))
```

注释: 上例展示了 S2 5-class boundary test 完整模板. 每个 test method 覆盖 1 类 (empty / negative / long / concurrent / exception). Coverage threshold: line ≥ 80%, branch ≥ 70%. ready to adapt: 任何 public function 都可按这个模板写 5 个 test method.
