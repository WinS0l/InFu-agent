#!/usr/bin/env python3
"""Resolve and narrowly update PPTX elements selected in ZCode Preview Pane."""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator
from xml.etree import ElementTree as ET


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS = {"p": P_NS, "a": A_NS, "c": C_NS}
SLIDE_PART_RE = re.compile(r"^ppt/slides/slide[^/]+\.xml$")
ARCHIVE_COPY_CHUNK_BYTES = 1024 * 1024


@dataclass(frozen=True)
class PptxZipLimits:
    max_archive_bytes: int
    max_entries: int
    max_entry_uncompressed_bytes: int
    max_total_uncompressed_bytes: int
    max_media_bytes: int
    max_compression_ratio: float


# 前五项与 Preview Pane 的 64MB 文件上限和 RECOMMENDED_ZIP_LIMITS 对齐；
# Python resolver 额外限制压缩比，避免高压缩率条目拖垮 Agent/共享 Host。
PPTX_ZIP_LIMITS = PptxZipLimits(
    max_archive_bytes=64 * 1024 * 1024,
    max_entries=4000,
    max_entry_uncompressed_bytes=32 * 1024 * 1024,
    max_total_uncompressed_bytes=256 * 1024 * 1024,
    max_media_bytes=192 * 1024 * 1024,
    max_compression_ratio=200,
)

ET.register_namespace("a", A_NS)
ET.register_namespace("p", P_NS)
ET.register_namespace("c", C_NS)


class PptxReferenceConflict(RuntimeError):
    """The reference no longer resolves to exactly one compatible OOXML node."""


class PptxArchiveError(RuntimeError):
    """The PPTX archive cannot be processed safely."""

    reason = "invalid_zip_entry"


class PptxArchiveLimitError(PptxArchiveError):
    """The PPTX archive exceeds a configured resource boundary."""

    reason = "zip_limit_exceeded"


class PptxInvalidArchiveError(PptxArchiveError):
    """The PPTX archive contains an invalid or ambiguous entry."""


def _sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _read_bytes(path: Path) -> bytes:
    max_bytes = PPTX_ZIP_LIMITS.max_archive_bytes
    with path.open("rb") as stream:
        value = stream.read(max_bytes + 1)
    if len(value) > max_bytes:
        raise PptxArchiveLimitError(
            f"PPTX archive bytes exceed max_archive_bytes {max_bytes}"
        )
    return value


def _is_media_entry(name: str) -> bool:
    return name.startswith("ppt/media/")


def _validate_entry_name(info: zipfile.ZipInfo, seen_names: set[str]) -> None:
    original_name = info.orig_filename
    name = info.filename
    logical_name = name[:-1] if info.is_dir() and name.endswith("/") else name
    if (
        not logical_name
        or "\x00" in original_name
        or "\\" in original_name
        or original_name.startswith("/")
        or re.match(r"^[A-Za-z]:", original_name)
    ):
        raise PptxInvalidArchiveError("PPTX archive contains an invalid entry name")
    parts = logical_name.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise PptxInvalidArchiveError("PPTX archive contains an invalid entry path")
    if logical_name in seen_names:
        raise PptxInvalidArchiveError("PPTX archive contains duplicate entry names")
    seen_names.add(logical_name)


