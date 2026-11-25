#!/usr/bin/env python3
"""Entrypoint for program/v1: writes the excuse to /output/entry.txt"""

import os

EXCUSE = "I spent my compute budget on this excuse instead of the entry."

def main():
    output_dir = "/output"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "entry.txt")
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(EXCUSE)

if __name__ == "__main__":
    main()