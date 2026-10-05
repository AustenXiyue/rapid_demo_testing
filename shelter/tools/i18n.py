# 英文词典维护工具（不部署）。在 shelter/ 下运行：
#   python3 tools/i18n.py missing                          列出所有还没有译文的中文字面量（改了界面文字后先跑这个）
#   python3 tools/i18n.py dump <源文件> <编号起点> <条数>   列出某个源文件里还没翻译的字面量（带编号）
#   python3 tools/i18n.py merge <tsv> <编号译文文件>       把「编号<TAB>English」合并进对应词典
# 译文写「~」表示交给 src/shared/i18n.js 的固定句式处理（如「第 N 天」、量词）。
import json, sys, os, subprocess
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = ['src/shared/core.js', 'src/shared/ui.js', 'src/host/host.js', 'src/player/player.js']
TSV = {'src/shared/core.js': 'core.tsv', 'src/shared/ui.js': 'ui.tsv', 'src/host/host.js': 'host.tsv', 'src/player/player.js': 'player.tsv'}
DIR = os.path.join(HERE, 'src/shared/i18n')

def esc(s): return s.replace('\\', '\\\\').replace('\n', '\\n').replace('\t', '\\t')
def unesc(s):
    out = []; i = 0
    while i < len(s):
        if s[i] == '\\' and i + 1 < len(s):
            out.append({'n': '\n', 't': '\t', '\\': '\\'}.get(s[i+1], s[i+1])); i += 2
        else: out.append(s[i]); i += 1
    return ''.join(out)

def literals():
    out = subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'extract-strings.py')] + [os.path.join(HERE, f) for f in SRC], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    return [(k, os.path.relpath(v, HERE)) for k, v in d.items()]

def load_all():
    dic = {}
    for name in sorted(os.listdir(DIR)):
        if not name.endswith('.tsv'): continue
        for line in open(os.path.join(DIR, name), encoding='utf8').read().split('\n'):
            if not line.strip() or line.startswith('#'): continue
            zh, en = line.split('\t', 1)
            if en: dic[unesc(zh)] = unesc(en)  # ~ 也算已处理
    return dic

cmd = sys.argv[1]
if cmd == 'dump':
    f, start, count = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    done = load_all()
    rows = [k for k, src in literals() if src == f and k not in done]
    for i, k in enumerate(rows[start:start + count], start):
        print(f'{i}\t{esc(k)}')
    print(f'# {len(rows)} untranslated in {f}', file=sys.stderr)
elif cmd == 'merge':
    tsv, numbered = sys.argv[2], sys.argv[3]
    f = [src for src, name in TSV.items() if name == tsv][0]
    done = load_all()
    rows = [k for k, src in literals() if src == f and k not in done]
    path = os.path.join(DIR, tsv)
    lines = []
    for line in open(numbered, encoding='utf8').read().split('\n'):
        if not line.strip(): continue
        n, en = line.split('\t', 1)
        lines.append(f'{esc(rows[int(n)])}\t{en}')
    with open(path, 'a', encoding='utf8') as fh:
        if os.path.getsize(path) if os.path.exists(path) else False: pass
        fh.write('\n'.join(lines) + '\n')
    print(f'merged {len(lines)} into {tsv}')
elif cmd == 'missing':
    done = load_all()
    miss = [(k, s) for k, s in literals() if k not in done]
    for k, s in miss: print(f'{s}\t{esc(k)}')
    print(f'# {len(miss)} missing', file=sys.stderr)
