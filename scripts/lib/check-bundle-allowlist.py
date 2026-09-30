#!/usr/bin/env python3
"""Refuse to ship anything the allowlist does not name.

    check-bundle-allowlist.py <staged-root> <allowlist>

This replaced a blocklist that grepped a staged bundle for four literal prompt
strings. A blocklist only catches what somebody thought of on the day it was
written, and that one was not wrong so much as narrow: the prompts really were
absent, and meanwhile thirty-two test files, a book transcriber, a phone
transfer script and the entire upgrade desktop were going out to customers with
nobody noticing. An allowlist makes every addition to a customer artifact a
deliberate line in a file somebody has to write.

Patterns are matched against paths relative to the staged root. `*` matches
within one path segment and `**` matches across segments, so `app/backend/*.js`
means the backend's own files rather than everything beneath it. A pattern
ending in `/` allows an empty directory and nothing inside it, which is how a
runtime directory is allowed through without allowing somebody's upload.
"""

import fnmatch
import os
import sys


def load(path):
    patterns = []
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.split('#', 1)[0].strip()
            if line:
                patterns.append(line)
    if not patterns:
        raise SystemExit(f'{path} lists nothing, so nothing could ship')
    return patterns


def allowed(rel, is_dir, patterns):
    for pattern in patterns:
        if pattern.endswith('/'):
            if is_dir and rel + '/' == pattern:
                return True
            continue
        if '**' in pattern:
            # `a/**/b` has to mean "b anywhere under a", including directly
            # under it. Only expanding `**` to `*` demanded an intervening
            # directory, so `provisioning/**/*.js` matched nothing at the top of
            # provisioning and the whole directory read as unlisted.
            candidates = {pattern.replace('/**/', '/'), pattern.replace('**', '*')}
            if any(fnmatch.fnmatchcase(rel, candidate) for candidate in candidates):
                return True
        elif fnmatch.fnmatchcase(rel, pattern) and rel.count('/') == pattern.count('/'):
            return True
    return False


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: check-bundle-allowlist.py <staged-root> <allowlist>')
    root, allowlist = sys.argv[1], sys.argv[2]
    patterns = load(allowlist)

    unlisted = []
    for base, dirs, files in os.walk(os.path.join(root, 'app')):
        for name in files:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root)
            if not allowed(rel, False, patterns):
                unlisted.append(rel)
        for name in dirs:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root)
            # An empty directory is only here because something needs it at
            # runtime, so it is judged on its own. A directory with contents is
            # judged by its contents.
            if not os.listdir(full) and not allowed(rel, True, patterns):
                unlisted.append(rel + '/')

    if unlisted:
        print('These are staged for the customer bundle and the allowlist does not name them:', file=sys.stderr)
        for rel in sorted(unlisted):
            print(f'  {rel}', file=sys.stderr)
        print('', file=sys.stderr)
        print('Add each one to the allowlist deliberately, or leave it out of the bundle.', file=sys.stderr)
        print('A missing file is a broken install somebody notices. An extra file is a leak nobody does.', file=sys.stderr)
        return 1
    print(f'Bundle allowlist: every staged file is named by {os.path.basename(allowlist)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