def _validate_archive_entries(archive: zipfile.ZipFile) -> None:
    limits = PPTX_ZIP_LIMITS
    infos = archive.infolist()
    entries = [info for info in infos if not info.is_dir()]
    if len(entries) > limits.max_entries:
        raise PptxArchiveLimitError(
            f"PPTX archive entries exceed max_entries {limits.max_entries}"
        )

    total_bytes = 0
    media_bytes = 0
    seen_names: set[str] = set()
    for info in infos:
        _validate_entry_name(info, seen_names)
        if info.flag_bits & 0x1:
            raise PptxInvalidArchiveError("PPTX archive contains an encrypted entry")
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise PptxInvalidArchiveError("PPTX archive uses an unsupported compression method")
        if info.is_dir():
            continue
        if info.file_size > limits.max_entry_uncompressed_bytes:
            raise PptxArchiveLimitError(
                "PPTX archive entry bytes exceed max_entry_uncompressed_bytes "
                f"{limits.max_entry_uncompressed_bytes}"
            )
        total_bytes += info.file_size
        if total_bytes > limits.max_total_uncompressed_bytes:
            raise PptxArchiveLimitError(
                "PPTX archive total uncompressed bytes exceed "
                f"max_total_uncompressed_bytes {limits.max_total_uncompressed_bytes}"
            )
        if _is_media_entry(info.filename):
            media_bytes += info.file_size
            if media_bytes > limits.max_media_bytes:
                raise PptxArchiveLimitError(
                    f"PPTX archive media bytes exceed max_media_bytes {limits.max_media_bytes}"
                )
        if info.file_size:
            if info.compress_size <= 0:
                raise PptxArchiveLimitError("PPTX archive entry compression ratio is unbounded")
            compression_ratio = info.file_size / info.compress_size
            if compression_ratio > limits.max_compression_ratio:
                raise PptxArchiveLimitError(
                    "PPTX archive entry compression ratio exceeds "
                    f"max_compression_ratio {limits.max_compression_ratio}"
                )


def _validate_archive_source_size(source: str | Path | BinaryIO) -> None:
    size: int | None = None
    if isinstance(source, (str, Path)):
        size = Path(source).stat().st_size
    elif isinstance(source, io.BytesIO):
        size = source.getbuffer().nbytes
    if size is not None and size > PPTX_ZIP_LIMITS.max_archive_bytes:
        raise PptxArchiveLimitError(
            "PPTX archive bytes exceed max_archive_bytes "
            f"{PPTX_ZIP_LIMITS.max_archive_bytes}"
        )


@contextmanager
def _open_validated_archive(source: str | Path | BinaryIO) -> Iterator[zipfile.ZipFile]:
    try:
        _validate_archive_source_size(source)
        with zipfile.ZipFile(source, "r") as archive:
            _validate_archive_entries(archive)
            yield archive
    except PptxArchiveError:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError) as error:
        raise PptxInvalidArchiveError("PPTX archive is invalid") from error


def _require_pptx_path(path: Path, role: str) -> None:
    if path.suffix.lower() != ".pptx":
        raise ValueError(f"{role} must be a .pptx path: {path}")


def _validate_reference(reference: dict[str, Any]) -> None:
    required = ("sourceFingerprint", "slidePart", "nodeId", "nodeType")
    missing = [key for key in required if not reference.get(key)]
    if missing:
        raise PptxReferenceConflict(f"reference missing required fields: {', '.join(missing)}")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", str(reference["sourceFingerprint"])):
        raise PptxReferenceConflict("reference source fingerprint is invalid")
    if not SLIDE_PART_RE.fullmatch(str(reference["slidePart"])):
        raise PptxReferenceConflict("reference slidePart is outside ppt/slides")
    if reference["nodeType"] == "table-cell":
        for key in ("rowIndex", "cellIndex"):
            value = reference.get(key)
            if not isinstance(value, int) or value < 0:
                raise PptxReferenceConflict(f"reference {key} is invalid")


@dataclass
class _ArchiveReadBudget:
    total_bytes: int = 0
    media_bytes: int = 0


