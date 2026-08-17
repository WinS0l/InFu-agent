import hashlib
import json
import os
import stat
import tempfile
import unittest
import warnings
import zipfile
from contextlib import redirect_stderr
from dataclasses import replace
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.pptx_reference import (
    PPTX_ZIP_LIMITS,
    PptxArchiveLimitError,
    PptxInvalidArchiveError,
    PptxReferenceConflict,
    inspect_element,
    main,
    update_element_text,
    update_element_texts,
)


SLIDE_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="7" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Quarterly review</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:graphicFrame>
      <p:nvGraphicFramePr><p:cNvPr id="8" name="Metrics"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1"/><a:gridCol w="1"/></a:tblGrid>
          <a:tr h="1"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>
"""


def write_fixture(path: Path, slide_xml: str = SLIDE_XML) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("ppt/slides/slide1.xml", slide_xml)


def append_entry(path: Path, name: str, payload: bytes) -> None:
    with zipfile.ZipFile(path, "a", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, payload)


def fingerprint(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def text_fingerprint(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.strip().encode('utf-8')).hexdigest()}"


def reference(path: Path, **overrides):
    value = {
        "sourceFingerprint": fingerprint(path),
        "slidePart": "ppt/slides/slide1.xml",
        "slideIndex": 0,
        "nodeId": "7",
        "nodeType": "shape",
        "nodeName": "Title 1",
        "text": "Quarterly review",
    }
    value.update(overrides)
    return value


class PptxReferenceTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.source = self.root / "source.pptx"
        write_fixture(self.source)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_inspects_shape_by_fingerprint_slide_part_and_node_id(self):
        result = inspect_element(self.source, reference(self.source))

        self.assertEqual(result["nodeType"], "shape")
        self.assertEqual(result["nodeName"], "Title 1")
        self.assertEqual(result["text"], "Quarterly review")

    def test_updates_shape_text_through_validated_temporary_output(self):
        output = self.root / "updated.pptx"
        result = update_element_text(
            self.source,
            output,
            reference(self.source),
            "FY 2027 review",
        )

        self.assertTrue(output.exists())
        self.assertEqual(result["text"], "FY 2027 review")
        self.assertEqual(inspect_element(self.source, reference(self.source))["text"], "Quarterly review")

    def test_updates_exact_table_cell(self):
        output = self.root / "table-updated.pptx"
        table_reference = reference(
            self.source,
            nodeId="8",
            nodeName="Metrics",
            nodeType="table-cell",
            rowIndex=0,
            cellIndex=1,
            text="42",
        )

        result = update_element_text(self.source, output, table_reference, "84")

        self.assertEqual(result["text"], "84")
        with zipfile.ZipFile(output) as archive:
            self.assertIn(b">84<", archive.read("ppt/slides/slide1.xml"))

    def test_updates_multiple_references_from_one_source_revision(self):
        output = self.root / "batch-updated.pptx"
        table_reference = reference(
            self.source,
            nodeId="8",
            nodeName="Metrics",
            nodeType="table-cell",
            rowIndex=0,
            cellIndex=1,
            text="42",
        )

        result = update_element_texts(
            self.source,
            output,
            [
                {"reference": reference(self.source), "text": "FY 2027 review"},
                {"reference": table_reference, "text": "84"},
            ],
        )

        self.assertEqual([item["text"] for item in result["updates"]], ["FY 2027 review", "84"])
        with zipfile.ZipFile(output) as archive:
            slide = archive.read("ppt/slides/slide1.xml")
        self.assertIn(b">FY 2027 review<", slide)
        self.assertIn(b">84<", slide)

    def test_user_context_does_not_change_full_text_fingerprint_guards(self):
        output = self.root / "selected-text-updated.pptx"
        shape_reference = reference(
            self.source,
            selectedText="Quarterly",
            comment="Replace review with summary",
            textFingerprint=text_fingerprint("Quarterly review"),
        )
        table_reference = reference(
            self.source,
            nodeId="8",
            nodeName="Metrics",
            nodeType="table-cell",
            rowIndex=0,
            cellIndex=1,
            text="42",
            selectedText="4",
            comment="Double this value",
            textFingerprint=text_fingerprint("42"),
        )

        self.assertEqual(
            inspect_element(self.source, shape_reference)["text"], "Quarterly review"
        )
        self.assertEqual(inspect_element(self.source, table_reference)["text"], "42")

        result = update_element_texts(
            self.source,
            output,
            [
                {"reference": shape_reference, "text": "Annual review"},
                {"reference": table_reference, "text": "84"},
            ],
        )

        self.assertEqual(
            [item["text"] for item in result["updates"]], ["Annual review", "84"]
        )

    def test_inspect_resolves_the_same_bytes_that_were_fingerprinted(self):
        expected_reference = reference(self.source)
        original_bytes = self.source.read_bytes()

        def read_then_replace(_path):
            write_fixture(self.source, SLIDE_XML.replace("Quarterly review", "Changed elsewhere"))
            return original_bytes

        with patch("scripts.pptx_reference._read_bytes", side_effect=read_then_replace):
            result = inspect_element(self.source, expected_reference)

        self.assertEqual(result["text"], "Quarterly review")

    def test_batch_updates_the_same_bytes_that_were_fingerprinted(self):
        expected_reference = reference(self.source)
        original_bytes = self.source.read_bytes()
        output = self.root / "race-safe.pptx"

        def read_then_replace(_path):
            write_fixture(self.source, SLIDE_XML.replace(">42<", ">99<"))
            return original_bytes

        with patch("scripts.pptx_reference._read_bytes", side_effect=read_then_replace):
            update_element_texts(
                self.source,
                output,
                [{"reference": expected_reference, "text": "FY 2027 review"}],
            )

        with zipfile.ZipFile(output) as archive:
            slide = archive.read("ppt/slides/slide1.xml")
        self.assertIn(b">FY 2027 review<", slide)
        self.assertIn(b">42<", slide)
        self.assertNotIn(b">99<", slide)

    def test_fails_closed_on_changed_source_without_output(self):
        stale_reference = reference(self.source)
        write_fixture(self.source, SLIDE_XML.replace("Quarterly review", "Changed elsewhere"))
        output = self.root / "must-not-exist.pptx"

        with self.assertRaisesRegex(PptxReferenceConflict, "fingerprint"):
            update_element_text(self.source, output, stale_reference, "Unsafe update")

        self.assertFalse(output.exists())

    def test_fails_closed_on_ambiguous_node_id(self):
        duplicate = SLIDE_XML.replace(
            "</p:spTree>",
            "<p:sp><p:nvSpPr><p:cNvPr id=\"7\" name=\"Duplicate\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Duplicate</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>",
        )
        write_fixture(self.source, duplicate)

        with self.assertRaisesRegex(PptxReferenceConflict, "ambiguous"):
            inspect_element(self.source, reference(self.source, nodeName=None, text=None))

    def test_fails_closed_on_text_or_cell_coordinate_conflict(self):
        with self.assertRaisesRegex(PptxReferenceConflict, "text fingerprint"):
            inspect_element(
                self.source,
                reference(self.source, textFingerprint=f"sha256:{'0' * 64}"),
            )
        with self.assertRaisesRegex(PptxReferenceConflict, "coordinate"):
            inspect_element(
                self.source,
                reference(
                    self.source,
                    nodeId="8",
                    nodeName="Metrics",
                    nodeType="table-cell",
                    rowIndex=9,
                    cellIndex=0,
                ),
            )

    def test_cli_json_contract_is_serializable(self):
        result = inspect_element(self.source, reference(self.source))
        self.assertEqual(json.loads(json.dumps(result))["nodeId"], "7")

    def test_rejects_non_pptx_source_and_output_paths(self):
        renamed_source = self.root / "macro-enabled.pptm"
        renamed_source.write_bytes(self.source.read_bytes())
        with self.assertRaisesRegex(ValueError, "source must be a .pptx"):
            inspect_element(renamed_source, reference(renamed_source))

        with self.assertRaisesRegex(ValueError, "output must be a .pptx"):
            update_element_text(
                self.source,
                self.root / "updated.pptm",
                reference(self.source),
                "Unsafe extension",
            )

    def test_rejects_archive_before_reading_when_compressed_source_exceeds_limit(self):
        limits = replace(
            PPTX_ZIP_LIMITS,
            max_archive_bytes=self.source.stat().st_size - 1,
        )

        with patch("scripts.pptx_reference.PPTX_ZIP_LIMITS", limits):
            with self.assertRaisesRegex(PptxArchiveLimitError, "archive bytes"):
                inspect_element(self.source, reference(self.source))

    def test_rejects_entry_count_single_entry_total_and_media_limits(self):
        append_entry(self.source, "ppt/media/image1.bin", b"media")
        expected_reference = reference(self.source)
        with zipfile.ZipFile(self.source) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
        total_bytes = sum(info.file_size for info in infos)

        cases = (
            (replace(PPTX_ZIP_LIMITS, max_entries=len(infos) - 1), "entries"),
            (
                replace(
                    PPTX_ZIP_LIMITS,
                    max_entry_uncompressed_bytes=max(info.file_size for info in infos) - 1,
                ),
                "entry bytes",
            ),
            (
                replace(PPTX_ZIP_LIMITS, max_total_uncompressed_bytes=total_bytes - 1),
                "total uncompressed bytes",
            ),
            (replace(PPTX_ZIP_LIMITS, max_media_bytes=4), "media bytes"),
        )
        for limits, message in cases:
            with self.subTest(message=message):
                with patch("scripts.pptx_reference.PPTX_ZIP_LIMITS", limits):
                    with self.assertRaisesRegex(PptxArchiveLimitError, message):
                        inspect_element(self.source, expected_reference)

    def test_rejects_high_compression_ratio(self):
        append_entry(self.source, "ppt/media/highly-compressed.bin", b"0" * (1024 * 1024))
        limits = replace(PPTX_ZIP_LIMITS, max_compression_ratio=10)

        with patch("scripts.pptx_reference.PPTX_ZIP_LIMITS", limits):
            with self.assertRaisesRegex(PptxArchiveLimitError, "compression ratio"):
                inspect_element(self.source, reference(self.source))

    def test_rejects_duplicate_and_abnormal_entry_names(self):
        cases = (
            ("duplicate", "[Content_Types].xml"),
            ("parent segment", "ppt/media/../escape.bin"),
            ("absolute", "/absolute.bin"),
            ("backslash", "ppt\\media\\image.bin"),
        )
        for label, entry_name in cases:
            with self.subTest(label=label):
                write_fixture(self.source)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    append_entry(self.source, entry_name, b"payload")
                with self.assertRaises(PptxInvalidArchiveError):
                    inspect_element(self.source, reference(self.source))

    def test_rejects_nul_in_raw_entry_name(self):
        entry_name = "ppt/media/xevil.bin"
        append_entry(self.source, entry_name, b"payload")
        source_bytes = self.source.read_bytes()
        encoded_name = entry_name.encode("utf-8")
        self.assertEqual(source_bytes.count(encoded_name), 2)
        self.source.write_bytes(
            source_bytes.replace(encoded_name, b"ppt/media/\x00evil.bin")
        )

        with self.assertRaises(PptxInvalidArchiveError):
            inspect_element(self.source, reference(self.source))

    def test_limit_failure_does_not_create_output_or_leave_temporary_file(self):
        output = self.root / "limited-output.pptx"
        limits = replace(PPTX_ZIP_LIMITS, max_entries=1)

        with patch("scripts.pptx_reference.PPTX_ZIP_LIMITS", limits):
            with self.assertRaises(PptxArchiveLimitError):
                update_element_text(self.source, output, reference(self.source), "Blocked")

        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(f".{output.name}.*.tmp")), [])

    def test_copy_failure_removes_temporary_file(self):
        output = self.root / "copy-failed-output.pptx"

        with patch(
            "scripts.pptx_reference._copy_archive_entry",
            side_effect=OSError("copy failed"),
        ):
            with self.assertRaisesRegex(OSError, "copy failed"):
                update_element_text(self.source, output, reference(self.source), "Blocked")

        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(f".{output.name}.*.tmp")), [])

    def test_update_streams_zip_entries_without_unbounded_reads(self):
        media_payload = os.urandom(128 * 1024)
        append_entry(self.source, "ppt/media/image1.bin", media_payload)
        output = self.root / "streamed-output.pptx"
        original_read = zipfile.ZipExtFile.read
        read_sizes: list[int] = []

        def record_bounded_read(stream, size=-1):
            read_sizes.append(size)
            if size is None or size < 0:
                raise AssertionError("ZIP entries must not be read without a byte bound")
            return original_read(stream, size)

        with patch.object(zipfile.ZipExtFile, "read", record_bounded_read):
            update_element_text(self.source, output, reference(self.source), "Streamed")

        self.assertTrue(read_sizes)
        self.assertTrue(output.exists())
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.read("ppt/media/image1.bin"), media_payload)

    def test_cli_reports_stable_zip_limit_reason(self):
        limits = replace(PPTX_ZIP_LIMITS, max_archive_bytes=1)
        error_output = StringIO()

        with patch("scripts.pptx_reference.PPTX_ZIP_LIMITS", limits):
            with redirect_stderr(error_output):
                exit_code = main(
                    [
                        "inspect",
                        "--source",
                        str(self.source),
                        "--reference",
                        json.dumps(reference(self.source)),
                    ]
                )

        payload = json.loads(error_output.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["error"], "pptx_update_failed")
        self.assertEqual(payload["reason"], "zip_limit_exceeded")

    def test_cli_reports_stable_invalid_zip_entry_reason(self):
        append_entry(self.source, "ppt/media/../escape.bin", b"payload")
        error_output = StringIO()

        with redirect_stderr(error_output):
            exit_code = main(
                [
                    "inspect",
                    "--source",
                    str(self.source),
                    "--reference",
                    json.dumps(reference(self.source)),
                ]
            )

        payload = json.loads(error_output.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["error"], "pptx_update_failed")
        self.assertEqual(payload["reason"], "invalid_zip_entry")

    @unittest.skipIf(os.name == "nt", "Windows does not expose POSIX mode bits")
    def test_atomic_replace_preserves_existing_output_permissions(self):
        output = self.root / "existing-output.pptx"
        output.write_bytes(b"old")
        output.chmod(0o640)

        update_element_text(
            self.source,
            output,
            reference(self.source),
            "Preserve permissions",
        )

        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o640)


if __name__ == "__main__":
    unittest.main()
