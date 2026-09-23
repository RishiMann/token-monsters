"""The runtime's tool loop, with a stub in place of the model.

Run: .venv/bin/python -m unittest tests/test_agent_runtime.py
"""

import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import agent_runtime  # noqa: E402


class StubResponses:
    """Plays a scripted sequence of model turns and records what it was sent."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        step = self.script.pop(0)
        output = []
        for call in step.get("calls", []):
            output.append(SimpleNamespace(type="function_call", name=call[0],
                                          arguments=json.dumps(call[1]), call_id=f"call_{len(output)}"))
        if step.get("text") is not None:
            output.append(SimpleNamespace(type="message"))
        return SimpleNamespace(id=f"resp_{len(self.calls)}", output=output, output_text=step.get("text", ""))


def stub_client(script):
    stub = StubResponses(script)
    return SimpleNamespace(responses=stub), stub


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        os.environ["AZURE_OPENAI_DEPLOYMENT"] = "gpt-5-mini"

    def test_endpoint_is_normalized(self):
        with mock.patch.dict(os.environ, {"AZURE_OPENAI_ENDPOINT": "https://x.services.ai.azure.com/openai/v1/responses"}):
            self.assertEqual(agent_runtime.endpoint(), "https://x.services.ai.azure.com/openai/v1/")
        with mock.patch.dict(os.environ, {"AZURE_OPENAI_ENDPOINT": "https://x.openai.azure.com/openai/v1"}):
            self.assertEqual(agent_runtime.endpoint(), "https://x.openai.azure.com/openai/v1/")

    def test_tool_loop_runs_real_tools_and_reports_them(self):
        client, stub = stub_client([
            {"calls": [("assess_cart", {}), ("suggest_pairings", {"limit": 2})]},
            {"calls": [("present_items", {"item_ids": ["lemon-cloud", "no-such-item"]})]},
            {"text": "Lemon Glaze Cloud cuts the fudge."},
        ])
        with mock.patch.object(agent_runtime, "_client", return_value=client):
            reply = agent_runtime.run(
                surface="recommendation", text="what goes with this?",
                cart={"lines": [{"id": "midnight-fudge", "quantity": 1}]},
                history=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": "Hello"},
                         {"role": "system", "content": "ignored"}, {"role": "user", "content": ""}],
            )

        self.assertEqual(reply["message"], "Lemon Glaze Cloud cuts the fudge.")
        self.assertEqual([i["id"] for i in reply["items"]], ["lemon-cloud"])
        self.assertEqual(len(reply["trace"]), 3)
        self.assertTrue(reply["trace"][0].startswith("Read the box: 1 item, $6.00"))
        self.assertIn("Ranked candidates", reply["trace"][1])
        self.assertIn("Add the first one", reply["chips"])

        first = stub.calls[0]
        self.assertEqual(first["model"], "gpt-5-mini")
        self.assertNotIn("temperature", first)
        roles = [m["role"] for m in first["input"]]
        self.assertEqual(roles, ["system", "user", "assistant", "user"])   # bad turns dropped
        self.assertIn("Right now:", first["input"][0]["content"])
        self.assertNotIn("check_inventory", [t["name"] for t in first["tools"]])

        second = stub.calls[1]
        self.assertEqual(second["previous_response_id"], "resp_1")
        self.assertEqual([m["type"] for m in second["input"]], ["function_call_output"] * 2)
        self.assertEqual(json.loads(second["input"][0]["output"])["count"], 1)

    def test_admins_get_franchise_tools(self):
        client, stub = stub_client([{"text": "ok"}])
        with mock.patch.object(agent_runtime, "_client", return_value=client):
            agent_runtime.run(text="stock?", user={"id": 4, "role": "admin"})
        self.assertIn("check_inventory", [t["name"] for t in stub.calls[0]["tools"]])
        self.assertIn("franchise administrator", stub.calls[0]["input"][0]["content"])

    def test_bad_tool_arguments_do_not_kill_the_turn(self):
        client, _ = stub_client([{"calls": [("plan_party", {"guests": "twelve"})]}, {"text": "done"}])
        with mock.patch.object(agent_runtime, "_client", return_value=client):
            reply = agent_runtime.run(text="party")
        self.assertEqual(reply["message"], "done")
        self.assertTrue(reply["trace"][0].startswith("plan_party failed"))

    def test_actions_change_the_box_for_the_turn_and_are_reported(self):
        client, stub = stub_client([
            {"calls": [("add_to_box", {"item_ids": ["lemon-cloud", "no-such"], "quantity": 2})]},
            {"calls": [("price_box", {"fulfillment": "pickup"})]},
            {"text": "Added two Lemon Glaze Cloud."},
        ])
        cart = {"lines": []}
        with mock.patch.object(agent_runtime, "_client", return_value=client):
            reply = agent_runtime.run(text="add two lemon clouds", cart=cart)
        self.assertEqual(reply["actions"], [{"type": "add", "id": "lemon-cloud", "quantity": 2}])
        self.assertEqual(reply["data"]["price_box"]["subtotal"], 10.5)   # price_box saw the change
        self.assertTrue(reply["trace"][0].startswith("Added 2 × Lemon Glaze Cloud"))
        self.assertEqual(reply["items"], [])                              # already in the box, so not re-presented

    def test_apply_offer_only_when_earned(self):
        import agent_tools
        six = {"lines": [{"id": "brown-butter", "quantity": 6}]}
        self.assertTrue(agent_tools.apply_offer(cart=six, offer_id="offer-bundle")["ok"])
        self.assertEqual(six["appliedOffer"], "offer-bundle")
        short = {"lines": [{"id": "brown-butter", "quantity": 2}]}
        result = agent_tools.apply_offer(cart=short, offer_id="offer-bundle")
        self.assertFalse(result["ok"]); self.assertIn("Add 4 more", result["why"])
        self.assertFalse(agent_tools.apply_offer(cart=six, offer_id="offer-delivery")["ok"])
        removed = agent_tools.remove_from_box(cart=six, item_ids=["brown-butter"], quantity=2)
        self.assertEqual(six["lines"][0]["quantity"], 4); self.assertTrue(removed["ok"])

    def test_model_failure_is_an_agent_error(self):
        class Boom:
            def create(self, **_):
                raise RuntimeError("quota")
        with mock.patch.object(agent_runtime, "_client", return_value=SimpleNamespace(responses=Boom())):
            with self.assertRaises(agent_runtime.AgentError):
                agent_runtime.run(text="hi")

    def test_content_filter_is_named(self):
        class Filtered:
            def create(self, **_):
                exc = RuntimeError("Error code: 400 - content_filter")
                exc.body = {"code": "content_filter", "message": "filtered"}
                raise exc
        with mock.patch.object(agent_runtime, "_client", return_value=SimpleNamespace(responses=Filtered())):
            with self.assertRaises(agent_runtime.AgentError) as caught:
                agent_runtime.run(text="hi")
        self.assertEqual(caught.exception.reason, "content_filter")

    def test_missing_endpoint_is_unavailable(self):
        with mock.patch.dict(os.environ, {"AZURE_OPENAI_ENDPOINT": ""}):
            with self.assertRaises(agent_runtime.AgentUnavailable):
                agent_runtime.run(text="hi")


if __name__ == "__main__":
    unittest.main()