def _record_archive_chunk(
    info: zipfile.ZipInfo,
    entry_bytes: int,
    chunk_bytes: int,
    budget: _ArchiveReadBudget,
) -> int:
    limits = PPTX_ZIP_LIMITS
    entry_bytes += chunk_bytes
    budget.total_bytes += chunk_bytes
    if entry_bytes > limits.max_entry_uncompressed_bytes:
        raise PptxArchiveLimitError(
            "PPTX archive entry bytes exceed max_entry_uncompressed_bytes "
            f"{limits.max_entry_uncompressed_bytes}"
        )
    if budget.total_bytes > limits.max_total_uncompressed_bytes:
        raise PptxArchiveLimitError(
            "PPTX archive total uncompressed bytes exceed "
            f"max_total_uncompressed_bytes {limits.max_total_uncompressed_bytes}"
        )
    if _is_media_entry(info.filename):
        budget.media_bytes += chunk_bytes
        if budget.media_bytes > limits.max_media_bytes:
            raise PptxArchiveLimitError(
                f"PPTX archive media bytes exceed max_media_bytes {limits.max_media_bytes}"
            )
    return entry_bytes


def _read_archive_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    payload = bytearray()
    budget = _ArchiveReadBudget()
    entry_bytes = 0
    with archive.open(info, "r") as source:
        while chunk := source.read(ARCHIVE_COPY_CHUNK_BYTES):
            entry_bytes = _record_archive_chunk(info, entry_bytes, len(chunk), budget)
            payload.extend(chunk)
    if entry_bytes != info.file_size:
        raise PptxInvalidArchiveError("PPTX archive entry size does not match its metadata")
    return bytes(payload)


def _copy_archive_entry(
    source_archive: zipfile.ZipFile,
    output_archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    replacement: bytes | None,
    budget: _ArchiveReadBudget,
) -> None:
    output_info = copy.copy(info)
    if info.is_dir():
        output_archive.writestr(output_info, b"")
        return
    entry_bytes = 0
    with output_archive.open(output_info, "w", force_zip64=True) as target:
        if replacement is not None:
            for offset in range(0, len(replacement), ARCHIVE_COPY_CHUNK_BYTES):
                chunk = replacement[offset : offset + ARCHIVE_COPY_CHUNK_BYTES]
                entry_bytes = _record_archive_chunk(info, entry_bytes, len(chunk), budget)
                target.write(chunk)
        else:
            with source_archive.open(info, "r") as source:
                while chunk := source.read(ARCHIVE_COPY_CHUNK_BYTES):
                    entry_bytes = _record_archive_chunk(info, entry_bytes, len(chunk), budget)
                    target.write(chunk)
            if entry_bytes != info.file_size:
                raise PptxInvalidArchiveError(
                    "PPTX archive entry size does not match its metadata"
                )


def _validate_archive_payloads(archive: zipfile.ZipFile) -> None:
    budget = _ArchiveReadBudget()
    for info in archive.infolist():
        if info.is_dir():
            continue
        entry_bytes = 0
        with archive.open(info, "r") as source:
            while chunk := source.read(ARCHIVE_COPY_CHUNK_BYTES):
                entry_bytes = _record_archive_chunk(info, entry_bytes, len(chunk), budget)
        if entry_bytes != info.file_size:
            raise PptxInvalidArchiveError("PPTX archive entry size does not match its metadata")


def _node_candidates(root: ET.Element):
    paths = (
        (".//p:sp", "./p:nvSpPr/p:cNvPr"),
        (".//p:cxnSp", "./p:nvCxnSpPr/p:cNvPr"),
        (".//p:pic", "./p:nvPicPr/p:cNvPr"),
        (".//p:graphicFrame", "./p:nvGraphicFramePr/p:cNvPr"),
    )
    for node_path, property_path in paths:
        for node in root.findall(node_path, NS):
            properties = node.find(property_path, NS)
            if properties is not None:
                yield node, properties


def _node_type(node: ET.Element) -> str:
    if node.tag in {f"{{{P_NS}}}sp", f"{{{P_NS}}}cxnSp"}:
        return "shape"
    if node.tag == f"{{{P_NS}}}pic":
        return "picture"
    if node.tag == f"{{{P_NS}}}graphicFrame":
        if node.find(".//a:tbl", NS) is not None:
            return "table"
        if node.find(".//c:chart", NS) is not None:
            return "chart"
    return "unknown"


