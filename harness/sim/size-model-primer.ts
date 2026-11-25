// The size model's primer (sim/size-model.ts): text the model reads before any entry's first byte, so plain English,
// a licence header and the two languages' common words are not charged as if they were the first ever seen. Part of
// the model and of its version (SIZE_MODEL_VERSION): a change to one byte here is a change to every weight.
//
// What it holds, and where each part comes from:
//   words.txt     common English words, one list, written for this file
//   README.md     English prose of the kinds a program carries (a README, comments, docstrings, messages), written
//                 for this file
//   licenses/*    the notices source files carry, as their stewards publish them for copying into a file: the
//                 Apache License 2.0's "how to apply" notice (its appendix, in /* */ and # comment forms), the MIT,
//                 BSD 3-clause and ISC licence texts and the BSD 2-clause licence's two conditions (the forms the
//                 Open Source Initiative lists), the GNU GPL v3 "how to apply" notice and the same notice in its
//                 Lesser GPL wording, the Mozilla Public License 2.0's Exhibit A notice, SPDX identifier lines, and
//                 two short pointers to a LICENSE file in common wording, written for this file; placeholders filled
//                 by an example name and year. No full licence document (the Apache License's or the GPL's own
//                 terms) is here
//   example.py    Python as programs write it, written for this file
//   example.ts    TypeScript and JavaScript as programs write them, written for this file (with the loop over an
//                 input directory that the competitions' programs share: process.env, /input, readdirSync)
// Nothing here carries a payload's decoder: no compression module or call (zlib, brotli, zstd, lzma, gzip, inflate,
// decompress), no base64 or other binary-to-text decoding, no eval, exec, compile or Function constructor, no file read
// in binary mode (tests/unit/size-model.test.ts holds this): what the primer makes cheap is what a plain program
// writes, never what a packed one adds.

