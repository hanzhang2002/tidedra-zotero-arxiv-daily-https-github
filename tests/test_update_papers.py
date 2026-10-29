import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import URLError
from unittest.mock import MagicMock, patch

from scripts.update_papers import (
    OpenAICompatibleTranslator,
    TruncatedTranslationError,
    apply_keyword_rules,
    build_search_query,
    fetch_arxiv,
    load_existing_translations,
    merge_papers,
    parse_arxiv_feed,
    parse_json_object,
    prune_history,
    split_abstract_chunks,
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
    def test_config_uses_official_statistics_categories(self):
        config = json.loads(Path("config/settings.json").read_text(encoding="utf-8"))
        categories = {item["code"]: item for item in config["available_categories"]}
        statistics_codes = {"stat.AP", "stat.CO", "stat.ME", "stat.ML", "stat.OT", "stat.TH"}

        self.assertTrue(statistics_codes.issubset(config["research"]["categories"]))
        self.assertTrue(statistics_codes.issubset(categories))
        self.assertTrue(all(categories[code]["group"] == "统计学" for code in statistics_codes))
        self.assertEqual(config["research"]["keyword_mode"], "filter")

    def test_frontend_hides_ai_connection_fields(self):
        html = Path("index.html").read_text(encoding="utf-8")
        app = Path("assets/app.js").read_text(encoding="utf-8")

        self.assertIn("摘要翻译由 <strong>DeepSeek</strong> 模型完成", html)
        self.assertIn("搜索已收录论文的标题、摘要或作者", html)
        self.assertNotIn("apiBaseInput", html + app)
        self.assertNotIn("modelInput", html + app)
        self.assertIn('searchInput.addEventListener("input", handleSearchInput)', app)

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
            "model": "deepseek-v4-flash",
            "thinking": "disabled",
            "max_tokens": 4096,
            "max_retries": 1,
        }
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": '{"title_zh":"标题","abstract_zh":"摘要"}'},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode("utf-8")

        with patch("scripts.update_papers.urllib.request.urlopen", return_value=response) as urlopen:
            translator = OpenAICompatibleTranslator(config, "test-key")
            translated = translator.translate({"id": "1", "title": "Title", "abstract": "Abstract"})

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "deepseek-v4-flash")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertEqual(payload["max_tokens"], 4096)
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertIn('{"title_zh":"中文标题"', payload["messages"][0]["content"])
        self.assertEqual(translated, ("标题", "摘要"))

    def test_translator_reports_truncated_json_diagnostics(self):
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_retries": 1,
        }
        content = '{"title_zh":"标题","abstract_zh":"未结束'
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"choices": [{"message": {"content": content}, "finish_reason": "length"}]}
        ).encode("utf-8")

        with patch("scripts.update_papers.urllib.request.urlopen", return_value=response):
            translator = OpenAICompatibleTranslator(config, "test-key")
            with self.assertRaisesRegex(
                RuntimeError,
                rf"finish_reason=length; content_chars={len(content)}",
            ):
                translator.translate({"id": "1", "title": "Title", "abstract": "Abstract"})

    def test_translate_papers_pauses_and_preserves_partial_results(self):
        papers = [{"id": str(index), "title": "Title", "abstract": "Abstract"} for index in range(1, 6)]
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_consecutive_failures": 3,
            "max_concurrent": 1,
        }

        output = io.StringIO()
        with patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "test-key", "GITHUB_ACTIONS": "true"},
            clear=True,
        ):
            with patch("scripts.update_papers.OpenAICompatibleTranslator") as translator_class:
                translator_class.return_value.translate.side_effect = [
                    ("标题", "摘要"),
                    RuntimeError("API failure"),
                    RuntimeError("API failure"),
                    RuntimeError("API failure"),
                ]
                with redirect_stdout(output):
                    stats = translate_papers(papers, config)

        self.assertEqual(translator_class.return_value.translate.call_count, 4)
        self.assertEqual(
            [paper.get("translation_status") for paper in papers],
            ["translated", "failed", "failed", "failed", "deferred"],
        )
        self.assertEqual(stats, {"translated": 1, "reused": 0, "failed": 3, "skipped": 0, "deferred": 1})
        self.assertIn("::warning title=AI translation paused::", output.getvalue())

    def test_update_data_writes_day_month_and_manifest(self):
        config = {
            "site": {"timezone": "Asia/Shanghai"},
            "research": {"categories": ["cs.AI"], "keywords": ["agent"], "keyword_mode": "highlight"},
            "fetch": {"lookback_days": 1, "max_results": 20, "retention_months": 12},
            "ai": {"api_base": "https://api.deepseek.com", "model": "deepseek-v4-flash"},
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

    def test_load_existing_translations_scans_days_and_months(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            (data_dir / "months").mkdir(parents=True)
            (data_dir / "days").mkdir(parents=True)
            (data_dir / "months" / "2026-07.json").write_text(
                json.dumps(
                    {
                        "papers": [
                            {"id": "A", "title_zh": "旧标题", "abstract_zh": "旧摘要", "translation_status": "translated"},
                            {"id": "B", "title_zh": "月标题", "abstract_zh": "月摘要", "translation_status": "translated"},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (data_dir / "days" / "2026-07-15.json").write_text(
                json.dumps(
                    {
                        "papers": [
                            {"id": "A", "title_zh": "新标题", "abstract_zh": "新摘要", "translation_status": "translated"},
                            {"id": "C", "title_zh": "日标题", "abstract_zh": "日摘要", "translation_status": "translated"},
                        ]
                    }
                ),
                encoding="utf-8",
            )

            translations = load_existing_translations(data_dir)

        self.assertEqual(translations["A"]["abstract_zh"], "新摘要")
        self.assertEqual(translations["B"]["abstract_zh"], "月摘要")
        self.assertEqual(translations["C"]["abstract_zh"], "日摘要")

    def test_prune_history_moves_expired_files_to_trash(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory)
            (data_dir / "days").mkdir(parents=True)
            (data_dir / "months").mkdir(parents=True)
            old_day = data_dir / "days" / "2024-01-15.json"
            old_month = data_dir / "months" / "2024-01.json"
            fresh_day = data_dir / "days" / "2026-07-15.json"
            fresh_month = data_dir / "months" / "2026-07.json"
            for path in (old_day, old_month, fresh_day, fresh_month):
                path.write_text("{}", encoding="utf-8")

            now = datetime(2026, 7, 15, tzinfo=timezone.utc)
            trashed = prune_history(data_dir, retention_months=12, reference_date=date(2026, 7, 15), now=now)

            self.assertFalse(old_day.exists())
            self.assertFalse(old_month.exists())
            self.assertTrue(fresh_day.exists())
            self.assertTrue(fresh_month.exists())
            self.assertEqual(sorted(trashed), ["days/2024-01-15.json", "months/2024-01.json"])
            stamp = "20260715T000000Z"
            self.assertTrue((data_dir / ".trash" / stamp / "days" / "2024-01-15.json").exists())
            self.assertTrue((data_dir / ".trash" / stamp / "months" / "2024-01.json").exists())

    def test_split_abstract_chunks_respects_sentence_boundaries(self):
        text = "First sentence about statistics. Second sentence about bayesian methods. Third sentence about causal inference."
        pieces = split_abstract_chunks(text, chunk_size=60, max_pieces=8)
        self.assertGreaterEqual(len(pieces), 2)
        for piece in pieces:
            self.assertLessEqual(len(piece), 60)
        self.assertEqual(" ".join(pieces), text)

    def test_split_abstract_chunks_returns_single_piece_for_short_text(self):
        self.assertEqual(split_abstract_chunks("short abstract", chunk_size=200), ["short abstract"])

    def test_split_abstract_chunks_merges_tail_when_over_max_pieces(self):
        text = ". ".join(f"sentence number {index}" for index in range(20))
        pieces = split_abstract_chunks(text, chunk_size=25, max_pieces=3)
        self.assertEqual(len(pieces), 3)

    def test_translator_uses_chunked_path_for_long_abstract(self):
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_retries": 1,
            "chunk_threshold_chars": 100,
            "chunk_size_chars": 70,
            "chunk_max_pieces": 4,
        }
        long_abstract = (
            "First sentence about statistical inference methods. "
            "Second sentence about bayesian posterior computation. "
            "Third sentence about causal identification strategies."
        )
        self.assertGreater(len(long_abstract), 60)

        first_response = MagicMock()
        first_response.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": '{"title_zh":"标题","abstract_zh":"第一段。"}'},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode("utf-8")
        second_response = MagicMock()
        second_response.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": '{"title_zh":"","abstract_zh":"第二段。"}'},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode("utf-8")
        third_response = MagicMock()
        third_response.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": '{"title_zh":"","abstract_zh":"第三段。"}'},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode("utf-8")

        with patch(
            "scripts.update_papers.urllib.request.urlopen",
            side_effect=[first_response, second_response, third_response],
        ) as urlopen:
            translator = OpenAICompatibleTranslator(config, "test-key")
            title_zh, abstract_zh = translator.translate(
                {"id": "1", "title": "Title", "abstract": long_abstract}
            )

        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(title_zh, "标题")
        self.assertEqual(abstract_zh, "第一段。 第二段。 第三段。")
        first_payload = json.loads(urlopen.call_args_list[0].args[0].data.decode("utf-8"))
        self.assertIn("piece_index", first_payload["messages"][1]["content"])
        self.assertIn("piece_total", first_payload["messages"][1]["content"])

    def test_translator_falls_back_to_chunked_on_truncation(self):
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_retries": 1,
            "chunk_threshold_chars": 5000,
            "chunk_size_chars": 60,
            "chunk_max_pieces": 4,
        }
        abstract = (
            "First sentence about statistical inference methods. "
            "Second sentence about bayesian posterior computation."
        )
        self.assertGreater(len(abstract), 40)

        truncated = MagicMock()
        truncated.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {"message": {"content": '{"title_zh":"标题","abstract_zh":"未结束'}, "finish_reason": "length"}
                ]
            }
        ).encode("utf-8")
        chunk_first = MagicMock()
        chunk_first.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": '{"title_zh":"标题","abstract_zh":"第一段。"}'},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode("utf-8")
        chunk_second = MagicMock()
        chunk_second.__enter__.return_value.read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": '{"title_zh":"","abstract_zh":"第二段。"}'},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode("utf-8")

        with patch(
            "scripts.update_papers.urllib.request.urlopen",
            side_effect=[truncated, chunk_first, chunk_second],
        ) as urlopen:
            translator = OpenAICompatibleTranslator(config, "test-key")
            title_zh, abstract_zh = translator.translate(
                {"id": "1", "title": "Title", "abstract": abstract}
            )

        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(title_zh, "标题")
        self.assertEqual(abstract_zh, "第一段。 第二段。")

    def test_translator_reraises_truncation_when_abstract_short(self):
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_retries": 1,
            "chunk_threshold_chars": 5000,
            "chunk_size_chars": 1200,
        }
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"choices": [{"message": {"content": '{"title_zh":"标题","abstract_zh":"未'}, "finish_reason": "length"}]}
        ).encode("utf-8")

        with patch("scripts.update_papers.urllib.request.urlopen", return_value=response):
            translator = OpenAICompatibleTranslator(config, "test-key")
            with self.assertRaises(TruncatedTranslationError):
                translator.translate({"id": "1", "title": "Title", "abstract": "Abstract"})

    def test_translate_papers_runs_concurrently(self):
        papers = [
            {"id": str(index), "title": f"Title {index}", "abstract": "Abstract"} for index in range(1, 5)
        ]
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_concurrent": 4,
            "max_consecutive_failures": 10,
        }

        concurrency_lock = threading.Lock()
        observed = {"active": 0, "peak": 0}

        def fake_translate(paper):
            with concurrency_lock:
                observed["active"] += 1
                observed["peak"] = max(observed["peak"], observed["active"])
            try:
                # Small sleep increases the chance that multiple workers overlap.
                import time as _time
                _time.sleep(0.05)
                return (f"标题{paper['id']}", f"摘要{paper['id']}")
            finally:
                with concurrency_lock:
                    observed["active"] -= 1

        output = io.StringIO()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True):
            with patch("scripts.update_papers.OpenAICompatibleTranslator") as translator_class:
                translator_class.return_value.translate.side_effect = fake_translate
                with redirect_stdout(output):
                    stats = translate_papers(papers, config)

        self.assertEqual(stats["translated"], 4)
        self.assertGreaterEqual(observed["peak"], 2)
        self.assertTrue(all(paper["translation_status"] == "translated" for paper in papers))

    def test_translate_papers_reuses_existing_translations_without_api_calls(self):
        papers = [
            {"id": "1", "title": "Title", "abstract": "Abstract", "abstract_zh": "旧摘要", "title_zh": "旧标题"},
            {"id": "2", "title": "Title", "abstract": "Abstract"},
        ]
        config = {
            "api_base": "https://api.deepseek.com",
            "model": "deepseek-v4-flash",
            "max_concurrent": 2,
        }

        output = io.StringIO()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=True):
            with patch("scripts.update_papers.OpenAICompatibleTranslator") as translator_class:
                translator_class.return_value.translate.return_value = ("新标题", "新摘要")
                with redirect_stdout(output):
                    stats = translate_papers(papers, config)

        self.assertEqual(translator_class.return_value.translate.call_count, 1)
        self.assertEqual(stats, {"translated": 1, "reused": 1, "failed": 0, "skipped": 0, "deferred": 0})
        self.assertEqual(papers[0]["abstract_zh"], "旧摘要")
        self.assertEqual(papers[1]["abstract_zh"], "新摘要")


if __name__ == "__main__":
    unittest.main()