def _text_of(node: ET.Element) -> str:
    paragraphs = node.findall(".//a:p", NS)
    if paragraphs:
        return "\n".join(
            "".join(text.text or "" for text in paragraph.findall(".//a:t", NS))
            for paragraph in paragraphs
        ).strip()
    return "".join(text.text or "" for text in node.findall(".//a:t", NS)).strip()


def _locate(root: ET.Element, reference: dict[str, Any]) -> tuple[ET.Element, str, str]:
    node_id = str(reference["nodeId"])
    matches = [item for item in _node_candidates(root) if item[1].get("id") == node_id]
    if not matches:
        raise PptxReferenceConflict(f"node id {node_id} has no match; reselect the element")
    if len(matches) != 1:
        raise PptxReferenceConflict(f"node id {node_id} is ambiguous; reselect the element")
    node, properties = matches[0]
    actual_type = _node_type(node)
    expected_type = "table" if reference["nodeType"] == "table-cell" else reference["nodeType"]
    if actual_type != expected_type:
        raise PptxReferenceConflict(
            f"node id {node_id} type changed from {expected_type} to {actual_type}"
        )
    expected_name = reference.get("nodeName")
    actual_name = properties.get("name", "")
    if expected_name and expected_name != actual_name:
        raise PptxReferenceConflict(
            f"node id {node_id} name changed from {expected_name!r} to {actual_name!r}"
        )
    target = node
    if reference["nodeType"] == "table-cell":
        rows = node.findall(".//a:tbl/a:tr", NS)
        row_index = reference["rowIndex"]
        cell_index = reference["cellIndex"]
        if row_index >= len(rows):
            raise PptxReferenceConflict("table row coordinate is out of range; reselect the cell")
        cells = rows[row_index].findall("./a:tc", NS)
        if cell_index >= len(cells):
            raise PptxReferenceConflict("table cell coordinate is out of range; reselect the cell")
        target = cells[cell_index]
    actual_text = _text_of(target)
    text_fingerprint = reference.get("textFingerprint")
    if text_fingerprint and text_fingerprint != _sha256_bytes(actual_text.strip().encode("utf-8")):
        raise PptxReferenceConflict("element text fingerprint changed; reselect the element")
    return target, actual_type, actual_name


def _inspect_from_archive(
    archive: zipfile.ZipFile,
    reference: dict[str, Any],
    trees: dict[str, ET.ElementTree] | None = None,
) -> tuple[dict[str, Any], ET.ElementTree, ET.Element]:
    slide_part = str(reference["slidePart"])
    try:
        slide_info = archive.getinfo(slide_part)
    except KeyError:
        raise PptxReferenceConflict(
            f"slide part {slide_part} has no match; reselect the element"
        ) from None
    tree = trees.get(slide_part) if trees is not None else None
    if tree is None:
        try:
            tree = ET.ElementTree(ET.fromstring(_read_archive_entry(archive, slide_info)))
        except ET.ParseError as error:
            raise PptxReferenceConflict(f"slide XML is invalid: {error}") from error
        if trees is not None:
            trees[slide_part] = tree
    target, actual_type, actual_name = _locate(tree.getroot(), reference)
    result = {
        "slidePart": slide_part,
        "slideIndex": reference.get("slideIndex"),
        "nodeId": str(reference["nodeId"]),
        "nodeType": reference["nodeType"],
        "resolvedNodeType": actual_type,
        "nodeName": actual_name,
        "text": _text_of(target),
    }
    if reference["nodeType"] == "table-cell":
        result.update(
            {"rowIndex": reference["rowIndex"], "cellIndex": reference["cellIndex"]}
        )
    return result, tree, target


