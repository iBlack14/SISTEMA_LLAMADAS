import test from "node:test";
import assert from "node:assert/strict";
import { assertEasypanelConfig, assertXamppConfig, assertIsolatedConfig } from "./config.js";

const valid = () => ({
  APP_ENV: "easypanel", DB_HOST: "llamadas1_mysql", DB_PORT: "3306",
  DB_NAME: "calls_test", DB_USER: "calls_test", DB_PASSWORD: "test-only-password",
  PUBLIC_BASE_URL: "https://llamadas1-v1.tvxk4m.easypanel.host/"
});

test("EasyPanel accepts internal MySQL and normalizes the HTTPS origin", () => {
  assert.equal(assertEasypanelConfig(valid()), "https://llamadas1-v1.tvxk4m.easypanel.host");
});
test("EasyPanel rejects missing credentials and invalid ports", () => {
  for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    assert.throws(() => assertEasypanelConfig({ ...valid(), [key]: "" }));
  }
  for (const port of ["abc", "0", "65536", "3.5"]) {
    for (const key of ["PORT", "DB_PORT"]) {
      assert.throws(() => assertEasypanelConfig({ ...valid(), [key]: port }));
    }
  }
});
test("EasyPanel rejects invalid public origins and mixed local profiles", () => {
  for (const url of ["http://example.com", "https://example.com/path", "https://u:p@example.com",
    "https://example.com/?x=1", "https://example.com/#x", "invalid"]) {
    assert.throws(() => assertEasypanelConfig({ ...valid(), PUBLIC_BASE_URL: url }));
  }
  assert.throws(() => assertEasypanelConfig({ ...valid(), AUTH_LOCAL_ISOLATED: "1" }));
});
test("local profiles still reject the remote MySQL configuration", () => {
  assert.throws(() => assertXamppConfig(valid()));
  assert.throws(() => assertIsolatedConfig(valid()));
});
