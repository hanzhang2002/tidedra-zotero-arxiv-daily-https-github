import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from urllib.error import URLError
from unittest.mock import MagicMock, patch

from scripts.update_papers import (
    OpenAICompatibleTranslator,
    apply_keyword_rules,
    build_search_query,
    fetch_arxiv,
    merge_papers,
    parse_arxiv_feed,
    parse_json_object,
    translate_papers,
    update_data,
)


SAMPLE_FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>https://arxiv.org/abs/2607.13034v1</id>
    <updated>2026-07-14T17:59:31Z</updated>
    <published>2026-07-14T17:59:31Z</published>
    <title>Do AI Agents Know When a Task Is Simple?</title>
    <summary>Large language model agents need complexity-aware execution.</summary>
    <author><name>Junjie Yin</name></author>
    <author><name>Xinyu Feng</name></author>
    <category term="cs.AI" />
    <category term="cs.CL" />
    <arxiv:primary_category term="cs.AI" />
    <link href="https://arxiv.org/abs/2607.13034v1" rel="alternate" type="text/html" />
    <link title="pdf" href="https://arxiv.org/pdf/2607.13034v1" rel="related" type="application/pdf" />
  </entry>
</feed>
"""


class UpdatePapersTests(unittest.TestCase):
    def test_build_search_query(self):
        query = build_search_query(["cs.AI", "cs.CL"], date(2026, 7, 14), date(2026, 7, 15))
        self.assertIn("cat:cs.AI OR cat:cs.CL", query)
        self.assertIn("submittedDate:[202607140000 TO 202607152359]", query)

    def test_parse_feed_uses_configured_timezone(self):
        papers = parse_arxiv_feed(SAMPLE_FEED, "Asia/Shanghai")
        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["id"], "2607.13034")
        self.assertEqual(papers[0]["announcement_date"], "2026-07-15")
        self.assertEqual(papers[0]["primary_category"], "cs.AI")
        self.assertEqual(papers[0]["authors"], ["Junjie Yin", "Xinyu Feng"])

    def test_fetch_arxiv_retries_transient_network_error(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = SAMPLE_FEED
        opener = MagicMock(side_effect=[URLError("temporary"), response])

        with patch("scripts.update_papers.time.sleep"):
            feed = fetch_arxiv(
                ["cs.AI"],
                date(2026, 7, 14),
                date(2026, 7, 15),
                20,
                opener=opener,
                max_retries=2,
            )

        self.assertEqual(feed, SAMPLE_FEED)
        self.assertEqual(opener.call_count, 2)

    def test_keyword_rules_support_highlight_and_filter(self):
        papers = parse_arxiv_feed(SAMPLE_FEED)
        highlighted = apply_keyword_rules(papers, ["agent", "robot"], "highlight")
        self.assertEqual(highlighted[0]["matched_keywords"], ["agent"])
        filtered = apply_keyword_rules(parse_arxiv_feed(SAMPLE_FEED), ["robot"], "filter")
        self.assertEqual(filtered, [])

    def test_merge_preserves_existing_translation(self):
        existing = [{"id": "1", "title_zh": "标题", "abstract_zh": "摘要", "translation_status": "translated"}]
        incoming = [{"id": "1", "title": "Title", "title_zh": "", "abstract_zh": "", "published": "2026-01-01"}]
        merged = merge_papers(existing, incoming)
        self.assertEqual(merged[0]["abstract_zh"], "摘要")
        self.assertEqual(merged[0]["translation_status"], "translated")

    def test_parse_json_object_accepts_unescaped_newline(self):
        content = '{"title_zh":"标题","abstract_zh":"第一行\n第二行"}'
        parsed = parse_json_object(content)
        self.assertEqual(parsed["abstract_zh"], "第一行\n第二行")

    def test_parse_json_object_accepts_fenced_json(self):
        content = '```json\n{"title_zh":"标题","abstract_zh":"摘要"}\n```'
        parsed = parse_json_object(content)
        self.assertEqual(parsed, {"title_zh": "标题", "abstract_zh": "摘要"})

    def test_translator_requests_json_object_response(self):
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-chat",
            "max_retries": 1,
        }
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"choices": [{"message": {"content": '{"title_zh":"标题","abstract_zh":"摘要"}'}}]}
        ).encode("utf-8")

        with patch("scripts.update_papers.urllib.request.urlopen", return_value=response) as urlopen:
            translator = OpenAICompatibleTranslator(config, "test-key")
            translated = translator.translate({"id": "1", "title": "Title", "abstract": "Abstract"})

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(translated, ("标题", "摘要"))

    def test_translate_papers_stops_after_three_consecutive_failures(self):
        papers = [{"id": str(index), "title": "Title", "abstract": "Abstract"} for index in range(1, 5)]
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-chat",
            "max_consecutive_failures": 3,
        }

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True):
            with patch("scripts.update_papers.OpenAICompatibleTranslator") as translator_class:
                translator_class.return_value.translate.side_effect = RuntimeError("API failure")
                with self.assertRaisesRegex(RuntimeError, "3 consecutive translation failures"):
                    translate_papers(papers, config)

        self.assertEqual(translator_class.return_value.translate.call_count, 3)
        self.assertEqual(
            [paper.get("translation_status") for paper in papers],
            ["failed", "failed", "failed", None],
        )

    def test_update_data_writes_day_month_and_manifest(self):
        config = {
            "site": {"timezone": "Asia/Shanghai"},
            "research": {"categories": ["cs.AI"], "keywords": ["agent"], "keyword_mode": "highlight"},
            "fetch": {"lookback_days": 1, "max_results": 20, "retention_months": 12},
            "ai": {"api_base": "https://api.deepseek.com", "model": "deepseek-chat"},
        }
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            with patch("scripts.update_papers.fetch_arxiv", return_value=SAMPLE_FEED):
                with patch.dict(os.environ, {}, clear=True):
                    manifest = update_data(config, data_dir, target_date=date(2026, 7, 14), no_translate=True)
            self.assertEqual(manifest["latest_date"], "2026-07-15")
            self.assertTrue((data_dir / "days" / "2026-07-15.json").exists())
            self.assertTrue((data_dir / "months" / "2026-07.json").exists())
            written = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(written["stats"]["total"], 1)


if __name__ == "__main__":
    unittest.main()