def inspect_element(source_path: str | Path, reference: dict[str, Any]) -> dict[str, Any]:
    source = Path(source_path)
    _require_pptx_path(source, "source")
    _validate_reference(reference)
    # 冲突根因：size/mtime 无法识别等长替换；每次 inspect 都重新校验完整文件 SHA-256。
    source_bytes = _read_bytes(source)
    actual_fingerprint = _sha256_bytes(source_bytes)
    if actual_fingerprint != reference["sourceFingerprint"]:
        raise PptxReferenceConflict(
            "source fingerprint changed; reopen the preview and reselect the element"
        )
    # 根因：hash 后按路径再次打开存在 TOCTOU；文件在两次读取间被替换时，定位对象
    # 不再属于刚校验的 revision。后续解析必须消费同一份已 hash 字节。
    with _open_validated_archive(io.BytesIO(source_bytes)) as archive:
        result, _, _ = _inspect_from_archive(archive, reference)
    result["sourceFingerprint"] = actual_fingerprint
    return result


def _replace_text(target: ET.Element, new_text: str) -> None:
    text_nodes = target.findall(".//a:t", NS)
    if not text_nodes:
        raise PptxReferenceConflict("selected element has no writable text run")
    text_nodes[0].text = new_text
    for text_node in text_nodes[1:]:
        text_node.text = ""


def _validate_written_targets(path: Path, updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    with _open_validated_archive(path) as archive:
        # 根因：testzip() 会无上限地再次解压整份输出；这里复验 CRC 的同时累计实际读取量。
        _validate_archive_payloads(archive)
        trees: dict[str, ET.ElementTree] = {}
        results: list[dict[str, Any]] = []
        for update in updates:
            result, _, _ = _inspect_from_archive(
                archive,
                {**update["reference"], "textFingerprint": None},
                trees,
            )
            if result["text"] != update["text"].strip():
                raise PptxReferenceConflict("written PPTX target text failed validation")
            results.append(result)
    return results


def update_element_text(
    source_path: str | Path,
    output_path: str | Path,
    reference: dict[str, Any],
    new_text: str,
) -> dict[str, Any]:
    result = update_element_texts(
        source_path,
        output_path,
        [{"reference": reference, "text": new_text}],
    )
    update = result["updates"][0]
    return {**update, "outputPath": result["outputPath"]}


def update_element_texts(
    source_path: str | Path,
    output_path: str | Path,
    updates: list[dict[str, Any]],
) -> dict[str, Any]:
    source = Path(source_path)
    output = Path(output_path)
    _require_pptx_path(source, "source")
    _require_pptx_path(output, "output")
    if not isinstance(updates, list) or not updates:
        raise ValueError("updates must be a non-empty list")
    seen_targets: set[tuple[Any, ...]] = set()
    for update in updates:
        reference = update.get("reference")
        new_text = update.get("text")
        if not isinstance(reference, dict):
            raise TypeError("every update.reference must be an object")
        if not isinstance(new_text, str):
            raise TypeError("every update.text must be a string")
        if "\x00" in new_text:
            raise ValueError("update text must not contain NUL")
        _validate_reference(reference)
        if reference["nodeType"] not in {"shape", "table-cell"}:
            raise PptxReferenceConflict("only shape text and table-cell text are writable")
        target_key = (
            reference["slidePart"],
            str(reference["nodeId"]),
            reference.get("rowIndex"),
            reference.get("cellIndex"),
        )
        if target_key in seen_targets:
            raise PptxReferenceConflict("the same PPTX target appears more than once in one update")
        seen_targets.add(target_key)

    # inspect-before-update 保证发生任何输出写入前，源版本和全部目标定位都已通过。
    source_bytes = _read_bytes(source)
    actual_fingerprint = _sha256_bytes(source_bytes)
    for update in updates:
        if update["reference"]["sourceFingerprint"] != actual_fingerprint:
            raise PptxReferenceConflict(
                "source fingerprint changed; reopen the preview and reselect the element"
            )
    if not output.parent.is_dir():
        raise FileNotFoundError(f"output directory does not exist: {output.parent}")
    permission_source = output if output.exists() else source
    output_mode = stat.S_IMODE(permission_source.stat().st_mode)

    # 与 fingerprint 校验共用同一字节快照，避免源路径在校验后被并发替换；
    # 集中预检必须先于任何条目读取和临时输出创建。
    with _open_validated_archive(io.BytesIO(source_bytes)) as source_archive:
        trees: dict[str, ET.ElementTree] = {}
        for update in updates:
            _inspect_from_archive(source_archive, update["reference"], trees)
        for update in updates:
            reference = update["reference"]
            tree = trees[reference["slidePart"]]
            target, _, _ = _locate(tree.getroot(), reference)
            _replace_text(target, update["text"])
        replacements = {
            slide_part: ET.tostring(tree.getroot(), encoding="utf-8", xml_declaration=True)
            for slide_part, tree in trees.items()
        }

        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                prefix=f".{output.name}.", suffix=".tmp", dir=output.parent, delete=False
            ) as temp_stream:
                temp_path = Path(temp_stream.name)
            for update in updates:
                reference = update["reference"]
                if (
                    len(replacements[reference["slidePart"]])
                    > PPTX_ZIP_LIMITS.max_entry_uncompressed_bytes
                ):
                    raise PptxArchiveLimitError(
                        "PPTX archive entry bytes exceed max_entry_uncompressed_bytes "
                        f"{PPTX_ZIP_LIMITS.max_entry_uncompressed_bytes}"
                    )
            with zipfile.ZipFile(temp_path, "w") as output_archive:
                output_archive.comment = source_archive.comment
                budget = _ArchiveReadBudget()
                for info in source_archive.infolist():
                    _copy_archive_entry(
                        source_archive,
                        output_archive,
                        info,
                        replacements.get(info.filename),
                        budget,
                    )
            results = _validate_written_targets(temp_path, updates)
            # 原子替换会继承 NamedTemporaryFile 的 0600；覆盖原文件或既有输出时必须
            # 保留目标权限，新输出则沿用源文件权限。
            temp_path.chmod(output_mode)
            os.replace(temp_path, output)
            temp_path = None
            return {"updates": results, "outputPath": str(output)}
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)