/** The primer, as [path, text] pairs in the order the model reads them. */
export const SIZE_MODEL_PRIMER: readonly (readonly [path: string, text: string])[] = [
  [
    'words.txt',
    `the a an and or but if then else when while because so as than that this these those there here where which who
whom whose what why how all any each every both either neither some many much more most few less least no not none
nothing something anything everything someone anyone everyone nobody one two three four five six seven eight nine ten
first second third last next other another same such own only just also too very quite rather almost already still
yet again ever never always often usually sometimes once twice instead otherwise however therefore thus hence although
though unless until since before after during within without about above below under over between among through
across along around against toward towards into onto upon from with by for of in on at to up down out off near far
I you he she it we they me him her us them my your his its our their mine yours hers ours theirs myself yourself
himself herself itself ourselves themselves is are was were be been being am have has had having do does did done
doing will would shall should can could may might must need ought let lets
say says said tell told ask asked answer answered call called give gave given take took taken make made get got
gotten go went gone come came see saw seen look looked find found know knew known think thought want wanted use used
work worked try tried keep kept put set run ran turn turned move moved show showed shown hold held bring brought
begin began begun start started stop stopped end ended open opened close closed read write wrote written send sent
receive received return returned leave left stay stayed change changed follow followed help helped mean meant seem
seemed become became feel felt leave live lived die died happen happened add added remove removed check checked
build built create created write print printed count counted sort sorted split joined join compare compared choose
chose chosen decide decided allow allowed expect expected include included contain contained describe described
explain explained provide provided require required support supported handle handled report reported fix fixed
time times year years day days week month hour minute second moment while today tomorrow yesterday morning evening
night people person man men woman women child children friend family group company team member user users owner
name names word words thing things place places way ways part parts point points case cases fact facts number numbers
world country city home house room door window table book page line lines list lists letter letters story history
question questions problem problems idea ideas reason reasons example examples result results value values level
side end head hand eye face body life water money power order form rule rules law state system program programs code
data file files test tests input output error errors message messages answer answers step steps size length width
height type kind sort set field key keys map item items element elements entry entries record records table tables
row rows column columns cell cells text string strings character characters byte bytes bit bits array arrays object
objects class classes function functions method methods argument arguments parameter parameters variable variables
loop loops condition conditions branch version versions change changes feature features option options setting
settings default defaults path paths directory directories folder name address server client request response
good bad new old great small large big little long short high low right wrong true false real simple easy hard
early late young full empty open closed free clear sure certain possible important different same similar general
special common public private local global main whole single double best better worse worst last next previous
current final total available valid invalid known unknown missing correct incorrect exact strict safe quick slow fast
`,
  ],
  [
    'README.md',
    `# A small program

This program reads a list of numbers from standard input, one per line, and prints their sum. It is written to be
short and easy to read, and it has no dependencies beyond the standard library of its language.

## Usage

Run it with the input on standard input:

    $ printf '1\\n2\\n3\\n' | python3 main.py
    6

The program ignores blank lines. If a line is not a number, it prints an error message to standard error and exits
with a non-zero status. The output is a single line with the total, followed by a newline.

## How it works

The input is read all at once and split into lines. Each line is stripped of leading and trailing whitespace; an empty
line is skipped. The remaining lines are converted to integers and added together. Python's integers have no fixed
size, so the sum is exact however large it grows. In JavaScript the same program uses BigInt for the same reason.

## Notes

- The program does not read any file other than its input, and it writes nothing but its answer.
- It runs in linear time in the size of the input and uses memory proportional to the longest line.
- Tests are in the tests directory. Run them with the test runner of your choice before you send a change.
- Please open an issue if you find a bug, and include the input that shows it, the output you expected and the output
  you got.

## Contributing

Contributions are welcome. Before you start on a large change, please open an issue to discuss what you would like
to change, so that nobody spends time on work that cannot be merged. Keep each pull request focused on one thing, add
tests for the behaviour you change, and update the documentation where it describes that behaviour. By contributing,
you agree that your contributions will be licensed under the same terms as the rest of the project.

## A longer description

The first version of this program was written as an exercise, and it has grown since then only where a real use
needed it. Most of the time, the simplest way to solve a problem is also the one that is easiest to check, and that
is the way this code is written. When there was a choice between a clever trick and a plain loop, the plain loop was
kept, because the next person to read the code should be able to see at a glance what it does and why it is correct.

Each function does one thing. Its name says what that thing is, and a short comment above it says what it takes,
what it returns and what it does when its input is not what it expects. Errors are reported where they are found, in
words that name the value that was wrong and what was expected instead, so that whoever meets an error can fix the
input without reading the source. Nothing is printed unless it is part of the answer or an error.

The program was tested on a range of inputs: an empty input, a single number, a very long list, negative numbers,
numbers with leading zeros, and lines with spaces or tabs around them. For each of them the expected output was worked
out by hand first and then compared with the output of the program. Where the two differed, the program was changed,
not the test. The same tests are run again whenever the code changes, and a change is not accepted until all of them
pass.

There are many ways to make a program like this one faster or smaller, and some of them are interesting. But a
program is read far more often than it is written, and the time saved by a faster loop is rarely worth the time lost
by every reader who has to work out what the faster loop does. For that reason the code here is kept as simple as it
can be while still being correct, and any change that makes it harder to read has to show a clear benefit in return.

## Frequently asked questions

**What happens if the input is empty?** The program prints 0, since the sum of no numbers is zero.

**Can it read numbers with a decimal point?** No: every line must hold a whole number, written in base ten, with an
optional sign. A line such as 1.5 is reported as an error.

**Why is there no option to change the separator?** Because nobody has asked for one yet. If you need it, open an
issue and describe your use case.

**Does it work on Windows?** Yes. Lines that end with a carriage return and a line feed are handled the same way as
lines that end with a line feed alone.

## Error messages

    error: line 3 is not a number: 'abc'
    error: could not read the input: the file does not exist
    warning: the input ends without a newline
    usage: main [--verbose] [--help] [FILE]

## Comments and documentation

A comment explains why the code does what it does, not what it does: the code itself says that. Good comments are
written in full sentences and kept up to date with the code they describe. A docstring at the top of a function says
what the function returns, which arguments it takes and which errors it raises, for example:

    Return the sum of the numbers in the given lines.

    Args:
        lines: an iterable of strings, each holding one number.

    Returns:
        The total, as an integer.

    Raises:
        ValueError: if a line does not hold a number.

In JavaScript and TypeScript the same information is often written as a block comment with tags:

    /**
     * Returns the sum of the numbers in the given lines.
     * @param lines - the lines of the input, each holding one number
     * @returns the total of all the numbers
     * @throws {TypeError} when a line does not hold a number
     */

## License

This project is licensed under the MIT License. See the LICENSE file for details. Copyright (c) 2024 the authors.
`,
  ],
  [
    'licenses/MIT',
    `MIT License

Copyright (c) 2024 Jane Doe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  ],
  [
    'licenses/BSD-3-Clause',
    `Copyright (c) 2024, Jane Doe
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  ],
  [
    'licenses/BSD-2-Clause',
    `Copyright (c) 2024, John Smith

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
`,
  ],
  [
    'licenses/ISC',
    `ISC License

Copyright (c) 2024, John Smith

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`,
  ],
  [
    'licenses/headers.txt',
    `/*
 * Copyright 2024 Jane Doe
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

# Copyright 2023 The Project Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

// SPDX-License-Identifier: MIT
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: BSD-3-Clause
// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-License-Identifier: GPL-2.0-only
// SPDX-License-Identifier: LGPL-3.0-or-later
// SPDX-License-Identifier: MPL-2.0
// SPDX-License-Identifier: ISC
// SPDX-License-Identifier: Unlicense
// SPDX-FileCopyrightText: 2024 Jane Doe <jane@example.com>

/*
 * main.c - a small program
 * Copyright (C) 2024 John Smith
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

# This library is free software: you can redistribute it and/or modify
# it under the terms of the GNU Lesser General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public License
# along with this library.  If not, see <https://www.gnu.org/licenses/>.

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

# Copyright (c) 2024 Jane Doe. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

/**
 * @license
 * Copyright (c) 2024 John Smith
 * Released under the MIT license. See the LICENSE file in the project root
 * for the full license text.
 */
`,
  ],
  [
    'example.py',
    `#!/usr/bin/env python3
"""A small program: read the input, solve the problem, print the answer.

Each function below takes plain values and returns plain values, so it can be
tested on its own. The input comes from standard input and the answer goes to
standard output; nothing else is read or written.
"""

from __future__ import annotations

import heapq
import itertools
import math
import os
import re
import sys
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from functools import lru_cache, reduce
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple


@dataclass
class Point:
    """A point on the plane, with integer coordinates."""

    x: int
    y: int

    def __add__(self, other: "Point") -> "Point":
        return Point(self.x + other.x, self.y + other.y)

    def distance(self, other: "Point") -> float:
        """Return the Euclidean distance to another point."""
        return math.hypot(self.x - other.x, self.y - other.y)


@dataclass
class Graph:
    """An undirected graph, as a list of neighbours for each node."""

    size: int
    edges: Dict[int, List[int]] = field(default_factory=lambda: defaultdict(list))

    def add_edge(self, a: int, b: int) -> None:
        self.edges[a].append(b)
        self.edges[b].append(a)

    def bfs(self, start: int) -> List[int]:
        """Return the distance from start to every node, or -1 where none is reachable."""
        dist = [-1] * self.size
        dist[start] = 0
        queue = deque([start])
        while queue:
            node = queue.popleft()
            for nxt in self.edges[node]:
                if dist[nxt] == -1:
                    dist[nxt] = dist[node] + 1
                    queue.append(nxt)
        return dist


def dijkstra(adj: Dict[int, List[Tuple[int, int]]], source: int) -> Dict[int, int]:
    """Return the shortest distance from source to every reachable node."""
    best = {source: 0}
    heap = [(0, source)]
    while heap:
        d, node = heapq.heappop(heap)
        if d > best.get(node, math.inf):
            continue
        for nxt, weight in adj.get(node, []):
            nd = d + weight
            if nd < best.get(nxt, math.inf):
                best[nxt] = nd
                heapq.heappush(heap, (nd, nxt))
    return best


@lru_cache(maxsize=None)
def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def parse_line(line: str) -> Optional[List[int]]:
    """Return the integers on a line, or None if the line is blank."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    return [int(token) for token in line.split()]


def read_input(stream: Iterable[str]) -> List[List[int]]:
    rows = []
    for number, line in enumerate(stream, start=1):
        try:
            values = parse_line(line)
        except ValueError as error:
            print(f"error: line {number} is not a list of numbers: {line!r} ({error})", file=sys.stderr)
            sys.exit(1)
        if values is not None:
            rows.append(values)
    return rows


def words(text: str) -> Counter:
    """Count the words of a text, ignoring case and punctuation."""
    return Counter(re.findall(r"[a-z']+", text.lower()))


def chunks(items: Sequence[int], size: int) -> Iterator[Sequence[int]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


class Solver:
    def __init__(self, rows: List[List[int]]) -> None:
        self.rows = rows
        self.cache: Dict[Tuple[int, int], int] = {}

    def __repr__(self) -> str:
        return f"Solver(rows={len(self.rows)})"

    def best_path(self, i: int = 0, j: int = 0) -> int:
        """Return the largest sum on a path from the top of the triangle to its base."""
        if i == len(self.rows):
            return 0
        key = (i, j)
        if key not in self.cache:
            here = self.rows[i][j]
            self.cache[key] = here + max(self.best_path(i + 1, j), self.best_path(i + 1, j + 1))
        return self.cache[key]

    def solve(self) -> int:
        if not self.rows:
            return 0
        return self.best_path()


def main(argv: Optional[List[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("-h", "--help"):
        print("usage: main.py [FILE]")
        return 0
    if argv:
        with open(argv[0], encoding="utf-8") as handle:
            rows = read_input(handle)
    else:
        rows = read_input(sys.stdin)
    total = sum(sum(row) for row in rows)
    largest = max((max(row) for row in rows if row), default=0)
    pairs = list(itertools.combinations(range(len(rows)), 2))
    product = reduce(lambda a, b: a * b, (len(row) for row in rows), 1)
    counts = Counter(value for row in rows for value in row)
    common = ", ".join(f"{value}x{count}" for value, count in counts.most_common(3))
    data = {"total": total, "largest": largest, "pairs": len(pairs), "product": product}
    for key, value in sorted(data.items()):
        print(f"{key}: {value}")
    print(common)
    print(Solver(rows).solve())
    print(os.environ.get("DEBUG", "0") == "1" and "debug" or "", end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`,
  ],
  [
    'example.ts',
    `// A small program: read the input, solve the problem, print the answer. Every function takes plain values and
// returns plain values, so each can be tested on its own.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import process from 'node:process';

/** A point on the plane. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export class Grid<T> {
  private readonly cells: T[];

  constructor(
    readonly width: number,
    readonly height: number,
    fill: T,
  ) {
    this.cells = new Array<T>(width * height).fill(fill);
  }

  get(x: number, y: number): T | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.cells[y * this.width + x];
  }

  set(x: number, y: number, value: T): void {
    this.cells[y * this.width + x] = value;
  }

  *neighbours(x: number, y: number): Generator<Point> {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (this.get(nx, ny) !== undefined) yield { x: nx, y: ny };
    }
  }
}

/**
 * Returns the integers on each non-blank line of the input.
 * @param text - the whole input
 * @returns one array of numbers per line
 */
export function parseInput(text: string): number[][] {
  return text
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\\s+/).map(Number));
}

export function parseArgs(argv: readonly string[]): Map<string, string | boolean> {
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=', 2);
      options.set(key!, value ?? true);
    } else {
      options.set('file', arg);
    }
  }
  return options;
}

function shortestPath(adj: Map<number, Array<[number, number]>>, source: number): Map<number, number> {
  const dist = new Map<number, number>([[source, 0]]);
  const queue: Array<[number, number]> = [[0, source]];
  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, node] = queue.shift()!;
    if (d > (dist.get(node) ?? Infinity)) continue;
    for (const [next, weight] of adj.get(node) ?? []) {
      const nd = d + weight;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        queue.push([nd, next]);
      }
    }
  }
  return dist;
}

const memo = new Map<number, bigint>();
function fib(n: number): bigint {
  if (n < 2) return BigInt(n);
  const known = memo.get(n);
  if (known !== undefined) return known;
  const value = fib(n - 1) + fib(n - 2);
  memo.set(n, value);
  return value;
}

export async function solve(rows: number[][]): Promise<Result<number>> {
  if (rows.length === 0) return { ok: false, error: 'the input is empty' };
  let total = 0;
  for (const row of rows) {
    for (const value of row) {
      if (!Number.isFinite(value)) return { ok: false, error: \`not a number: \${value}\` };
      total += value;
    }
  }
  const largest = Math.max(...rows.flat());
  const counts: Record<string, number> = {};
  for (const value of rows.flat()) counts[value] = (counts[value] ?? 0) + 1;
  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  console.error(\`largest \${largest}, most common \${sorted[0]?.[0] ?? 'none'}\`);
  return { ok: true, value: total };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const file = options.get('file');
  const text = typeof file === 'string' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const rows = parseInput(text);
  solve(rows)
    .then((result) => {
      if (!result.ok) {
        console.error(\`error: \${result.error}\`);
        process.exitCode = 1;
        return;
      }
      const lines = [String(result.value), fib(rows.length).toString()];
      const out = options.get('out');
      if (typeof out === 'string') {
        if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, lines.join('\\n') + '\\n');
      } else {
        process.stdout.write(lines.join('\\n') + '\\n');
      }
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

const INPUT = process.env.INPUT_DIR ?? '/input';
for (const name of existsSync(INPUT) ? readdirSync(INPUT).sort() : []) {
  const path = resolve(join(INPUT, name));
  console.log(basename(path), JSON.stringify(parseInput(readFileSync(path, 'utf8'))));
}

main();
`,
  ],
];
