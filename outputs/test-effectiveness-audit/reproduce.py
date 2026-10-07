#!/usr/bin/env python3
"""Reproduce audit mutations in a temporary copy; never edit production files.

Usage: python3 outputs/test-effectiveness-audit/reproduce.py
Requires installed web/node_modules and the project's Go toolchain.
"""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(tempfile.mkdtemp(prefix="go-chamber-test-effectiveness-"))
WEB = OUT / "web"
WEB.mkdir()
for name in ("src", "public"):
    shutil.copytree(ROOT / "web" / name, WEB / name)
for name in ("package.json", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"):
    shutil.copy2(ROOT / "web" / name, WEB / name)
(WEB / "node_modules").symlink_to(ROOT / "web/node_modules", target_is_directory=True)
results = {}


def run(name, cmd, cwd):
    with (OUT / f"{name}.log").open("w") as log:
        result = subprocess.run(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=300)
    results[name] = result.returncode
    print(f"{name}: exit {result.returncode}", flush=True)


def replace(path, old, new):
    source = path.read_text()
    assert source.count(old) == 1, (path, old)
    path.write_text(source.replace(old, new))


vitest = ["node", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1"]
selected = ["src/lib/api.test.ts", "src/lib/seen.test.ts", "src/lib/transport.test.ts"]
run("web-baseline", vitest + selected, WEB)
replace(WEB / "src/lib/api.ts", "/${encodeURIComponent(id)}/interrupt`", "/${encodeURIComponent(id)}/WRONG-ENDPOINT`")
replace(WEB / "src/lib/transport.ts", "return fallback", 'throw new Error("audit: fallback removed")')
replace(WEB / "src/lib/seen.ts", "  } catch {\n    return null", '  } catch {\n    throw new Error("audit: load fallback removed")')
replace(WEB / "src/lib/seen.ts", "// Storage may be blocked; the mark is optional.", 'throw new Error("audit: save fallback removed")')
run("web-mutants", vitest + selected, WEB)

oracle = WEB / "src/lib/audit-storage-oracle.test.ts"
oracle.write_text('''import { afterEach, expect, it, vi } from 'vitest'
import { loadSeen, saveSeen } from './seen'
import { rtcEnabled, setRTCEnabled } from './transport'
afterEach(() => vi.restoreAllMocks())
it('loadSeen survives actual storage failure', () => {
 vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
 expect(() => loadSeen('s')).not.toThrow()
})
it('saveSeen survives actual storage failure', () => {
 vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
 expect(() => saveSeen('s', 'i')).not.toThrow()
})
it('rtcEnabled keeps choice on actual storage failure', () => {
 vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
 vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
 setRTCEnabled(false)
 expect(rtcEnabled()).toBe(false)
})
''')
run("storage-oracle-mutants", vitest + [str(oracle)], WEB)
for name in ("seen.ts", "transport.ts"):
    shutil.copy2(ROOT / "web/src/lib" / name, WEB / "src/lib" / name)
run("storage-oracle-baseline", vitest + [str(oracle)], WEB)

source = ROOT / "internal/adapters/codex/map.go"
mutant = OUT / "codex-map.go"
shutil.copy2(source, mutant)
replace(mutant, "title = p.Command", 'title = "Run command"')
replace(mutant, '"input": map[string]any{"command": p.Command}})', '"input": map[string]any{"command": ""}})')
overlay = OUT / "overlay.json"
overlay.write_text(json.dumps({"Replace": {str(source): str(mutant)}}))
run("codex-mutant", ["go", "test", f"-overlay={overlay}", "./internal/adapters/codex", "-count=1", "-timeout=120s"], ROOT)
(OUT / "results.json").write_text(json.dumps(results, indent=2) + "\n")
print(f"Logs and copies: {OUT}")
expected = {"web-baseline": 0, "web-mutants": 0, "storage-oracle-mutants": 1, "storage-oracle-baseline": 0, "codex-mutant": 0}
raise SystemExit(0 if results == expected else 1)
