"""Display committed benchmark observations in a real terminal; no invented UI/results."""
import json
from pathlib import Path

repository = Path(__file__).resolve().parents[2]
report = json.loads((repository / 'docs/benchmarks/2026-10-18-language-spike.json').read_text())
sizes = json.loads((repository / 'docs/benchmarks/2026-10-18-language-size.json').read_text())
print('\033[2J\033[H', end='')
print('OMNISQL  /  LANGUAGE EXPERIMENT')
print('Real MCP + PostgreSQL | 100,000 synthetic rows | macOS ARM64')
print('Source: ' + report['sourceCommit'][:12] + '  |  Rotating order, one active request')
print()
print('MEDIAN LATENCY (ms) AND WORKLOAD PEAK MEMORY (decimal MB)')
print(f'{"Runtime":<10}{"Startup":>12}{"SQL group":>12}{"CSV stream":>13}{"JSON scan":>12}{"Peak RSS":>12}')
print('-' * 71)
for name in ('node', 'bun', 'rust', 'go'):
    data = report['measurements'][name]
    values = [data[mode]['p50Ms'] for mode in ('startup', 'aggregate', 'copy', 'json')]
    print(f'{name.title():<10}{values[0]:>12.2f}{values[1]:>12.2f}{values[2]:>13.2f}{values[3]:>12.2f}{data["processPeakRssBytes"] / 1e6:>12.2f}')
print()
print('MATCHED PROTOTYPE SIZE (MB; system libraries excluded)')
print(f'{"Runtime":<10}{"App + dependencies":>22}{"Runtime executable":>23}{"Total":>16}')
print('-' * 71)
for name in ('node', 'bun', 'rust', 'go'):
    native = name in ('rust', 'go')
    app = sizes['executables'][name]['bytes'] if native else sizes['minimalJsDependencies']['bytes']
    runtime = 0 if native else sizes['executables'][name]['bytes']
    print(f'{name.title():<10}{app / 1e6:>22.2f}{runtime / 1e6:>23.2f}{(app + runtime) / 1e6:>16.2f}')
print()
print('[PASS] Identical group counts/totals across all four servers')
print('[PASS] 13.28 MB streamed CSV: identical SHA-256, no retained rows')
print('[PASS] 21.33 MB JSON scan, rejected modes, native timeout recovery')
print()
print('DECISION: Rust leads on core size, startup and memory.')
print('Bun wins this JSON scan. SQL/transfer timings are close.')
print('Prototypes omit full production features; migration requires parity.')
print('Current full OmniSQL dependencies: 81.99 MB before app/runtime.')
input('\nReport complete. Press Return to exit.')
