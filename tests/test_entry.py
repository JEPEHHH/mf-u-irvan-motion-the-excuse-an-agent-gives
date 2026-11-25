#!/usr/bin/env python3
"""Local validation tests for entry.txt output format."""

import os
import unittest


class TestEntryOutput(unittest.TestCase):
    """Validate that entry.txt meets gate requirements."""

    def setUp(self):
        self.output_path = "/output/entry.txt"

    def test_file_exists(self):
        """Entry file must exist."""
        self.assertTrue(os.path.exists(self.output_path), "entry.txt does not exist")

    def test_utf8_encoding(self):
        """Entry must be valid UTF-8."""
        with open(self.output_path, "rb") as f:
            content = f.read()
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as e:
            self.fail(f"entry.txt is not valid UTF-8: {e}")

    def test_single_line(self):
        """Entry must be exactly one line (no newlines)."""
        with open(self.output_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertEqual(content.count("\n"), 0, "entry.txt must be a single line (no newlines)")
        self.assertEqual(content.count("\r"), 0, "entry.txt must not contain carriage returns")

    def test_length_range(self):
        """Entry must be 1-200 characters."""
        with open(self.output_path, "r", encoding="utf-8") as f:
            content = f.read()
        length = len(content)
        self.assertGreaterEqual(length, 1, f"entry.txt must be at least 1 character, got {length}")
        self.assertLessEqual(length, 200, f"entry.txt must be at most 200 characters, got {length}")

    def test_not_only_whitespace(self):
        """Entry must not be only whitespace."""
        with open(self.output_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertTrue(content.strip(), "entry.txt must not be only whitespace")

    def test_deterministic(self):
        """Running main.py twice must produce identical output."""
        import subprocess
        repo_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        result1 = subprocess.run(["python3", "main.py"], capture_output=True, text=True, cwd=repo_dir)
        self.assertEqual(result1.returncode, 0, f"First run failed: {result1.stderr}")
        with open(self.output_path, "r", encoding="utf-8") as f:
            content1 = f.read()
        
        result2 = subprocess.run(["python3", "main.py"], capture_output=True, text=True, cwd=repo_dir)
        self.assertEqual(result2.returncode, 0, f"Second run failed: {result2.stderr}")
        with open(self.output_path, "r", encoding="utf-8") as f:
            content2 = f.read()
        
        self.assertEqual(content1, content2, "Output is not deterministic across runs")


if __name__ == "__main__":
    # Run main.py first to generate entry.txt
    import subprocess
    repo_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(["python3", "main.py"], capture_output=True, text=True, cwd=repo_dir)
    if result.returncode != 0:
        print(f"main.py failed: {result.stderr}")
        exit(1)
    
    unittest.main(verbosity=2)