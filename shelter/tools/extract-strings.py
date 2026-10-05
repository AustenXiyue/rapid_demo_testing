# 从源码里提取所有含中文的字符串字面量（简单 JS 词法：区分字符串、注释、正则）
import re, sys, json
HAN = re.compile(r'[一-鿿]')

def unescape(s):
    out = []; i = 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i+1]
            if n == 'n': out.append('\n'); i += 2; continue
            if n == 't': out.append('\t'); i += 2; continue
            if n == 'u': out.append(chr(int(s[i+2:i+6], 16))); i += 6; continue
            out.append(n); i += 2; continue
        out.append(c); i += 1
    return ''.join(out)

def literals(src):
    i = 0; n = len(src); res = []; prev = ''
    while i < n:
        c = src[i]
        if c == '/' and src[i+1:i+2] == '/':
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and src[i+1:i+2] == '*':
            j = src.find('*/', i + 2); i = n if j < 0 else j + 2; continue
        if c in '\'"`':
            q = c; j = i + 1; buf = []
            while j < n and src[j] != q:
                if src[j] == '\\': buf.append(src[j:j+2]); j += 2; continue
                buf.append(src[j]); j += 1
            res.append(unescape(''.join(buf))); i = j + 1; prev = 'x'; continue
        if c == '/' and prev in ('', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return'):
            j = i + 1; inclass = False
            while j < n:
                if src[j] == '\\': j += 2; continue
                if src[j] == '[': inclass = True
                elif src[j] == ']': inclass = False
                elif src[j] == '/' and not inclass: break
                elif src[j] == '\n': break
                j += 1
            i = j + 1; prev = 'x'; continue
        if not c.isspace():
            if c.isalnum() or c in '_$':
                m = re.match(r'[\w$]+', src[i:]); w = m.group(0)
                prev = 'return' if w in ('return', 'typeof', 'case') else 'x'; i += len(w); continue
            prev = c
        i += 1
    return res

seen = {}
for f in sys.argv[1:]:
    for lit in literals(open(f, encoding='utf8').read()):
        if HAN.search(lit) and lit not in seen: seen[lit] = f
json.dump(seen, sys.stdout, ensure_ascii=False, indent=0)
