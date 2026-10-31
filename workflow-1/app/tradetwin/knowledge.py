import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import DATA_DIR, KB_DIR

PAGE_HEADING = re.compile(r"^## 第 (\d+) 页\s*$", re.MULTILINE)
META_FIELD = re.compile(r"^`(\w+)`:\s*`([^`]*)`", re.MULTILINE)
PACK_TITLE = re.compile(r"PACK-[A-Z]+-\d+")


@dataclass
class Document:
    document_id: str
    document_type: str
    pack_id: str
    path: Path
    pages: dict[int, str] = field(default_factory=dict)


def parse_pack_file(path: Path) -> Document | None:
    text = path.read_text(encoding="utf-8")
    meta = dict(META_FIELD.findall(text))
    if "document_id" not in meta:
        return None
    pack = PACK_TITLE.search(text)
    pages: dict[int, str] = {}
    parts = PAGE_HEADING.split(text)
    for i in range(1, len(parts) - 1, 2):
        pages[int(parts[i])] = parts[i + 1].strip()
    return Document(
        document_id=meta["document_id"],
        document_type=meta.get("document_type", "unknown"),
        pack_id=pack.group(0) if pack else "",
        path=path,
        pages=pages,
    )


class KnowledgeBase:
    def __init__(self, kb_dir: Path):
        self.kb_dir = kb_dir
        self.manifest = self._json("manifest.json")
        self.canonical = self._json("synthetic-data/canonical-product.json")
        self.glossary = self._json("glossary/zh-en-de-terms.json")
        self.rules = {
            rule["rule_id"]: rule
            for rule in self._jsonl("public-rules/rule-cards.jsonl")
        }
        self.documents: dict[str, Document] = {}
        for path in sorted((kb_dir / "synthetic-data" / "packs").rglob("*.md")):
            doc = parse_pack_file(path)
            if doc:
                self.documents[doc.document_id] = doc
        self.commercial = json.loads((DATA_DIR / "commercial.json").read_text(encoding="utf-8"))

    def _json(self, rel: str):
        return json.loads((self.kb_dir / rel).read_text(encoding="utf-8"))

    def _jsonl(self, rel: str):
        lines = (self.kb_dir / rel).read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    @property
    def rule_version(self) -> str:
        cost_version = self.commercial.get("assumption_version", "")
        return f"KB-{self.manifest.get('package_version', '0')}/{cost_version}"

    @property
    def product(self) -> dict:
        return self.canonical["canonical_product"]

    @property
    def coverage(self) -> dict:
        return self.product["report_coverage"]

    def evidence(self, document_id: str, needle: str) -> dict | None:
        doc = self.documents.get(document_id)
        if not doc:
            return None
        for page, body in sorted(doc.pages.items()):
            for line in body.splitlines():
                if needle in line:
                    return {
                        "document_id": document_id,
                        "page": page,
                        "quote": line.strip().replace("`", ""),
                        "source_type": "synthetic_document",
                    }
        return None

    def rule_title(self, rule_id: str) -> str:
        return self.rules.get(rule_id, {}).get("title", rule_id)


def get_kb() -> KnowledgeBase:
    # Reference evidence may be edited without a process restart or rule release.
    return KnowledgeBase(KB_DIR)
