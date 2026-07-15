#!/usr/bin/env python3
"""Fetch arXiv papers, translate abstracts, and update static JSON data."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ARXIV_API_URL = "https://export.arxiv.org/api/query"
USER_AGENT = "personal-arxiv-daily/1.0 (single-user research reader)"
ATOM = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    if path.exists() and path.read_text(encoding="utf-8") == serialized:
        return
    path.write_text(serialized, encoding="utf-8")


def compact_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def build_search_query(categories: Iterable[str], start_date: date, end_date: date) -> str:
    category_terms = [f"cat:{category}" for category in categories]
    if not category_terms:
        raise ValueError("At least one arXiv category is required")
    category_query = " OR ".join(category_terms)
    start = start_date.strftime("%Y%m%d0000")
    end = end_date.strftime("%Y%m%d2359")
    return f"({category_query}) AND submittedDate:[{start} TO {end}]"


def fetch_arxiv(
    categories: list[str],
    start_date: date,
    end_date: date,
    max_results: int,
    *,
    opener: Any = urllib.request.urlopen,
    max_retries: int = 3,
) -> bytes:
    params = urllib.parse.urlencode(
        {
            "search_query": build_search_query(categories, start_date, end_date),
            "start": 0,
            "max_results": max_results,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        }
    )
    request = urllib.request.Request(
        f"{ARXIV_API_URL}?{params}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/atom+xml"},
    )
    for attempt in range(max_retries):
        try:
            with opener(request, timeout=60) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt + 1 >= max_retries:
                raise RuntimeError(f"arXiv request failed after {max_retries} attempts: {error}") from error
            time.sleep(2**attempt)
    raise RuntimeError("arXiv request failed")


def parse_arxiv_feed(xml_bytes: bytes, timezone_name: str = "Asia/Shanghai") -> list[dict[str, Any]]:
    root = ET.fromstring(xml_bytes)
    local_timezone = ZoneInfo(timezone_name)
    papers: list[dict[str, Any]] = []

    for entry in root.findall("atom:entry", ATOM):
        source_url = compact_text(entry.findtext("atom:id", default="", namespaces=ATOM)).replace(
            "http://arxiv.org/", "https://arxiv.org/"
        )
        raw_id = source_url.rsplit("/", 1)[-1]
        arxiv_id = re.sub(r"v\d+$", "", raw_id)
        version_match = re.search(r"(v\d+)$", raw_id)
        published = compact_text(entry.findtext("atom:published", default="", namespaces=ATOM))
        updated = compact_text(entry.findtext("atom:updated", default="", namespaces=ATOM))
        published_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
        announcement_date = published_at.astimezone(local_timezone).date().isoformat()
        authors = [
            compact_text(author.findtext("atom:name", default="", namespaces=ATOM))
            for author in entry.findall("atom:author", ATOM)
        ]
        categories = [node.attrib.get("term", "") for node in entry.findall("atom:category", ATOM)]
        primary_node = entry.find("arxiv:primary_category", ATOM)
        primary_category = primary_node.attrib.get("term", "") if primary_node is not None else ""
        links = {"abs": source_url, "pdf": f"https://arxiv.org/pdf/{raw_id}"}
        for link in entry.findall("atom:link", ATOM):
            if link.attrib.get("title") == "pdf":
                links["pdf"] = link.attrib.get("href", links["pdf"])

        papers.append(
            {
                "id": arxiv_id,
                "arxiv_id": raw_id,
                "version": version_match.group(1) if version_match else "",
                "title": compact_text(entry.findtext("atom:title", default="", namespaces=ATOM)),
                "title_zh": "",
                "authors": [author for author in authors if author],
                "abstract": compact_text(entry.findtext("atom:summary", default="", namespaces=ATOM)),
                "abstract_zh": "",
                "categories": [category for category in categories if category],
                "primary_category": primary_category,
                "published": published,
                "updated": updated,
                "announcement_date": announcement_date,
                "links": links,
                "matched_keywords": [],
                "translation_status": "pending",
            }
        )

    return papers


def apply_keyword_rules(
    papers: list[dict[str, Any]], keywords: Iterable[str], mode: str = "highlight"
) -> list[dict[str, Any]]:
    cleaned_keywords = [keyword.strip() for keyword in keywords if keyword.strip()]
    selected: list[dict[str, Any]] = []
    for paper in papers:
        haystack = f"{paper.get('title', '')}\n{paper.get('abstract', '')}".casefold()
        matched = [keyword for keyword in cleaned_keywords if keyword.casefold() in haystack]
        paper["matched_keywords"] = matched
        if mode == "filter" and cleaned_keywords and not matched:
            continue
        selected.append(paper)
    return selected


class OpenAICompatibleTranslator:
    def __init__(self, config: dict[str, Any], api_key: str):
        base = config["api_base"].rstrip("/")
        self.endpoint = base if base.endswith("/chat/completions") else f"{base}/chat/completions"
        self.model = config["model"]
        self.target_language = config.get("target_language", "简体中文")
        self.temperature = float(config.get("temperature", 0.2))
        self.max_tokens = int(config.get("max_tokens", 4096))
        self.thinking = str(config.get("thinking", "")).strip()
        self.timeout = int(config.get("timeout_seconds", 90))
        self.max_retries = int(config.get("max_retries", 3))
        self.api_key = api_key

    def translate(self, paper: dict[str, Any]) -> tuple[str, str]:
        prompt = {
            "title": paper["title"],
            "abstract": paper["abstract"],
            "target_language": self.target_language,
        }
        payload = {
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是严谨的学术论文翻译器。准确翻译标题和完整摘要，不扩写、不总结、"
                        "不改变公式、数字、缩写和专有名词。只返回有效 json 对象，不要使用 Markdown 代码围栏。"
                        "输出格式示例：{\"title_zh\":\"中文标题\",\"abstract_zh\":\"完整中文摘要\"}"
                    ),
                },
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
            ],
        }
        if self.thinking:
            payload["thinking"] = {"type": self.thinking}
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )

        for attempt in range(self.max_retries):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    response_payload = json.loads(response.read().decode("utf-8"))
                choice = response_payload["choices"][0]
                raw_content = choice["message"].get("content")
                finish_reason = choice.get("finish_reason") or "unknown"
                if not isinstance(raw_content, str) or not raw_content.strip():
                    raise ValueError(f"Model returned empty content; finish_reason={finish_reason}")
                content = raw_content.strip()
                try:
                    parsed = parse_json_object(content)
                except (ValueError, json.JSONDecodeError) as error:
                    raise ValueError(
                        f"{error}; finish_reason={finish_reason}; content_chars={len(content)}"
                    ) from error
                return compact_text(parsed["title_zh"]), compact_text(parsed["abstract_zh"])
            except (urllib.error.URLError, TimeoutError, KeyError, ValueError, json.JSONDecodeError) as error:
                if attempt + 1 >= self.max_retries:
                    raise RuntimeError(f"Translation failed for {paper['id']}: {error}") from error
                time.sleep(2**attempt)
        raise RuntimeError(f"Translation failed for {paper['id']}")


def parse_json_object(content: str) -> dict[str, Any]:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE | re.DOTALL)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("Model response did not contain a JSON object")
    parsed = json.loads(cleaned[start : end + 1], strict=False)
    if not isinstance(parsed, dict):
        raise ValueError("Model response JSON was not an object")
    for key in ("title_zh", "abstract_zh"):
        if not isinstance(parsed.get(key), str) or not parsed[key].strip():
            raise ValueError(f"Model response is missing a non-empty {key}")
    return parsed


def load_existing_translations(data_dir: Path) -> dict[str, dict[str, str]]:
    translations: dict[str, dict[str, str]] = {}
    for path in (data_dir / "months").glob("*.json"):
        payload = read_json(path, {})
        for paper in payload.get("papers", []):
            if paper.get("abstract_zh"):
                translations[paper["id"]] = {
                    "title_zh": paper.get("title_zh", ""),
                    "abstract_zh": paper.get("abstract_zh", ""),
                    "translation_status": paper.get("translation_status", "translated"),
                }
    return translations


def translate_papers(
    papers: list[dict[str, Any]], ai_config: dict[str, Any], *, no_translate: bool = False
) -> dict[str, int]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    translator = None if no_translate or not api_key else OpenAICompatibleTranslator(ai_config, api_key)
    stats = {"translated": 0, "reused": 0, "failed": 0, "skipped": 0, "deferred": 0}
    consecutive_failures = 0
    max_consecutive_failures = int(ai_config.get("max_consecutive_failures", 3))
    translation_paused = False
    if translator is None:
        reason = "disabled" if no_translate else "OPENAI_API_KEY is not set"
        print(f"Translation skipped: {reason}", flush=True)

    for index, paper in enumerate(papers, start=1):
        if paper.get("abstract_zh"):
            stats["reused"] += 1
            continue
        if translation_paused:
            paper["translation_status"] = "deferred"
            stats["deferred"] += 1
            continue
        if translator is None:
            paper["translation_status"] = "skipped"
            stats["skipped"] += 1
            continue
        print(f"Translating {index}/{len(papers)}: {paper['id']}", flush=True)
        try:
            paper["title_zh"], paper["abstract_zh"] = translator.translate(paper)
            paper["translation_status"] = "translated"
            stats["translated"] += 1
            consecutive_failures = 0
        except RuntimeError as error:
            print(str(error), file=sys.stderr, flush=True)
            paper["translation_status"] = "failed"
            stats["failed"] += 1
            consecutive_failures += 1
            if consecutive_failures >= max_consecutive_failures:
                translation_paused = True
                pause_message = (
                    f"Translation paused after {consecutive_failures} consecutive failures; "
                    "successful results will be stored and remaining papers deferred"
                )
                print(pause_message, file=sys.stderr, flush=True)
                if os.environ.get("GITHUB_ACTIONS") == "true":
                    print(f"::warning title=AI translation paused::{pause_message}", flush=True)

    print(
        "Translation summary: "
        f"translated={stats['translated']}, reused={stats['reused']}, "
        f"failed={stats['failed']}, skipped={stats['skipped']}, deferred={stats['deferred']}",
        flush=True,
    )
    return stats


def merge_papers(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = {paper["id"]: paper for paper in existing}
    for paper in incoming:
        previous = merged.get(paper["id"], {})
        if previous.get("abstract_zh") and not paper.get("abstract_zh"):
            paper["title_zh"] = previous.get("title_zh", "")
            paper["abstract_zh"] = previous["abstract_zh"]
            paper["translation_status"] = previous.get("translation_status", "translated")
        merged[paper["id"]] = paper
    return sorted(merged.values(), key=lambda item: item.get("published", ""), reverse=True)


def rebuild_month(data_dir: Path, month: str, generated_at: str) -> None:
    papers: list[dict[str, Any]] = []
    for day_path in sorted((data_dir / "days").glob(f"{month}-*.json")):
        papers.extend(read_json(day_path, {}).get("papers", []))
    write_json(
        data_dir / "months" / f"{month}.json",
        {"month": month, "updated_at": generated_at, "papers": merge_papers([], papers)},
    )


def prune_history(data_dir: Path, retention_months: int, reference_date: date) -> None:
    cutoff_index = reference_date.year * 12 + reference_date.month - retention_months + 1
    for path in (data_dir / "days").glob("*.json"):
        year, month = map(int, path.stem.split("-")[:2])
        if year * 12 + month < cutoff_index:
            path.unlink()
    for path in (data_dir / "months").glob("*.json"):
        year, month = map(int, path.stem.split("-"))
        if year * 12 + month < cutoff_index:
            path.unlink()


def rebuild_manifest(data_dir: Path, generated_at: str) -> dict[str, Any]:
    dates: list[dict[str, Any]] = []
    translated = 0
    total = 0
    for path in sorted((data_dir / "days").glob("*.json"), reverse=True):
        payload = read_json(path, {})
        papers = payload.get("papers", [])
        day_translated = sum(1 for paper in papers if paper.get("translation_status") == "translated")
        dates.append({"date": path.stem, "count": len(papers), "translated": day_translated})
        total += len(papers)
        translated += day_translated
    months = sorted((path.stem for path in (data_dir / "months").glob("*.json")), reverse=True)
    manifest = {
        "updated_at": generated_at,
        "latest_date": dates[0]["date"] if dates else None,
        "dates": dates,
        "months": months,
        "stats": {"total": total, "translated": translated},
        "demo": False,
    }
    write_json(data_dir / "manifest.json", manifest)
    return manifest


def update_data(
    config: dict[str, Any], data_dir: Path, *, target_date: date | None = None, no_translate: bool = False
) -> dict[str, Any]:
    today = datetime.now(timezone.utc).date()
    lookback_days = int(config["fetch"].get("lookback_days", 4))
    start_date = target_date or today - timedelta(days=lookback_days)
    end_date = target_date or today
    categories = list(config["research"]["categories"])
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    print(f"Fetching {', '.join(categories)} from {start_date} to {end_date}", flush=True)
    feed = fetch_arxiv(categories, start_date, end_date, int(config["fetch"]["max_results"]))
    papers = parse_arxiv_feed(feed, config["site"].get("timezone", "Asia/Shanghai"))
    papers = apply_keyword_rules(
        papers,
        config["research"].get("keywords", []),
        config["research"].get("keyword_mode", "highlight"),
    )

    existing_translations = load_existing_translations(data_dir)
    for paper in papers:
        if paper["id"] in existing_translations:
            paper.update(existing_translations[paper["id"]])
    translate_papers(papers, config["ai"], no_translate=no_translate)

    grouped: dict[str, list[dict[str, Any]]] = {}
    for paper in papers:
        grouped.setdefault(paper["announcement_date"], []).append(paper)

    changed_months: set[str] = set()
    for day, day_papers in grouped.items():
        day_path = data_dir / "days" / f"{day}.json"
        previous = read_json(day_path, {}).get("papers", [])
        merged = merge_papers(previous, day_papers)
        write_json(day_path, {"date": day, "updated_at": generated_at, "papers": merged})
        changed_months.add(day[:7])

    for month in changed_months:
        rebuild_month(data_dir, month, generated_at)
    prune_history(data_dir, int(config["fetch"].get("retention_months", 24)), end_date)
    manifest = rebuild_manifest(data_dir, generated_at)
    print(
        f"Stored {len(papers)} fetched papers; archive contains {manifest['stats']['total']} papers",
        flush=True,
    )
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config/settings.json"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--date", type=date.fromisoformat, help="Fetch one UTC submission date (YYYY-MM-DD)")
    parser.add_argument("--no-translate", action="store_true", help="Fetch data without calling the AI API")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = read_json(args.config)
    if not config:
        print(f"Config not found: {args.config}", file=sys.stderr)
        return 1
    update_data(config, args.data_dir, target_date=args.date, no_translate=args.no_translate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