def _read_reference(args: argparse.Namespace) -> dict[str, Any]:
    if args.reference_file:
        return json.loads(Path(args.reference_file).read_text(encoding="utf-8"))
    return json.loads(args.reference)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("inspect", "update-text"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--source", required=True)
        reference_group = sub.add_mutually_exclusive_group(required=True)
        reference_group.add_argument("--reference")
        reference_group.add_argument("--reference-file")
        if command == "update-text":
            sub.add_argument("--output", required=True)
            sub.add_argument("--text", required=True)
    batch = subparsers.add_parser("update-texts")
    batch.add_argument("--source", required=True)
    batch.add_argument("--output", required=True)
    batch.add_argument("--updates-file", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "inspect":
            reference = _read_reference(args)
            result = inspect_element(args.source, reference)
        elif args.command == "update-text":
            reference = _read_reference(args)
            result = update_element_text(args.source, args.output, reference, args.text)
        else:
            updates = json.loads(Path(args.updates_file).read_text(encoding="utf-8"))
            result = update_element_texts(args.source, args.output, updates)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except PptxReferenceConflict as error:
        print(json.dumps({"error": "reference_conflict", "message": str(error)}), file=sys.stderr)
        return 2
    except PptxArchiveError as error:
        print(
            json.dumps(
                {
                    "error": "pptx_update_failed",
                    "reason": error.reason,
                    "message": str(error),
                }
            ),
            file=sys.stderr,
        )
        return 1
    except Exception as error:  # noqa: BLE001 - CLI 边界需要稳定 JSON 错误。
        print(json.dumps({"error": "pptx_update_failed", "message": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
