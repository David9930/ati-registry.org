import unittest
import yaml
from ati import forms
from ati.records import ROOT


class Forms(unittest.TestCase):
    def test_committed_yaml_is_current(self):
        for name, text in forms.render_all().items():
            self.assertEqual((ROOT / ".github" / "ISSUE_TEMPLATE" / name).read_text(encoding="utf-8"), text,
                             f"{name} is stale; run python -m ati.forms")

    def test_valid_yaml_and_required(self):
        d = yaml.safe_load(forms.render_all()["register.yml"])
        ids = [e.get("id") for e in d["body"] if e["type"] != "markdown"]
        self.assertEqual(len(ids), len(set(ids)))
        att = next(e for e in d["body"] if e.get("id") == "attest")
        self.assertTrue(all(o["required"] for o in att["attributes"]["options"]))
        req = {e["id"] for e in d["body"] if e.get("validations", {}).get("required")}
        self.assertTrue({"title", "author", "year", "label", "statement", "cover"} <= req)

    def test_no_preselected_dropdown_answers(self):
        text = forms.render_all()["register.yml"]
        self.assertNotIn("default:", text)  # every dropdown must be an active choice
        d = yaml.safe_load(text)
        role = next(e for e in d["body"] if e.get("id") == "role")
        self.assertTrue(role["validations"]["required"])

    def test_labels_unique(self):
        for fields in (forms.REGISTER, forms.UPDATE):
            ls = [f[2] for f in fields if f[2]]
            self.assertEqual(len(ls), len(set(ls)))


if __name__ == "__main__":
    unittest.main()
