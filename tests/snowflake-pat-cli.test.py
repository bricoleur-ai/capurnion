"""Validation and manifest generation without touching private configuration."""
import copy
import json
import pathlib
import runpy
import tempfile
import unittest

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
                           ("expectedUser", "")):
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
                        self.assertEqual(manifest["permissions"], ["alarms", "storage"])
                        self.assertEqual(manifest["content_scripts"][0]["matches"], [CONFIG["snowflakePat"]["url"]])
                        self.assertEqual(manifest["background"]["service_worker"], "background.js")
                    else:
                        self.assertNotIn("permissions", manifest)
                        self.assertNotIn("background", manifest)
                        self.assertNotIn("content_scripts", manifest)
                        self.assertNotIn('"snowflakePat"', pathlib.Path(namespace["GENERATED"]).read_text())
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


if __name__ == "__main__":
    unittest.main()
