"""Validation and manifest generation without touching private configuration."""
import contextlib
import copy
import io
import json
import pathlib
import runpy
import tempfile
import unittest
from unittest import mock

MODULE = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "bin/capurnion"))
CONFIG = {"version": 1, "rules": [], "snowflakePat": {
    "enabled": True, "confirmGrantsAccess": True,
    "url": "https://app.snowflake.com/testorg/testaccount/settings/authentication",
    "expectedUser": "test-user", "intervalMinutes": 60,
    "renewBelowMinutes": 120, "grantHours": 24,
}}


class PatConfigTests(unittest.TestCase):
    def test_exact_scope_and_authorization(self):
        self.assertEqual(MODULE["validate"](CONFIG)[0], [])
        for key, value in (("url", "https://app.snowflake.com/*"),
                           ("confirmGrantsAccess", False), ("grantHours", 48),
                           ("intervalMinutes", True), ("renewBelowMinutes", 180),
                           ("expectedUser", ""), ("pollMinutes", 1), ("restoreMissingAccess", "yes")):
            changed = copy.deepcopy(CONFIG)
            changed["snowflakePat"][key] = value
            self.assertTrue(MODULE["validate"](changed)[0], key)

    def test_enabled_and_disabled_manifest(self):
        fn = MODULE["cmd_sync"]
        namespace = fn.__globals__
        original = {key: namespace[key] for key in ("RULES", "MANIFEST", "GENERATED")}
        with tempfile.TemporaryDirectory(prefix="capurnion-cli-") as directory:
            try:
                for key, filename in (("RULES", "rules.json"), ("MANIFEST", "manifest.json"), ("GENERATED", "rules.generated.js")):
                    namespace[key] = str(pathlib.Path(directory) / filename)
                for enabled in (True, False):
                    config = copy.deepcopy(CONFIG)
                    config["snowflakePat"]["enabled"] = enabled
                    pathlib.Path(namespace["RULES"]).write_text(json.dumps(config))
                    fn(None)
                    manifest = json.loads(pathlib.Path(namespace["MANIFEST"]).read_text())
                    if enabled:
                        self.assertEqual(manifest["permissions"], ["alarms", "storage", "notifications", "scripting"])
                        self.assertEqual(manifest["content_scripts"][0]["matches"], ["https://app.snowflake.com/testorg/testaccount/*"])
                        self.assertEqual(manifest["background"]["service_worker"], "background.js")
                        self.assertEqual(manifest["host_permissions"], ["https://app.snowflake.com/*"])
                    else:
                        self.assertNotIn("permissions", manifest)
                        self.assertNotIn("background", manifest)
                        self.assertNotIn("content_scripts", manifest)
                        self.assertNotIn('"snowflakePat"', pathlib.Path(namespace["GENERATED"]).read_text())
            finally:
                namespace.update(original)

    def test_combined_okta_permissions_and_recovery_configuration(self):
        fn = MODULE["cmd_sync"]
        namespace = fn.__globals__
        original = {key: namespace[key] for key in ("RULES", "MANIFEST", "GENERATED")}
        config = copy.deepcopy(CONFIG)
        config["snowflakePat"].update(pollMinutes=5, restoreMissingAccess=True)
        config["vault"] = {"enabled": True}
        config["oktaLogin"] = {"enabled": True, "confirmAutomatesMfa": True,
                               "host": "example.okta.com", "smsCodeUrl": "https://sms.example.com/code"}
        config["rules"] = [{"id": "sso", "enabled": True, "kind": "idp-select",
                            "hosts": ["app.snowflake.com"], "require": {"pageText": "sign in to testaccount"},
                            "click": {"label": "sign in with okta"}}]
        self.assertEqual(MODULE["validate"](config)[0], [])
        with tempfile.TemporaryDirectory(prefix="capurnion-combined-cli-") as directory:
            try:
                for key, filename in (("RULES", "rules.json"), ("MANIFEST", "manifest.json"), ("GENERATED", "rules.generated.js")):
                    namespace[key] = str(pathlib.Path(directory) / filename)
                pathlib.Path(namespace["RULES"]).write_text(json.dumps(config))
                fn(None)
                manifest = json.loads(pathlib.Path(namespace["MANIFEST"]).read_text())
                self.assertEqual(manifest["host_permissions"], ["https://app.snowflake.com/*", "https://example.okta.com/*", "https://sms.example.com/*"])
                self.assertIn("snowflake-sso-watch.js", manifest["content_scripts"][0]["js"])
                self.assertIn("notifications", manifest["permissions"])
                self.assertIn('"restoreMissingAccess": true', pathlib.Path(namespace["GENERATED"]).read_text())
            finally:
                namespace.update(original)

    def test_vault_only_manifest_and_validation(self):
        self.assertTrue(MODULE["validate"]({"version": 1, "rules": [], "vault": {"enabled": "yes"}})[0])
        fn = MODULE["cmd_sync"]
        namespace = fn.__globals__
        original = {key: namespace[key] for key in ("RULES", "MANIFEST", "GENERATED")}
        with tempfile.TemporaryDirectory(prefix="capurnion-vault-cli-") as directory:
            try:
                for key, filename in (("RULES", "rules.json"), ("MANIFEST", "manifest.json"), ("GENERATED", "rules.generated.js")):
                    namespace[key] = str(pathlib.Path(directory) / filename)
                pathlib.Path(namespace["RULES"]).write_text(json.dumps({"version": 1, "rules": [], "vault": {"enabled": True}}))
                fn(None)
                manifest = json.loads(pathlib.Path(namespace["MANIFEST"]).read_text())
                self.assertEqual(manifest["permissions"], ["storage", "unlimitedStorage"])
                self.assertEqual(manifest["options_ui"], {"page": "options.html", "open_in_tab": True})
                self.assertNotIn("content_scripts", manifest)
                self.assertNotIn("host_permissions", manifest)
            finally:
                namespace.update(original)

    def test_doctor_says_chrome_check_is_macos_only_elsewhere(self):
        namespace = MODULE["cmd_doctor"].__globals__
        original = {key: namespace[key] for key in ("RULES", "MANIFEST", "GENERATED")}
        with tempfile.TemporaryDirectory(prefix="capurnion-doctor-cli-") as directory:
            try:
                for key, filename in (("RULES", "rules.json"), ("MANIFEST", "manifest.json"), ("GENERATED", "rules.generated.js")):
                    namespace[key] = str(pathlib.Path(directory) / filename)
                pathlib.Path(namespace["RULES"]).write_text(json.dumps({"version": 1, "rules": []}))
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    namespace["cmd_sync"](None)
                    with mock.patch("sys.platform", "linux"):
                        namespace["cmd_doctor"](None)
                self.assertIn("macOS only", output.getvalue())
            finally:
                namespace.update(original)

    def test_doctor_on_macos_says_registered_is_not_verified_loaded(self):
        namespace = MODULE["cmd_doctor"].__globals__
        original = {key: namespace[key] for key in ("RULES", "MANIFEST", "GENERATED")}
        root = namespace["ROOT"]
        ext_id = namespace["chrome_extension_id"](root)
        cases = (
            ({ext_id: {"path": root}}, "registered; not verified loaded"),
            ({}, "not loaded in Chrome"),
            ({ext_id: {"path": root + "-elsewhere"}}, "incomplete Chrome registration"),
        )
        with tempfile.TemporaryDirectory(prefix="capurnion-doctor-mac-") as directory:
            try:
                for key, filename in (("RULES", "rules.json"), ("MANIFEST", "manifest.json"), ("GENERATED", "rules.generated.js")):
                    namespace[key] = str(pathlib.Path(directory) / filename)
                pathlib.Path(namespace["RULES"]).write_text(json.dumps({"version": 1, "rules": []}))
                with contextlib.redirect_stdout(io.StringIO()):
                    namespace["cmd_sync"](None)
                prefs = pathlib.Path(directory) / "Library/Application Support/Google/Chrome/Default/Secure Preferences"
                prefs.parent.mkdir(parents=True)
                for settings, expected in cases:
                    prefs.write_text(json.dumps({"extensions": {"settings": settings, "ui": {"developer_mode": True}}}))
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output), mock.patch("sys.platform", "darwin"), \
                            mock.patch.dict("os.environ", {"HOME": directory}):
                        namespace["cmd_doctor"](None)
                    text = output.getvalue()
                    self.assertIn(expected, text)
                    self.assertNotIn("registered in Chrome at this extension's path", text)
                    self.assertIn("no problems", text)
                    if expected != "registered; not verified loaded":
                        self.assertIn("warn", text)
            finally:
                namespace.update(original)


if __name__ == "__main__":
    unittest.main()
