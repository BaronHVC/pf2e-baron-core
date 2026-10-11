# baron-fixture

Test data for `tools/check-module.mjs`: the smallest module that passes every
check. It does not vendor baron-core (the tests that need a vendored copy and a
lock build them from a throwaway git repo). It declares `"paizo": "cup"` in
baron.json, so NOTICE.md carries the Community Use Policy notice. The negative
cases in `../negative/*.json` are this module plus one change each.
